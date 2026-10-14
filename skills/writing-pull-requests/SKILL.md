---
name: writing-pull-requests
description: Use when writing or updating a pull request description, opening a PR, preparing a branch for review, or asked for a PR body, PR title, or changelog for a change.
---

# Writing pull requests

A template section you cannot fill with a fact is noise for the reviewer. Keep only the sections this repository and this diff actually support.

`scripts/pr.py` does the mechanical half. You do the judgement half — it cannot know whether you ran the tests.

```bash
python3 scripts/pr.py probe --template <name> > facts.json   # what applies, with evidence
# you fill in the content and resolve every "undetermined"
python3 scripts/pr.py build facts.json > body.md
python3 scripts/pr.py check body.md --template <name> --title "<title>"
```

Run it from the repository root. Templates in `references/` are the source of truth for all three steps — edit a template and the script follows.

## 1. Read the change

```bash
git diff "$(git merge-base HEAD origin/main)"..HEAD
```

Use the actual default branch if it is not `main`. You cannot deduce applicability from the ticket title, only from the diff.

## 2. Pick one template

One per PR — the dominant change, not the union.

| The change | Template |
|---|---|
| Removes or alters an existing contract that callers depend on | `breaking-change` |
| Corrects behaviour that was wrong | `bugfix` |
| Adds behaviour that did not exist | `feature` |
| Same behaviour, different implementation | `improvement` |
| No source changes: dependencies, CI, build config, tooling, deployment manifests | `chore` |
| Only tests, comments or docs | `docs-or-tests` |

Breaking change wins over everything. A feature plus incidental cleanup is a feature with an out-of-scope note.

`references/section-guidance.md` says what belongs in each section.

## 3. Run probe, then resolve every `undetermined`

`probe` emits a verdict per section with the evidence behind it. Three outcomes:

- **`include` / `omit`** — decided from the diff. Read the evidence; override it if it is wrong, and say so.
- **`undetermined`** — the script cannot know. You must decide. These are `local`, `remote`, `out-of-scope` and `risks`.

Pass `--template` so verdicts are scoped to the sections that template actually has. `build` refuses to run while a section has neither content nor an explicit `null`, so nothing gets silently dropped.

**A verdict marked `"expressed_as": "checklist"` has no section in this template.** It is a checklist line and nothing more — `out-of-scope` is a section only in `feature`; every other template carries it as the Dangerzone tick. Tick the line. Do not relocate the material into Fix, Risks, or the summary: a reviewer scanning for out-of-scope work looks at the checklist, and prose buried elsewhere does not reach them. `build` exits non-zero rather than place content the template has no home for.

| Section | Decided by |
|---|---|
| Metrics / Grafana | seam probe + diff intersection (see below) |
| Database indices | diff touches a migration, schema, column or query |
| Deployment plan | diff carries an ordering constraint: migration, config or secret, feature flag, manifest, API contract |
| Monitoring plan | there is a deployment plan, or runtime behaviour changes visibly |
| Risks & impact | **you** — customers, money, data, downstream services |
| Local QA | **you** — did you actually run it? Write the steps you ran and what you saw |
| Remote QA | **you** — was it actually deployed? Rename the heading to that environment |
| Out of scope | **you** — does the diff contain work the ticket does not cover? |

Ambiguous is not a licence to guess. Ask. A fabricated deployment plan is worse than no section.

### The metrics seam

`probe` looks for metrics by shape, cheapest first, and stops at the first hit: **name** (a `metrics`/`telemetry`/`observability` package), **vocabulary** (`Counter`, `Gauge`, `Histogram`, `Observe`, `Increment`), **what consumes it** (dashboards, alert rules, scrape config, a `/metrics` route), then **vendor names last**.

Vendor last is the point. A hand-rolled emitter, or a thin wrapper over a vendor library, shows the vendor's name in exactly one file and hides it from every call site — a `prometheus` grep would report no metrics in a repo full of them. `probe` reports which stage found the seam so you can judge the answer.

A seam plus a diff that merely *runs through* instrumented code is not a metrics change. Adding, removing, renaming or relabelling a series is. Renames earn an explicit callout: every panel and alert on the old series goes silently blank.

## 4. Write it in the reader's language

Write the prose in **ASD-STE100 Simplified Technical English**: active voice, simple tenses, one idea per sentence, and one word per meaning. Never swap in a synonym for variety — a reviewer reading two words assumes two things.

Take the nouns from the repository, not from your own head. Read `CONTEXT.md` for the domain's ubiquitous language before you write, and follow `CONTEXT-MAP.md` to the right one if there is more than one. `probe` reports which of these the repo has. If your change introduces a term `CONTEXT.md` does not carry, say so in the PR — that is a domain change, and the reviewer should see it.

`references/section-guidance.md` has the full rule set. `check` enforces the sentence limits.

## 5. Tick only what is true

The checklist is an assertion by the author. `build` ticks exactly what you list in `checked` and deletes conditional lines whose section you dropped; it will not invent one.

- Tick a box only when you verified the thing. "Added automated tests" means tests exist in this diff.
- Leave a mandatory box unticked with a one-line reason rather than ticking it falsely.
- The Dangerzone lines exist for the reviewer. Tick them when true — they are not an admission of wrongdoing.

## 6. Check before you post

`check` reads a finished body and exits non-zero on leftover scaffolding, unreplaced placeholders, empty sections, a ticked box whose section is absent, an over-long sentence, and a title whose type does not match the template. Run it on hand-edited bodies too, including ones you did not build with this script.

## Red flags

| Thought | Reality |
|---|---|
| "The repo probably has dashboards, I'll keep the Metrics section" | Run `probe`. An empty section the reviewer scrolls past costs them time. |
| "No `prometheus` import, so no metrics" | That finds direct vendor calls only. `probe` runs four stages for this reason. |
| "I'll write plausible manual test steps" | That section states you ran them. Run them or drop it. |
| "Every box ticked looks thorough" | An all-ticked checklist carries no information. Unticked with a reason does. |
| "`probe` said undetermined, I'll leave it out" | Undetermined means *you decide*, not *omit*. Decide it. |
| "This template has no section for it, I'll fold it into a nearby one" | No. Tick its checklist line if it has one, otherwise drop it. Relocating material hides it from the reviewer who was looking for it. |
| "A synonym here reads better than repeating the term" | It reads as a second thing. One word, one meaning — that is the whole point of STE. |
| "I'll call it what I call it in my head" | Use the repo's noun. A reviewer matching your prose to the code should not have to translate. |
| "Feature and a refactor, I'll merge two templates" | Pick the dominant one. Mixed templates destroy the checklist's meaning. |
