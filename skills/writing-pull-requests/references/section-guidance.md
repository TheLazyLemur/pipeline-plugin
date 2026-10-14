# Section guidance

What belongs in each section of a PR template. Sections not present in your chosen template do not apply.

## How to write it

A PR description is technical writing for a reader who is in a hurry and does not share your context. Write it in **ASD-STE100 Simplified Technical English**:

- **One word, one meaning.** Pick a term for a thing and use that term every time. Do not reach for a synonym to vary the prose.
- **Active voice.** "The handler rejects the token", not "the token is rejected by the handler".
- **One idea per sentence.** Keep descriptive sentences to 25 words. Keep steps to 20.
- **Simple tenses.** Present, past, future. Avoid "has been", "will have been", "is being".
- **Keep the articles.** "Update the index", not "update index".
- **Three words maximum in a noun cluster.** "Session refresh handler timeout threshold" is five nouns stacked; break it up.
- **Say what is, not what is not.** "The endpoint returns 401" beats "the endpoint does not return a success".
- **Six sentences maximum per paragraph.**

`check` flags over-long sentences. The rest is on you.

## Use the repository's own words

Before you write, read `CONTEXT.md` for the domain's ubiquitous language. If the repo has more than one, follow `CONTEXT-MAP.md` to the one that covers the code you changed. `probe` reports whether these files exist.

Use those terms exactly. A reviewer who reads "the instruction" in the code and "the request" in your PR has to work out whether you mean the same thing. If your change introduces a term the context file does not have, say so — that is a domain change worth a reviewer's attention, and it may mean `CONTEXT.md` needs updating too.

## PR title

```
<ticket-id> - <type>[<context>]: <summary>
```

`<type>` matches the template: `feat`, `fix`, `refactor`, `chore`, `doc`/`test`, `BREAKING CHANGE`. `<context>` is the domain area touched, not the directory name. Summary is imperative and lower case.

```
ABC-123 - feat[session]: add refresh token rotation
```

No ticket key available → drop the prefix, keep the rest.

## Summary

Why the change exists and what a reviewer needs to know before reading the diff. Skip it when the title already says everything — a one-line restatement of the title is worse than nothing.

For a bugfix, the template splits this into **Bug** (observed behaviour, and what caused it) and **Fix** (what now happens instead).

For a breaking change, state what breaks, for whom, and what they must do. Name the affected clients and systems.

## Changelog

One conventional-commit line per meaningful change in the diff. Not one line per git commit — squash noise, split commits that did two things.

```
 * BREAKING CHANGE: remove the v1 lookup endpoint.
 * feat[session]: add refresh token rotation.
 * fix[session]: stop panicking when the token is absent.
 * refactor[session]: extract expiry checks into one place.
 * chore: pin the build image to a digest.
 * test[session]: add integration tests for the rotation flow.
 * doc: add quick start to README.
```

## Flows / functionality impacted (improvement template)

The behaviours a reviewer should regression-test. Be specific: name the entry points and the edge cases, not the subsystem. "Sign-in and sign-out, including the expired-token retry path" tells a reviewer where to look; "authentication" does not.

## Out of scope changes included

Only when the diff contains work the ticket does not cover. Two parts: why it was justifiable to include here, and what the changes are. If you cannot justify it, split the PR instead.

## Manual tests / QA

### Local

The steps you ran, in order, and the outcome you observed. Screenshots where the outcome is visual. Before/after for a bugfix.

This section asserts you ran them. Do not write steps you did not run.

### Remote

Rename the heading to the environment (`### Staging`, `### UAT`). Same content as local, plus links to logs, graphs or dashboards that show the outcome. Delete the section if the change has not been deployed anywhere.

## Risks & impact

What could go wrong, and who it lands on — customers, money, data integrity, downstream services. Include the blast radius and what limits it. "None" is a valid answer for a genuinely isolated change; say it rather than deleting the section when the template makes it mandatory.

## Deployment plan

Only for a change with an ordering constraint. State the ordered steps and what must be true before each one: migration before code, config or secret present first, feature flag default, consumer deployed before producer, staged rollout percentages, rollback step.

A change that deploys safely as a single unit has no plan. Delete the section.

## Monitoring plan

What you will watch after deploy, for how long, and what number or log line tells you to roll back. Name the dashboard, panel or query. "Watch for errors" is not a plan.

## Metrics / Grafana panels impacted

Only when the repo emits metrics and this diff touches them. List the metric names added, removed or relabelled, and the panels or alerts that read them. A renamed metric silently breaks every panel and alert built on the old name — call that out.

## Pre-review request checklist

An assertion by the author. Tick what you verified; leave the rest unticked with a one-line reason. Delete conditional lines whose section you deleted.
