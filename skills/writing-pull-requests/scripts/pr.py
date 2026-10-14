#!/usr/bin/env python3
"""Probe, build and check pull request descriptions.

    pr.py probe                     observable predicates for this branch, as JSON
    pr.py build facts.json          assemble the body from a template + facts
    pr.py check [body.md]           validate a finished body

The templates in ../references/*.md are the source of truth. This script reads
them; it does not carry its own copy of the structure. Two conventions in those
templates are load-bearing:

    ### Heading <!-- if relevant -->     the section is conditional
    <!-- anything -->                    a slot to fill, or scaffolding to strip

The one thing markdown cannot express is which checklist line depends on which
section. That is CHECKLIST_DEPENDS_ON below.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

REFERENCES = Path(__file__).resolve().parent.parent / "references"

TICKET_RE = re.compile(r"\b([A-Z][A-Z0-9]{1,9}-\d+)\b")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
CHECKBOX_RE = re.compile(r"^- \[([ xX])\]\s+(.*)$")
CONDITIONAL_MARKER = "<!-- if relevant -->"

# Heading slugs vary across templates for the same concept.
ALIASES = {
    "manual-tests-qa": "qa",
    "manual-regression-tests-qa": "qa",
    "manual-replication-steps-fix-tests-qa": "qa",
    "out-of-scope-changes-included": "out-of-scope",
    "flows-functionality-impacted": "flows",
    "pre-review-request-checklist": "checklist",
    "analysis-plans": "analysis",
    "risks": "risks",
    "metrics": "metrics",
}

# A conditional checklist line is only honest if its section survived.
# key -> substrings identifying the checklist lines that depend on it.
CHECKLIST_DEPENDS_ON = {
    "deployment": ["included deployment plan"],
    "monitoring": ["included monitoring plan"],
    "metrics": ["list of metrics"],
    "local": ["manually tested"],
    "remote": ["described how to manually test"],
    "out-of-scope": ["clearly described out of scope"],
    "database": ["database indices"],
}

# Sections no probe can decide: they assert something the author did.
AUTHOR_ASSERTS = {"local", "remote", "out-of-scope"}


def slug(text: str) -> str:
    text = COMMENT_RE.sub("", text)
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return ALIASES.get(text, text)


# --------------------------------------------------------------------------
# template parsing
# --------------------------------------------------------------------------


@dataclass
class Node:
    level: int
    heading: str | None  # raw heading line, None for the preamble
    key: str
    conditional: bool
    body: list[str] = field(default_factory=list)
    children: list["Node"] = field(default_factory=list)
    dropped: bool = False

    def walk(self):
        yield self
        for child in self.children:
            yield from child.walk()

    def find(self, key: str) -> "Node | None":
        for node in self.walk():
            if node.key == key:
                return node
        return None


def parse(text: str) -> Node:
    root = Node(level=0, heading=None, key="", conditional=False)
    stack = [root]
    for line in text.splitlines():
        match = HEADING_RE.match(line)
        if not match:
            stack[-1].body.append(line)
            continue
        level = len(match.group(1))
        node = Node(
            level=level,
            heading=line,
            key=slug(match.group(2)),
            conditional=CONDITIONAL_MARKER in line,
        )
        while stack[-1].level >= level:
            stack.pop()
        stack[-1].children.append(node)
        stack.append(node)
    return root


def render(node: Node) -> list[str]:
    if node.dropped:
        return []
    out: list[str] = []
    if node.heading is not None:
        out.append(COMMENT_RE.sub("", node.heading).rstrip())
    out.extend(node.body)
    for child in node.children:
        out.extend(render(child))
    return out


def load_template(name: str) -> tuple[str, Node]:
    path = REFERENCES / f"{name}.md"
    if not path.exists():
        available = sorted(p.stem for p in REFERENCES.glob("*.md") if p.stem != "section-guidance")
        sys.exit(f"no template {name!r}; available: {', '.join(available)}")
    text = path.read_text()
    tree = parse(text)
    # Most templates hang the summary slot off the title heading rather than a
    # "### Summary" of its own. Key it by role, not by the title's wording.
    for node in tree.children:
        if node.heading and COMMENT_RE.search("\n".join(node.body)):
            node.key = "summary"
        break
    return text, tree


# --------------------------------------------------------------------------
# probe
# --------------------------------------------------------------------------


def git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args], capture_output=True, text=True, check=False
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def resolve_base(explicit: str | None) -> str:
    """An unresolvable base yields an empty diff, and an empty diff makes every
    section look inapplicable. Fail loudly instead of guessing."""
    candidates = [explicit] if explicit else []
    if not explicit:
        head = git("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
        if head:
            candidates.append(head.replace("refs/remotes/", ""))
        for name in ("main", "master", "develop", "trunk"):
            candidates += [f"origin/{name}", name]
    for ref in candidates:
        if ref and git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"):
            base = git("merge-base", "HEAD", ref)
            if base and base != git("rev-parse", "HEAD"):
                return base
    sys.exit(
        "cannot resolve a base to diff against"
        + (f" ({explicit!r} does not resolve)" if explicit else "")
        + "\npass --base <ref> explicitly; without a diff every section looks "
        "inapplicable and the probe would be worthless."
    )


def repo_files() -> list[str]:
    return git("ls-files").splitlines()


def diff_files(base: str) -> list[str]:
    return git("diff", "--name-only", f"{base}...HEAD").splitlines()


def diff_text(base: str) -> str:
    return git("diff", f"{base}...HEAD")


def find_metrics_seam(files: list[str], diff: str) -> dict:
    """Four probes, cheapest first. Vendor names are LAST: a hand-rolled
    emitter, or a wrapper round a vendor library, hides the vendor name from
    every call site but one."""
    probes = [
        (
            "name",
            r"(^|/)(metrics|telemetry|instrumentation|observability|stats|monitoring)([./_-]|$)",
            "path",
        ),
        (
            "vocabulary",
            r"\b(Counter|Gauge|Histogram|Summary|Timer|Observe|Emit|Increment)\w*",
            "content",
        ),
        (
            "consumer",
            r"(dashboard|alert|scrape|exporter|servicemonitor|podmonitor|/metrics)",
            "both",
        ),
        (
            "vendor",
            r"(prometheus|promauto|statsd|opentelemetry|otel|datadog|micrometer|cloudwatch)",
            "both",
        ),
    ]
    for label, pattern, where in probes:
        regex = re.compile(pattern, re.IGNORECASE)
        hits = [f for f in files if regex.search(f)] if where in ("path", "both") else []
        if not hits and where in ("content", "both"):
            hits = grep_files(files, regex)
        if hits:
            touched = [f for f in diff_files_cache if regex.search(f)]
            if not touched:
                touched = [
                    line
                    for line in diff.splitlines()
                    if line.startswith(("+", "-"))
                    and not line.startswith(("+++", "---"))
                    and regex.search(line)
                ]
            return {
                "seam": {"found_by": label, "examples": hits[:5]},
                "diff_touches": bool(touched),
                "evidence": touched[:5],
            }
    return {"seam": None, "diff_touches": False, "evidence": []}


diff_files_cache: list[str] = []


def grep_files(files: list[str], regex: re.Pattern, limit: int = 5) -> list[str]:
    hits = []
    for name in files:
        path = Path(name)
        if not path.is_file() or path.stat().st_size > 512_000:
            continue
        try:
            if regex.search(path.read_text(errors="ignore")):
                hits.append(name)
        except OSError:
            continue
        if len(hits) >= limit:
            break
    return hits


def verdict(include: bool | None, evidence: list[str], note: str = "") -> dict:
    state = "undetermined" if include is None else ("include" if include else "omit")
    out = {"verdict": state, "evidence": evidence[:5]}
    if note:
        out["note"] = note
    return out


def scope_to_template(sections: dict, template: str) -> dict:
    """A verdict for a section the template does not have is a trap: it invites
    the author to smuggle the material into some other section. Say where it
    actually belongs instead."""
    text, tree = load_template(template)
    body = text.lower()
    headings = {node.key for node in tree.walk() if node.heading is not None}
    scoped = {}
    for key, value in sections.items():
        if key in headings:
            scoped[key] = value
        elif key in CHECKLIST_DEPENDS_ON and any(
            n in body for n in CHECKLIST_DEPENDS_ON[key]
        ):
            value["expressed_as"] = "checklist"
            value["note"] = (
                f"the {template} template has no {key!r} section; "
                "this is a checklist line only. Do not move the material into "
                "another section."
            )
            scoped[key] = value
    return scoped


def cmd_probe(args) -> int:
    global diff_files_cache
    base = resolve_base(args.base)
    files = repo_files()
    diff_files_cache = diff_files(base)
    diff = diff_text(base)
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    subjects = git("log", "--format=%s", f"{base}..HEAD").splitlines()

    ticket = None
    for source, text in (("branch", branch), ("commits", " ".join(subjects))):
        match = TICKET_RE.search(text)
        if match:
            ticket = {"key": match.group(1), "source": source}
            break

    db_re = re.compile(
        r"(migrat|schema|\.sql$|alembic|liquibase|flyway|goose|knex|prisma)", re.I
    )
    db_hits = [f for f in diff_files_cache if db_re.search(f)]
    if not db_hits:
        db_hits = [
            line
            for line in diff.splitlines()
            if line.startswith("+")
            and not line.startswith("+++")
            and re.search(r"\b(CREATE TABLE|ALTER TABLE|ADD COLUMN|CREATE INDEX)\b", line, re.I)
        ]

    order_re = re.compile(
        r"(migrat|\.env|secret|configmap|helm|chart|terraform|k8s|kubernetes|"
        r"deployment\.ya?ml|feature.?flag|\.proto$|openapi|schema\.graphql)",
        re.I,
    )
    order_hits = [f for f in diff_files_cache if order_re.search(f)]

    metrics = find_metrics_seam(files, diff)
    metrics_verdict = verdict(
        metrics["seam"] is not None and metrics["diff_touches"],
        metrics["evidence"],
        note=(
            f"seam found by {metrics['seam']['found_by']} probe"
            if metrics["seam"]
            else "no metrics seam in this repo"
        ),
    )

    sections = {
        "metrics": metrics_verdict,
        "database": verdict(bool(db_hits), db_hits),
        "deployment": verdict(
            bool(order_hits), order_hits, "ordering constraint; confirm it is real"
        ),
        "monitoring": verdict(
            None if order_hits else False,
            order_hits,
            "include if there is a deployment plan or runtime behaviour changes",
        ),
        "risks": verdict(None, [], "judgement: customers, money, data, downstream"),
    }
    for key in sorted(AUTHOR_ASSERTS):
        sections[key] = verdict(None, [], "only you know this; the script cannot")

    if args.template:
        sections = scope_to_template(sections, args.template)

    context_files = [f for f in files if Path(f).name in ("CONTEXT.md", "CONTEXT-MAP.md")]

    print(
        json.dumps(
            {
                "template": args.template,
                "context_files": context_files,
                "base": base,
                "branch": branch,
                "ticket": ticket,
                "files_changed": len(diff_files_cache),
                "commits": subjects,
                "sections": sections,
            },
            indent=2,
        )
    )
    return 0


# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------


def is_omitted(facts: dict, key: str) -> bool:
    """Omitted means an explicit null, or a probe verdict of "omit". A
    checklist-only section never carries content, so absent content is not
    the same thing as absent section."""
    value = facts.get("sections", {}).get(key)
    if value is None:
        return True
    if isinstance(value, dict):
        return value.get("verdict") == "omit"
    return False


def section_content(facts: dict, key: str):
    """Accept probe-shaped {verdict, content} or a bare string/None."""
    value = facts.get("sections", {}).get(key)
    if isinstance(value, dict):
        if value.get("verdict") == "omit":
            return None
        return value.get("content")
    return value


def cmd_build(args) -> int:
    raw = sys.stdin.read() if args.facts == "-" else Path(args.facts).read_text()
    facts = json.loads(raw)
    template = facts.get("template")
    if not template:
        sys.exit("facts must name a template")
    _, tree = load_template(template)

    provided = facts.get("sections", {})
    headings = {n.key for n in tree.walk() if n.heading is not None}
    fillable = {
        n.key
        for n in tree.walk()
        if n.heading is not None and COMMENT_RE.search("\n".join(n.body))
    } | set(CHECKLIST_DEPENDS_ON)
    unknown = sorted(set(provided) - (headings | set(CHECKLIST_DEPENDS_ON)))
    if unknown:
        sys.exit(
            f"the {template} template has nowhere to put: {', '.join(unknown)}\n"
            f"it accepts: {', '.join(sorted(fillable))}\n"
            "do not relocate the material into another section - drop it, or "
            "pick a template that has one."
        )
    missing = []
    for node in list(tree.walk()):
        if node.heading is None or node.key in ("checklist", "conditional", "mandatory", "dangerzone"):
            continue
        content = section_content(facts, node.key)
        if node.key in provided and is_omitted(facts, node.key):
            node.dropped = True
            continue
        if content is None:
            if node.conditional:
                node.dropped = True
            elif COMMENT_RE.search("\n".join(node.body)):
                missing.append(node.key)
            continue
        literal = [
            line
            for line in COMMENT_RE.sub("", "\n".join(node.body)).splitlines()
            if line.strip()
        ]
        node.body = ["", str(content).strip(), "", *literal, ""]

    if missing and not args.allow_missing:
        sys.exit(
            "no content for required sections: "
            + ", ".join(missing)
            + "\n(pass --allow-missing to emit anyway)"
        )

    prune(tree)
    dropped = {n.key for n in tree.walk() if n.dropped}
    dropped |= {k for k in provided if is_omitted(facts, k)}
    lines = render(tree)
    lines = apply_checklist(lines, dropped, set(facts.get("checked", [])))
    ticket = facts.get("ticket")
    if isinstance(ticket, dict):  # straight from probe
        ticket = ticket.get("key")
    lines = apply_ticket(lines, ticket, facts.get("ticket_url"))
    body = COMMENT_RE.sub("", "\n".join(lines))
    body = re.sub(r"\n{3,}", "\n\n", body).strip() + "\n"
    print(body, end="")
    return 0


def apply_ticket(lines: list[str], key: str | None, url: str | None) -> list[str]:
    out = []
    for line in lines:
        if "<TICKET-ID>" not in line and "<ticket-url>" not in line:
            out.append(line)
            continue
        if not key:
            continue
        if not url:  # a tracker without ticket URLs gets the bare key, not an empty link
            line = line.replace("[<TICKET-ID>](<ticket-url>)", key)
        out.append(line.replace("<TICKET-ID>", key).replace("<ticket-url>", url or ""))
    return out


def prune(node: Node) -> bool:
    """Drop a heading whose children are all gone and whose own body is empty."""
    for child in node.children:
        prune(child)
    if node.heading is None or node.dropped:
        return node.dropped
    own = COMMENT_RE.sub("", "\n".join(node.body)).strip()
    if not own and node.children and all(c.dropped for c in node.children):
        node.dropped = True
    elif not own and not node.children and node.conditional:
        node.dropped = True
    return node.dropped


def apply_checklist(lines: list[str], dropped: set[str], checked: set[str]) -> list[str]:
    out = []
    for line in lines:
        match = CHECKBOX_RE.match(line)
        if not match:
            out.append(line)
            continue
        text = match.group(2)
        plain = text.replace("**", "").lower()
        orphan = any(
            any(needle in plain for needle in needles)
            for key, needles in CHECKLIST_DEPENDS_ON.items()
            if key in dropped
        )
        if orphan:
            continue
        tick = "x" if any(c.lower() in plain for c in checked) else " "
        out.append(f"- [{tick}] {text}")
    return out


# --------------------------------------------------------------------------
# check
# --------------------------------------------------------------------------


SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def long_sentences(lines: list[str]) -> list[tuple[int, str]]:
    """ASD-STE100: 25 words for descriptive text, 20 for a step. Code, tables
    and checklist lines are not prose, so they never reach this check."""
    found = []
    in_fence = False
    for i, line in enumerate(lines, 1):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        stripped = line.strip()
        if (
            in_fence
            or not stripped
            or stripped.startswith(("#", "|", ">", "    ", "\t"))
            or CHECKBOX_RE.match(stripped)
        ):
            continue
        is_step = bool(re.match(r"^([-*+]|\d+[.)])\s", stripped))
        limit = 20 if is_step else 25
        for sentence in SENTENCE_SPLIT_RE.split(stripped):
            words = [w for w in re.split(r"\s+", sentence) if w]
            if len(words) > limit:
                found.append(
                    (
                        i,
                        f"sentence runs {len(words)} words (limit {limit}): "
                        f"{' '.join(words[:8])}...",
                    )
                )
    return found


def cmd_check(args) -> int:
    text = sys.stdin.read() if not args.body else Path(args.body).read_text()
    if not text.strip():
        sys.exit("nothing to check: the body is empty")
    lines = text.splitlines()
    problems: list[tuple[int, str]] = []

    for i, line in enumerate(lines, 1):
        if "<!--" in line or "-->" in line:
            problems.append((i, f"unfilled scaffolding: {line.strip()[:60]}"))
        if re.search(r"<(ticket-id|TICKET-ID|ticket-url|context|summary)>", line):
            problems.append((i, f"unreplaced placeholder: {line.strip()[:60]}"))

    tree = parse(text)
    present = set()
    for node in tree.walk():
        if node.heading is None:
            continue
        present.add(node.key)
        own = COMMENT_RE.sub("", "\n".join(node.body)).strip()
        if not own and not node.children:
            index = lines.index(node.heading) + 1 if node.heading in lines else 0
            problems.append((index, f"empty section: {node.heading.strip()}"))

    # Some concerns are a checklist line and nothing else - no template gives
    # them a heading. Only complain about a key the template could have shown.
    if args.template:
        _, ref = load_template(args.template)
        sectionable = {n.key for n in ref.walk() if n.heading is not None}
    else:
        sectionable = set()
        for path in REFERENCES.glob("*.md"):
            if path.stem == "section-guidance":
                continue
            sectionable |= {
                n.key for n in parse(path.read_text()).walk() if n.heading is not None
            }

    for i, line in enumerate(lines, 1):
        match = CHECKBOX_RE.match(line)
        if not match or match.group(1) == " ":
            continue
        plain = match.group(2).replace("**", "").lower()
        for key, needles in CHECKLIST_DEPENDS_ON.items():
            if key in present or key not in sectionable:
                continue
            if not any(n in plain for n in needles):
                continue
            problems.append(
                (i, f"ticked box for absent section {key!r}: {match.group(2)[:50]}")
            )

    problems.extend(long_sentences(lines))

    if args.title:
        expected = {
            "feature": "feat",
            "bugfix": "fix",
            "improvement": "refactor",
            "chore": "chore",
            "docs-or-tests": "doc",
            "breaking-change": "BREAKING CHANGE",
        }
        if args.template and args.template in expected:
            want = expected[args.template]
            if want.lower() not in args.title.lower():
                problems.append(
                    (1, f"title type does not match {args.template} template (want {want!r})")
                )
        if args.require_ticket and not TICKET_RE.search(args.title):
            problems.append((1, "title carries no ticket key"))

    for line_no, message in sorted(problems):
        print(f"{args.body or 'stdin'}:{line_no}  {message}")
    if problems:
        print(f"{len(problems)} problem{'s' if len(problems) != 1 else ''}", file=sys.stderr)
        return 1
    return 0


# --------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("probe", help="observable predicates for this branch")
    p.add_argument("--base", help="base ref (default: origin/<default branch>)")
    p.add_argument("--template", help="scope verdicts to the sections this template has")
    p.set_defaults(func=cmd_probe)

    b = sub.add_parser("build", help="assemble a body from a template and facts")
    b.add_argument("facts", help="facts JSON file, or - for stdin")
    b.add_argument("--allow-missing", action="store_true")
    b.set_defaults(func=cmd_build)

    c = sub.add_parser("check", help="validate a finished body")
    c.add_argument("body", nargs="?", help="body file (default: stdin)")
    c.add_argument("--template", help="template the body was built from")
    c.add_argument("--title", help="proposed PR title")
    c.add_argument("--require-ticket", action="store_true")
    c.set_defaults(func=cmd_check)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
