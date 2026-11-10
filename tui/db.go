package main

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
)

const dbPath = ".claude/pipeline/pipeline.db"

// Ticket is one row of the pipeline's tickets table (pipeline-agents/src/store.ts) plus its ticket_usage.
// It is read with `select *`, so a column an older db lacks (answers, stage, ...) decodes as its zero value.
type Ticket struct {
	ID         string   `json:"ticket_id"`
	Title      string   `json:"title"`
	URL        string   `json:"url"`
	Body       string   `json:"body"`
	Status     string   `json:"status"`
	Stage      string   `json:"stage"`
	Question   string   `json:"question"`
	Answers    string   `json:"answers"`
	Difficulty int      `json:"difficulty"`
	Confidence *float64 `json:"confidence"`
	Model      string   `json:"model"`
	Reason     string   `json:"reason"`
	PRURL      string   `json:"pr_url"`
	StackedOn  string   `json:"stacked_on"`
	Tokens     int      `json:"-"`
	Minutes    float64  `json:"-"`
}

// Filed is a ticket created in the tracker from here that the loop has not synced into the db yet.
type Filed struct {
	ID, URL, Title string
	Blockers       []string
}

// loadTickets reads every ticket with its usage from <project>/.claude/pipeline/pipeline.db.
func loadTickets(project string) ([]Ticket, error) {
	db := project + "/" + dbPath
	if _, err := os.Stat(db); err != nil {
		return nil, fmt.Errorf("no %s yet: run /pipeline:tracker-setup and let the loop run a pass", dbPath)
	}
	var ts []Ticket
	if err := query(db, "select * from tickets", &ts); err != nil {
		return nil, err
	}
	var usage []struct {
		ID      string  `json:"ticket_id"`
		Tokens  int     `json:"tokens"`
		Minutes float64 `json:"minutes"`
	}
	// a db the loop has not migrated since usage was added has no ticket_usage view: no usage, not an error
	if err := query(db, "select ticket_id, tokens, minutes from ticket_usage", &usage); err != nil && !strings.Contains(err.Error(), "no such table: ticket_usage") {
		return nil, err
	}
	for _, u := range usage {
		if i := slices.IndexFunc(ts, func(t Ticket) bool { return t.ID == u.ID }); i >= 0 {
			ts[i].Tokens, ts[i].Minutes = u.Tokens, u.Minutes
		}
	}
	return ts, nil
}

// query runs one select through the sqlite3 CLI, as the plugin's skills do, read-only so it never creates or writes the db.
func query(db, sql string, into any) error {
	out, err := exec.Command("sqlite3", "-readonly", "-json", "-cmd", ".timeout 5000", db, sql).Output()
	if err != nil {
		return fmt.Errorf("sqlite3: %s", stderr(err))
	}
	if len(bytes.TrimSpace(out)) == 0 {
		return nil // sqlite3 -json prints nothing for no rows
	}
	return json.Unmarshal(out, into)
}

// stderr is a failed command's stderr, or the error itself when it wrote none.
func stderr(err error) string {
	var ee *exec.ExitError
	if errors.As(err, &ee) && len(bytes.TrimSpace(ee.Stderr)) > 0 {
		return string(bytes.TrimSpace(ee.Stderr))
	}
	return err.Error()
}

// Group is one status section of the ticket list.
type Group struct {
	Status, Label string
	Tickets       []Ticket
}

// statusOrder is the list's order: what needs you first, finished work last.
var statusOrder = []struct{ status, label string }{
	{"needs_human", "needs you"}, {"ready", "ready"}, {"in_progress", "in progress"},
	{"pr_open", "PR open"}, {"new", "new"}, {"done", "done"},
}

// groupTickets sorts tickets into the non-empty status groups in statusOrder. A status the list does not know
// (one a newer plugin added) gets its own group at the end rather than being hidden.
func groupTickets(ts []Ticket) []Group {
	var gs []Group
	add := func(status, label string) {
		var g []Ticket
		for _, t := range ts {
			if t.Status == status {
				g = append(g, t)
			}
		}
		// shorter ids first, so 9 sorts before 10 and PROJ-9 before PROJ-10
		slices.SortFunc(g, func(a, b Ticket) int { return cmp.Or(cmp.Compare(len(a.ID), len(b.ID)), strings.Compare(a.ID, b.ID)) })
		if len(g) > 0 {
			gs = append(gs, Group{status, label, g})
		}
	}
	seen := map[string]bool{}
	for _, s := range statusOrder {
		add(s.status, s.label)
		seen[s.status] = true
	}
	for _, t := range ts {
		if !seen[t.Status] {
			add(t.Status, t.Status)
			seen[t.Status] = true
		}
	}
	return gs
}

// pruneFiled drops the filed tickets the db now has: from then on the db's row shows them.
func pruneFiled(fs []Filed, ts []Ticket) []Filed {
	return slices.DeleteFunc(fs, func(f Filed) bool {
		return slices.ContainsFunc(ts, func(t Ticket) bool { return t.ID == f.ID })
	})
}
