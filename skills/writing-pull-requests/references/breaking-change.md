<!-- PR title: <ticket-id> - BREAKING CHANGE[<context>]: <summary> -->

# BREAKING CHANGE

This PR introduces a breaking change that requires careful consideration and testing before deployment,
and MAY require updates/communication with all affected clients/systems integrating with this service.

<!-- summary -->

### Changelog

<!-- changelog -->

[<TICKET-ID>](<ticket-url>)

# Manual tests / QA

### Local

<!--
 * Steps to manually test locally
 * Outcome
 * Screenshots etc
-->

### Remote <!-- if relevant --> <!-- rename! -->

<!--
 * Steps to manually test in this environment
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

PR author **MUST** check all the following:

- [ ] I **HAVE** completed and cleaned up the PR description.
- [ ] I **HAVE** self-reviewed.
- [ ] I **HAVE** added/updated automated tests.
- [ ] I **HAVE** considered/described risks and impacts.
- [ ] I **HAVE** followed the team's PR, testing, commit, deployment and monitoring guidelines.

### Conditional

PR author **MAY** check the following (when applicable):

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
