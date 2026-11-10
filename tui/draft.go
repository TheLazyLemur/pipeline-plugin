package main

import (
	"regexp"
	"strings"
)

// Draft is a ticket written in $EDITOR (or a quick-add title), ready for triage-preview and tracker create.
type Draft struct {
	Title    string
	Body     string
	Blockers []string
	Path     string // the draft file; "" for a quick add until it is edited
}

var (
	comment   = regexp.MustCompile(`(?s)<!--.*?-->`)
	blockedBy = regexp.MustCompile(`(?i)^\s*blocked-by:(.*)$`)
)

// draftTemplate is the file `n` opens. The readiness guide rides along in a comment, which parseDraft strips.
func draftTemplate(title, readiness string) string {
	s := "<!-- The first line is the title. Leave it empty to discard the draft. -->\n# " + title + `

## What and why



## Acceptance criteria

-

## Out of scope



blocked-by:
`
	if readiness != "" {
		// "-->" inside the guide would end the comment early
		s += "\n<!-- .claude/pipeline/readiness.md, as a reminder (not filed):\n\n" + strings.ReplaceAll(strings.TrimSpace(readiness), "-->", "-- >") + "\n-->\n"
	}
	return s
}

// parseDraft reads a saved draft: comments stripped, the title is the first non-empty line without its leading #,
// and every blocked-by: line leaves the body as comma-separated ids. An empty Title means discard.
func parseDraft(text string) Draft {
	var d Draft
	var body []string
	titled := false
	for _, line := range strings.Split(comment.ReplaceAllString(text, ""), "\n") {
		if m := blockedBy.FindStringSubmatch(line); m != nil {
			for _, id := range strings.Split(m[1], ",") {
				if id = strings.TrimPrefix(strings.TrimSpace(id), "#"); id != "" {
					d.Blockers = append(d.Blockers, id)
				}
			}
			continue
		}
		if !titled && strings.TrimSpace(line) != "" {
			d.Title, titled = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "#")), true
			continue
		}
		body = append(body, line)
	}
	d.Body = strings.TrimSpace(strings.Join(body, "\n"))
	return d
}
