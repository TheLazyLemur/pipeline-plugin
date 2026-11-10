package main

import (
	"slices"
	"testing"
)

func TestParseDraftReadsTitleBodyAndBlockers(t *testing.T) {
	// given
	// ... a saved draft with a heading title, comments inline and across lines, and a blocked-by line
	text := `<!-- triage asked: which providers? -->

# Add GitHub login

## What and why
Users sign in with GitHub. <!-- not Google yet -->

blocked-by: #12, 13 ,
<!--
readiness guide
-->
`

	// when
	// ... it is parsed
	d := parseDraft(text)

	// then
	// ... the title, the body without comments or the blocked-by line, and the blocker ids come out
	if d.Title != "Add GitHub login" {
		t.Errorf("title = %q", d.Title)
	}
	if want := "## What and why\nUsers sign in with GitHub."; d.Body != want {
		t.Errorf("body = %q, want %q", d.Body, want)
	}
	if !slices.Equal(d.Blockers, []string{"12", "13"}) {
		t.Errorf("blockers = %q", d.Blockers)
	}
}

func TestParseDraftOfTheUntouchedTemplateHasNoTitle(t *testing.T) {
	// given
	// ... the template saved as it was opened, with a readiness guide that contains a comment end
	text := draftTemplate("", "# Readiness\n\n- It has acceptance criteria. -->")

	// when
	// ... it is parsed
	d := parseDraft(text)

	// then
	// ... the title is empty, so the draft is discarded, and nothing of the guide leaks into the body
	if d.Title != "" {
		t.Errorf("title = %q, want empty", d.Title)
	}
	if want := "## What and why\n\n\n\n## Acceptance criteria\n\n-\n\n## Out of scope"; d.Body != want {
		t.Errorf("body = %q, want %q", d.Body, want)
	}
}
