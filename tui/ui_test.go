package main

import (
	"io"
	"testing"
	"time"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/creack/pty"
)

// nextKey is the next key the terminal reports, skipping size and mode events.
func nextKey(t *testing.T, events <-chan uv.Event) string {
	t.Helper()
	timeout := time.After(2 * time.Second)
	for {
		select {
		case ev := <-events:
			if k, ok := ev.(uv.KeyPressEvent); ok {
				return k.String()
			}
		case <-timeout:
			t.Fatal("no key reached the UI")
		}
	}
}

func TestFirstKeyAfterTheEditorReachesTheUI(t *testing.T) {
	// given
	// ... the UI on a pty, which handed the terminal to an editor that has exited
	ptmx, tty, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer ptmx.Close()
	go io.Copy(io.Discard, ptmx)
	t.Setenv("EDITOR", "true")
	u := newUI(Plugin{})
	u.attach(uv.NewConsole(tty, tty, []string{"TERM=xterm-256color"}))
	if err := u.t.Start(); err != nil {
		t.Fatal(err)
	}
	defer u.t.Stop()
	if err := u.edit("/dev/null"); err != nil {
		t.Fatal(err)
	}

	// when
	// ... a key is typed
	ptmx.Write([]byte("j"))

	// then
	// ... the UI gets it, not the input reader from before the editor ran
	if k := nextKey(t, u.t.Events()); k != "j" {
		t.Errorf("key = %q, want j", k)
	}
}
