package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakePlugin runs testdata/fake-plugin from a fresh project dir; its tracker log is fakeLog(p).
func fakePlugin(t *testing.T) Plugin {
	t.Helper()
	dir, err := filepath.Abs("testdata/fake-plugin")
	if err != nil {
		t.Fatal(err)
	}
	return Plugin{Dir: dir, Project: t.TempDir()}
}

func fakeLog(t *testing.T, p Plugin) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(p.Project, ".claude/pipeline/fake-tracker.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestCreateSendsTheTicketAndReturnsItsID(t *testing.T) {
	// given
	// ... the fake plugin with an empty tracker
	p := fakePlugin(t)

	// when
	// ... a ticket is created
	c, err := p.Create("Add login", "Users sign in.")

	// then
	// ... the CLI got the title and body on stdin, and its id and url come back
	if err != nil {
		t.Fatal(err)
	}
	if c.ID != "101" || c.URL == nil || *c.URL != "https://tracker.example/issues/101" {
		t.Errorf("created = %+v", c)
	}
	if want := `{"op":"create","id":"101","title":"Add login","body":"Users sign in."}`; strings.TrimSpace(fakeLog(t, p)) != want {
		t.Errorf("tracker log = %s, want %s", fakeLog(t, p), want)
	}
}

func TestLinkBlockerPassesBothIDs(t *testing.T) {
	// given
	// ... the fake plugin
	p := fakePlugin(t)

	// when
	// ... ticket 101 is linked to its blocker 7
	err := p.LinkBlocker("101", "7")

	// then
	// ... the CLI recorded the link
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"op":"link","id":"101","blocker":"7"}`; strings.TrimSpace(fakeLog(t, p)) != want {
		t.Errorf("tracker log = %s, want %s", fakeLog(t, p), want)
	}
}

func TestPreviewReturnsTheVerdict(t *testing.T) {
	// given
	// ... the fake plugin, which judges a ticket with no body not ready
	p := fakePlugin(t)

	// when
	// ... a title-only ticket is previewed
	v, err := p.Preview("Add login", "")

	// then
	// ... the verdict says needs_human with triage's question and scores
	if err != nil {
		t.Fatal(err)
	}
	if v.Status != "needs_human" || v.Question == nil || v.Difficulty != 2 || v.Model != "sonnet" || v.Confidence != 0.4 {
		t.Errorf("verdict = %+v", v)
	}
}

func TestCreateFailureCarriesTheCLIStderr(t *testing.T) {
	// given
	// ... the fake plugin, whose tracker refuses a title starting "fail"
	p := fakePlugin(t)

	// when
	// ... that ticket is created
	_, err := p.Create("fail on purpose", "")

	// then
	// ... the error is the CLI's own message, for the status line
	if err == nil || err.Error() != "pipeline tracker create: tracker unreachable: 503 from the fake tracker" {
		t.Errorf("err = %v", err)
	}
}
