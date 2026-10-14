<!-- PR title: <ticket-id> - refactor[<context>]: <summary> -->

# Improvement / Refactor

<!-- summary -->

### Changelog

<!-- changelog -->

[<TICKET-ID>](<ticket-url>)

### Flows / functionality impacted

<!-- list -->

# Manual regression tests / QA

### Local

<!--
 * Steps to manually regression test locally
 * Outcome
 * Screenshots etc
-->

### Remote <!-- if relevant --> <!-- rename! -->

<!--
 * Steps to manually regression test in this environment
 * Outcome
 * Screenshots, links etc
-->

# Analysis & Plans

### Risks <!-- if relevant -->

<!-- Risks & impact/s -->

### Deployment <!-- if relevant -->

<!-- Deployment plan -->

### Monitoring <!-- if relevant -->

<!-- Monitoring plan -->

### Metrics <!-- if relevant -->

<!-- Metrics / Grafana panels impacted -->

# Pre-review request checklist

### Mandatory

PR author **MUST** check all the following:

- [ ] I **HAVE** completed and cleaned up PR description.
- [ ] I **HAVE** listed impacted flows / functionality.
- [ ] I **HAVE** self-reviewed.
- [ ] I **HAVE** considered/described risks and impacts.
- [ ] I **HAVE** followed the team's PR, testing, commit, deployment and monitoring guidelines.

### Conditional

PR author **MAY** check the following (when applicable):

- [ ] I **HAVE** added/updated automated tests.
- [ ] I **HAVE** manually tested.
- [ ] I **HAVE** described how to manually test on relevant environments.
- [ ] I **HAVE** included deployment plan, I **WILL** follow it.
- [ ] I **HAVE** included monitoring plan, I **WILL** follow it, I **WILL** share the results in Slack.
- [ ] I **HAVE** included list of Metrics / Grafana panels impacted.
- [ ] I **HAVE** added database indices for new columns and updated queries.

### Dangerzone

PR author **MAY** check the following (when applicable):
PR reviewer **MUST** pay close attention to these (and apply additional scrutiny):

- [ ] I **HAVE** included changes that are outside the scope of the ticket.
- [ ] I **HAVE** combined the scope of multiple tickets.
