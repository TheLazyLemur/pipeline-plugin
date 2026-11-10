package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// storeSchema is the tickets schema from pipeline-agents/src/store.ts, so these tests read the db the plugin writes.
func storeSchema(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("../pipeline-agents/src/store.ts")
	if err != nil {
		t.Fatal(err)
	}
	_, s, ok := strings.Cut(string(b), "export const SCHEMA = `")
	s, _, ok2 := strings.Cut(s, "`")
	if !ok || !ok2 {
		t.Fatal("no SCHEMA template literal in store.ts")
	}
	return s
}

// project makes a project dir whose pipeline.db is built by sql.
func project(t *testing.T, sql string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".claude/pipeline"), 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("sqlite3", filepath.Join(dir, dbPath), sql).CombinedOutput(); err != nil {
		t.Fatalf("sqlite3: %v: %s", err, out)
	}
	return dir
}

func TestGroupTicketsOrdersStatusesAndIDs(t *testing.T) {
	// given
	// ... tickets of every status, out of order, one with a status the list does not know
	ts := []Ticket{
		{ID: "10", Status: "ready"}, {ID: "3", Status: "done"}, {ID: "7", Status: "new"},
		{ID: "9", Status: "ready"}, {ID: "5", Status: "held"}, {ID: "4", Status: "pr_open"},
		{ID: "2", Status: "in_progress"}, {ID: "8", Status: "needs_human"},
	}

	// when
	// ... they are grouped
	gs := groupTickets(ts)

	// then
	// ... needs you, ready, in progress, PR open, new and done come in that order, the unknown status last,
	// ... and ids sort numerically within a group
	var got []string
	for _, g := range gs {
		got = append(got, g.Label)
		for _, t := range g.Tickets {
			got = append(got, t.ID)
		}
	}
	want := []string{"needs you", "8", "ready", "9", "10", "in progress", "2", "PR open", "4", "new", "7", "done", "3", "held", "5"}
	if !slices.Equal(got, want) {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}

func TestFiledRowGoesOnceTheDbHasItsID(t *testing.T) {
	// given
	// ... tickets 42 and 43 filed from here, and a db the loop has synced 42 into
	dir := project(t, storeSchema(t)+";insert into tickets (ticket_id, title) values ('42', 'Add login')")
	filed := []Filed{{ID: "42", Title: "Add login"}, {ID: "43", Title: "Add logout"}}

	// when
	// ... the db is re-read and the filed rows pruned
	ts, err := loadTickets(dir)
	filed = pruneFiled(filed, ts)

	// then
	// ... only 43 still waits for sync
	if err != nil {
		t.Fatal(err)
	}
	if len(filed) != 1 || filed[0].ID != "43" {
		t.Errorf("filed = %+v, want only 43", filed)
	}
}

func TestLoadTicketsAddsUsageFromTurns(t *testing.T) {
	// given
	// ... a ticket with two implementer turns recorded
	dir := project(t, storeSchema(t)+`;insert into tickets (ticket_id, title, status, answers) values ('7', 'Fix sync', 'in_progress', 'Q: which?
A: this');
insert into turns values ('7', 'implementer', 'sonnet', 100, 20, 1000, 50, 60000), ('7', 'implementer', 'sonnet', 10, 5, 0, 0, 30000)`)

	// when
	// ... the db is read
	ts, err := loadTickets(dir)

	// then
	// ... the ticket carries its answers, total tokens and minutes
	if err != nil {
		t.Fatal(err)
	}
	if len(ts) != 1 || ts[0].Tokens != 1185 || ts[0].Minutes != 1.5 || ts[0].Answers != "Q: which?\nA: this" {
		t.Errorf("tickets = %+v", ts)
	}
}

func TestLoadTicketsReadsADbFromBeforeAnswersAndUsage(t *testing.T) {
	// given
	// ... a db made before the answers, stage and body columns and the ticket_usage view existed
	dir := project(t, `create table tickets (ticket_id text primary key, title text not null, url text,
  status text not null default 'new', question text, difficulty integer, confidence real, model text, reason text, pr_url text);
insert into tickets (ticket_id, title, status, question) values ('3', 'Old ticket', 'needs_human', 'Which API?')`)

	// when
	// ... the db is read
	ts, err := loadTickets(dir)

	// then
	// ... the ticket loads with what the db has and no answers or usage
	if err != nil {
		t.Fatal(err)
	}
	if len(ts) != 1 || ts[0].Question != "Which API?" || ts[0].Answers != "" || ts[0].Tokens != 0 {
		t.Errorf("tickets = %+v", ts)
	}
}
