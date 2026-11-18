package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
)

// Plugin runs the pipeline-plugin CLI, `node <dir>/bin/pipeline.ts <command>`, from the project root.
type Plugin struct{ Dir, Project string }

// Created is what `tracker create` prints.
type Created struct {
	ID  string  `json:"id"`
	URL *string `json:"url"`
}

// Verdict is what `triage-preview` prints.
type Verdict struct {
	Status     string  `json:"status"`
	Question   *string `json:"question"`
	Difficulty int     `json:"difficulty"`
	Confidence float64 `json:"confidence"`
	Model      string  `json:"model"`
	Reason     string  `json:"reason"`
}

type ticketInput struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

// run calls one CLI command. A failure is the CLI's one stderr line ("pipeline <command>: <reason>"), shown as is.
func (p Plugin) run(stdin any, args ...string) ([]byte, error) {
	cmd := exec.Command("node", append([]string{filepath.Join(p.Dir, "bin", "pipeline.ts")}, args...)...)
	cmd.Dir = p.Project
	if stdin != nil {
		b, err := json.Marshal(stdin)
		if err != nil {
			return nil, err
		}
		cmd.Stdin = bytes.NewReader(b)
	}
	out, err := cmd.Output()
	if err != nil {
		return nil, errors.New(stderr(err))
	}
	return out, nil
}

func (p Plugin) Create(title, body string) (Created, error) {
	var c Created
	out, err := p.run(ticketInput{title, body}, "tracker", "create")
	if err == nil {
		err = decode(out, &c)
	}
	if err == nil && c.ID == "" {
		err = fmt.Errorf("tracker create: printed no id: %s", out)
	}
	return c, err
}

func (p Plugin) LinkBlocker(id, blocker string) error {
	_, err := p.run(nil, "tracker", "link-blocker", id, blocker)
	return err
}

func (p Plugin) Preview(title, body string) (Verdict, error) {
	var v Verdict
	out, err := p.run(ticketInput{title, body}, "triage-preview")
	if err == nil {
		err = decode(out, &v)
	}
	if err == nil && v.Status != "ready" && v.Status != "needs_human" {
		err = fmt.Errorf("triage-preview: not a verdict: %s", out)
	}
	return v, err
}

func decode(out []byte, into any) error {
	if err := json.Unmarshal(bytes.TrimSpace(out), into); err != nil {
		return fmt.Errorf("unreadable output %q: %w", out, err)
	}
	return nil
}
