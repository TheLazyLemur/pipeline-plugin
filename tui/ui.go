package main

import (
	"cmp"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/ultraviolet/screen"
	"github.com/charmbracelet/x/ansi"
)

const (
	focusList = iota
	focusPage
)

type mode int

const (
	modeBrowse   mode = iota
	modeTitle         // typing a quick-add title
	modeTriaging      // triage-preview is running; the list still works
	modeVerdict       // the verdict modal waits for enter, e or esc
	modeFiling        // tracker create and link-blocker are running
)

const refreshEvery = 5 * time.Second

// UI is the ticket list on the left and the selected ticket's page in the centre.
// Every field is touched only on the Run goroutine; background commands hand their results back through done.
type UI struct {
	p    Plugin
	con  *console
	t    *uv.Terminal
	scr  *uv.TerminalScreen
	done chan func()
	quit bool
	err  error // why Run gave up

	w, h       int
	focus      int
	mode       mode
	sel        string // id of the selected ticket or filed row
	listTop    int
	pageScroll int

	tickets []Ticket
	filed   []Filed
	loadErr error
	loaded  time.Time

	draft   Draft
	verdict Verdict
	input   []rune
	since   time.Time // when the running command started
	msg     string
	msgSt   uv.Style
}

func newUI(p Plugin) *UI { return &UI{p: p, done: make(chan func(), 8)} }

// console gives UV a cancelable reader on each Start. UV's own reader stays blocked in read past Stop, so after
// the editor returns, the previous Start's reader would swallow the first key.
type console struct {
	uv.Console
	in interface {
		Cancel() bool
		Close() error
	}
	err error
}

func (c *console) Reader() io.Reader {
	in, err := uv.NewCancelReader(c.Console.Reader())
	if err != nil {
		c.in, c.err = nil, err
		return c.Console.Reader()
	}
	c.in, c.err = in, nil
	return in
}

// attach puts the UI on a console: stdin and stdout for Run, a pty in tests.
func (u *UI) attach(c uv.Console) {
	u.con = &console{Console: c}
	u.t = uv.NewTerminal(u.con, nil)
	u.scr = u.t.Screen()
}

func (u *UI) Run() error {
	u.attach(uv.DefaultConsole())
	u.scr.EnterAltScreen()
	u.scr.EnableBracketedPaste()
	if err := u.t.Start(); err != nil {
		return err
	}
	defer u.t.Stop()
	u.w, u.h = u.scr.Width(), u.scr.Height()
	u.reload()
	tick := time.NewTicker(time.Second) // drives the 5s refresh and the busy timer
	defer tick.Stop()
	for !u.quit {
		select {
		case ev := <-u.t.Events():
			u.handle(ev)
		case f := <-u.done:
			f()
		case <-tick.C:
			if time.Since(u.loaded) >= refreshEvery {
				u.reload()
			}
		}
		u.draw()
	}
	return u.err
}

func (u *UI) reload() {
	ts, err := loadTickets(u.p.Project)
	u.loaded, u.loadErr = time.Now(), err
	if err == nil {
		u.tickets, u.filed = ts, pruneFiled(u.filed, ts)
	}
}

func (u *UI) say(s string)   { u.msg, u.msgSt = s, stInfo }
func (u *UI) fail(err error) { u.msg, u.msgSt = err.Error(), stErr }
func (u *UI) busy() bool     { return u.mode == modeTriaging || u.mode == modeFiling }
func keptAt(d Draft) string {
	if d.Path == "" {
		return ""
	}
	return "; draft kept at " + d.Path
}

func (u *UI) handle(ev uv.Event) {
	switch ev := ev.(type) {
	case uv.WindowSizeEvent:
		u.scr.Resize(ev.Width, ev.Height)
		u.w, u.h = ev.Width, ev.Height
	case uv.PasteEvent:
		if u.mode == modeTitle {
			u.input = append(u.input, []rune(strings.ReplaceAll(ev.Content, "\n", " "))...)
		}
	case uv.KeyPressEvent:
		u.key(ev)
	}
}

func (u *UI) key(k uv.KeyPressEvent) {
	if k.MatchString("ctrl+c") {
		u.quit = true
		return
	}
	switch u.mode {
	case modeTitle:
		switch {
		case k.MatchString("esc"):
			u.mode = modeBrowse
		case k.MatchString("enter"):
			if title := strings.TrimSpace(string(u.input)); title != "" {
				u.preview(Draft{Title: title})
			} else {
				u.mode = modeBrowse
			}
		case k.MatchString("backspace"):
			if len(u.input) > 0 {
				u.input = u.input[:len(u.input)-1]
			}
		case k.Text != "" && k.Mod&(uv.ModCtrl|uv.ModAlt) == 0:
			u.input = append(u.input, []rune(k.Text)...)
		}
		return
	case modeVerdict:
		switch {
		case k.MatchString("enter"):
			u.file()
		case k.MatchString("e"):
			u.reedit()
		case k.MatchString("esc"):
			u.mode = modeBrowse
			u.say("discarded" + keptAt(u.draft))
		}
		return
	case modeFiling:
		return // the modal stays up until create answers
	}
	switch {
	case k.MatchString("q"):
		u.quit = true
	case k.MatchString("tab"):
		u.focus = 1 - u.focus
	case k.MatchString("r"):
		u.reload()
	case k.MatchString("o"):
		u.open()
	case k.MatchString("esc"):
		u.msg = ""
	case k.MatchString("j", "down") && u.focus == focusList:
		u.move(1)
	case k.MatchString("k", "up") && u.focus == focusList:
		u.move(-1)
	case k.MatchString("j", "down"):
		u.pageScroll++
	case k.MatchString("k", "up"):
		u.pageScroll = max(0, u.pageScroll-1)
	case k.MatchString("n", "N") && u.busy():
		u.say("wait: the last ticket is still being triaged")
	case k.MatchString("n"):
		u.newTicket()
	case k.MatchString("N"):
		u.mode, u.input = modeTitle, nil
	}
}

// --- the list ---

type row struct {
	header string // a group's header row, labelling its status
	status string
	t      *Ticket
	f      *Filed
}

func (r row) id() string {
	switch {
	case r.t != nil:
		return r.t.ID
	case r.f != nil:
		return r.f.ID
	}
	return ""
}

// rows is the list: tickets filed from here and not yet synced first, then each status group under its header.
func (u *UI) rows() []row {
	var rs []row
	for i := range u.filed {
		rs = append(rs, row{f: &u.filed[i]})
	}
	for _, g := range groupTickets(u.tickets) {
		rs = append(rs, row{header: fmt.Sprintf("%s (%d)", g.Label, len(g.Tickets)), status: g.Status})
		for i := range g.Tickets {
			rs = append(rs, row{t: &g.Tickets[i]})
		}
	}
	return rs
}

func (u *UI) move(by int) {
	var ids []string
	for _, r := range u.rows() {
		if r.header == "" {
			ids = append(ids, r.id())
		}
	}
	if len(ids) == 0 {
		return
	}
	i := slices.Index(ids, u.sel)
	u.sel, u.pageScroll = ids[max(0, min(len(ids)-1, i+by))], 0
}

// selected is the selected row's index, selecting the first ticket when nothing (or something gone) is selected.
func (u *UI) selected(rs []row) int {
	first := -1
	for i, r := range rs {
		if r.header != "" {
			continue
		}
		if r.id() == u.sel {
			return i
		}
		if first < 0 {
			first = i
		}
	}
	if first >= 0 {
		u.sel = rs[first].id()
	}
	return first
}

func (u *UI) open() {
	rs := u.rows()
	i := u.selected(rs)
	if i < 0 {
		return
	}
	url := ""
	if r := rs[i]; r.t != nil {
		url = cmp.Or(r.t.PRURL, r.t.URL)
	} else {
		url = r.f.URL
	}
	if url == "" {
		u.say("#" + rs[i].id() + " has no url")
		return
	}
	opener := "xdg-open"
	if runtime.GOOS == "darwin" {
		opener = "open"
	}
	cmd := exec.Command(opener, url)
	if err := cmd.Start(); err != nil {
		u.fail(err)
		return
	}
	go cmd.Wait()
	u.say("opened " + url)
}

// --- adding work ---

// writeDraft puts a new draft file in the temp dir, from the template with the project's readiness guide.
func (u *UI) writeDraft(title string) (string, error) {
	readiness, err := os.ReadFile(filepath.Join(u.p.Project, ".claude/pipeline/readiness.md"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	f, err := os.CreateTemp("", "pipeline-ticket-*.md")
	if err != nil {
		return "", err
	}
	defer f.Close()
	_, err = f.WriteString(draftTemplate(title, string(readiness)))
	return f.Name(), err
}

func (u *UI) newTicket() {
	path, err := u.writeDraft("")
	if err != nil {
		u.fail(err)
		return
	}
	u.editDraft(path)
}

// reedit reopens the draft in the editor with triage's question at the top; a quick add gets its file now.
func (u *UI) reedit() {
	path := u.draft.Path
	if path == "" {
		var err error
		if path, err = u.writeDraft(u.draft.Title); err != nil {
			u.fail(err)
			return
		}
	}
	if q := u.verdict.Question; q != nil && *q != "" {
		b, err := os.ReadFile(path)
		if err == nil {
			err = os.WriteFile(path, append([]byte("<!-- triage asked: "+strings.ReplaceAll(*q, "-->", "-- >")+" -->\n"), b...), 0o600)
		}
		if err != nil {
			u.fail(err)
			return
		}
	}
	u.editDraft(path)
}

// editDraft runs $EDITOR on the draft, then previews it; an empty title discards it.
func (u *UI) editDraft(path string) {
	u.mode = modeBrowse
	if err := u.edit(path); err != nil {
		u.fail(fmt.Errorf("editor: %w; draft kept at %s", err, path))
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		u.fail(err)
		return
	}
	d := parseDraft(string(b))
	if d.Title == "" {
		os.Remove(path)
		u.say("draft discarded: its title was empty")
		return
	}
	d.Path = path
	u.preview(d)
}

// edit hands the terminal to $EDITOR (vi when unset) and takes it back. $EDITOR may carry arguments ("code --wait").
func (u *UI) edit(path string) error {
	if u.con.err != nil {
		return fmt.Errorf("cannot free the terminal's input for the editor: %w", u.con.err)
	}
	u.con.in.Cancel()
	u.con.in.Close()
	if err := u.t.Stop(); err != nil {
		return err
	}
	cmd := exec.Command("sh", "-c", `${EDITOR:-vi} "$1"`, "sh", path)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	runErr := cmd.Run()
	if err := u.t.Start(); err != nil {
		u.quit, u.err = true, fmt.Errorf("taking the terminal back from the editor: %w", err)
		return err
	}
	u.scr.Resize(u.w, u.h) // the editor drew over the screen: repaint every cell
	return runErr
}

func (u *UI) preview(d Draft) {
	u.draft, u.mode, u.since, u.msg = d, modeTriaging, time.Now(), ""
	go func() {
		v, err := u.p.Preview(d.Title, d.Body)
		u.done <- func() {
			if err != nil {
				u.mode = modeBrowse
				u.fail(fmt.Errorf("%w%s", err, keptAt(d)))
				return
			}
			u.verdict, u.mode = v, modeVerdict
		}
	}()
}

// file creates the ticket in the tracker and links its blockers. A failed create returns to the modal, so enter retries.
func (u *UI) file() {
	d, needsYou := u.draft, u.verdict.Status == "needs_human"
	u.mode, u.since, u.msg = modeFiling, time.Now(), ""
	go func() {
		c, err := u.p.Create(d.Title, d.Body)
		var linkErrs []string
		if err == nil {
			for _, b := range d.Blockers {
				if e := u.p.LinkBlocker(c.ID, b); e != nil {
					linkErrs = append(linkErrs, e.Error())
				}
			}
		}
		u.done <- func() {
			if err != nil {
				u.mode = modeVerdict
				u.fail(err)
				return
			}
			u.mode = modeBrowse
			u.filed = append([]Filed{{ID: c.ID, URL: deref(c.URL), Title: d.Title, Blockers: d.Blockers}}, u.filed...)
			u.sel, u.focus, u.pageScroll, u.listTop = c.ID, focusList, 0, 0
			if d.Path != "" {
				os.Remove(d.Path)
			}
			switch {
			case len(linkErrs) > 0:
				u.fail(fmt.Errorf("filed #%s, but linking its blockers failed: %s", c.ID, strings.Join(linkErrs, "; ")))
			case needsYou:
				u.say(fmt.Sprintf("filed #%s; triage will send it to you, so answer it in /pipeline:pipeline-status", c.ID))
			default:
				u.say("filed #" + c.ID)
			}
		}
	}()
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// --- drawing ---

var (
	stDim    = uv.Style{Fg: ansi.BrightBlack}
	stAccent = uv.Style{Fg: ansi.Cyan, Attrs: uv.AttrBold}
	stBold   = uv.Style{Attrs: uv.AttrBold}
	stSel    = uv.Style{Attrs: uv.AttrReverse}
	stWarn   = uv.Style{Fg: ansi.Yellow}
	stOK     = uv.Style{Fg: ansi.Green}
	stInfo   = uv.Style{Fg: ansi.Cyan}
	stErr    = uv.Style{Fg: ansi.Red}
	stBar    = uv.Style{Attrs: uv.AttrReverse}
)

type line struct {
	st   uv.Style
	text string
}

// put draws text in w cells of row y, truncated or padded to fill them all.
func (u *UI) put(st uv.Style, text string, x, y, w int) {
	if w > 0 {
		text = ansi.Truncate(text, w, "…")
		text += strings.Repeat(" ", w-ansi.StringWidth(text))
		uv.NewStyledString(st.Styled(text)).Draw(u.scr, uv.Rect(x, y, w, 1))
	}
}

// wrap breaks lines to width, keeping each line's style on its continuation rows.
func wrap(ls []line, width int) []line {
	var out []line
	for _, l := range ls {
		for _, r := range strings.Split(ansi.Wrap(l.text, width, ""), "\n") {
			out = append(out, line{l.st, r})
		}
	}
	return out
}

func (u *UI) draw() {
	w, h := u.w, u.h
	screen.Clear(u.scr)
	if w < 50 || h < 12 {
		u.put(stWarn, "pipeline-tui needs at least 50x12", 0, 0, w)
		u.render()
		return
	}
	leftW := min(60, max(30, w/3))
	midX, bodyH := leftW+1, h-3 // message, key hints and status bar below
	midW := w - midX
	for y := range bodyH {
		u.put(stDim, "│", leftW, y, 1)
	}

	// left: the list
	st := stDim
	if u.focus == focusList {
		st = stAccent
	}
	u.put(st, " tickets", 0, 0, leftW)
	rs := u.rows()
	si, listH := u.selected(rs), bodyH-1
	if si >= 0 {
		u.listTop = min(u.listTop, max(0, si-1)) // keep the row above in view, so a group's header shows
		u.listTop = max(u.listTop, si-listH+1)
	}
	u.listTop = max(0, min(u.listTop, len(rs)-listH))
	for i := u.listTop; i < len(rs) && i-u.listTop < listH; i++ {
		r, y := rs[i], 1+i-u.listTop
		switch {
		case r.header != "" && r.status == "needs_human":
			u.put(uv.Style{Fg: ansi.Yellow, Attrs: uv.AttrBold}, " "+r.header, 0, y, leftW)
		case r.header != "":
			u.put(stBold, " "+r.header, 0, y, leftW)
		case i == si:
			u.put(stSel, " "+rowText(r), 0, y, leftW)
		case r.f != nil:
			u.put(stInfo, " "+rowText(r), 0, y, leftW)
		default:
			u.put(uv.Style{}, " "+rowText(r), 0, y, leftW)
		}
	}
	if len(rs) == 0 {
		u.put(stDim, " no tickets yet", 0, 1, leftW)
	}

	// centre: the selected ticket's page
	st = stDim
	if u.focus == focusPage {
		st = stAccent
	}
	u.put(st, " ticket", midX, 0, midW)
	if si >= 0 {
		page := wrap(pageLines(rs[si]), midW-3)
		u.pageScroll = min(u.pageScroll, max(0, len(page)-1))
		for i, l := range page[u.pageScroll:] {
			if i+1 >= bodyH {
				break
			}
			u.put(l.st, l.text, midX+2, i+1, midW-2)
		}
	}

	// message: a running command, or the last result
	switch u.mode {
	case modeTriaging:
		u.put(stWarn, fmt.Sprintf(" ● triaging %q… %s", u.draft.Title, time.Since(u.since).Round(time.Second)), 0, h-3, w)
	case modeFiling:
		u.put(stWarn, fmt.Sprintf(" ● filing %q… %s", u.draft.Title, time.Since(u.since).Round(time.Second)), 0, h-3, w)
	default:
		u.put(u.msgSt, " "+strings.ReplaceAll(u.msg, "\n", " ⏎ "), 0, h-3, w)
	}

	hints := map[mode]string{
		modeBrowse:   "j/k move · tab focus · o open · n new ticket · N quick add · r refresh · q quit",
		modeTriaging: "j/k move · tab focus · o open · r refresh · q quit",
		modeTitle:    "enter preview · esc cancel",
		modeVerdict:  "enter file it · e edit · esc discard",
		modeFiling:   "filing…",
	}[u.mode]
	u.put(stDim, " "+hints, 0, h-2, w)
	u.put(stBar, u.statusLine(), 0, h-1, w)

	u.scr.HideCursor()
	switch u.mode {
	case modeTitle:
		u.titleModal()
	case modeVerdict, modeFiling:
		u.verdictModal()
	}
	u.render()
}

func (u *UI) render() {
	// Flush queues the cursor move for the next Render, so render twice inside one synchronized update
	// (as tsf-example and pragmaticharness do) to land the cursor in this frame.
	u.scr.WriteString(ansi.SetModeSynchronizedOutput)
	u.scr.Render()
	u.scr.Flush()
	u.scr.Render()
	u.scr.WriteString(ansi.ResetModeSynchronizedOutput)
	u.scr.Flush()
}

func (u *UI) statusLine() string {
	s := " " + filepath.Base(u.p.Project) + " │ "
	if u.loadErr != nil {
		return s + u.loadErr.Error()
	}
	var counts []string
	for _, g := range groupTickets(u.tickets) {
		counts = append(counts, fmt.Sprintf("%s %d", g.Label, len(g.Tickets)))
	}
	return s + cmp.Or(strings.Join(counts, " · "), "no tickets") + " │ refreshed " + u.loaded.Format("15:04:05")
}

func rowText(r row) string {
	if r.f != nil {
		return fmt.Sprintf("filed #%s · waiting for sync · %s", r.f.ID, r.f.Title)
	}
	if r.t.Status == "in_progress" {
		return fmt.Sprintf("#%s %s · %s", r.t.ID, cmp.Or(r.t.Stage, "implement"), r.t.Title)
	}
	return fmt.Sprintf("#%s %s", r.t.ID, r.t.Title)
}

func field(label, value string) line { return line{uv.Style{}, fmt.Sprintf("%-11s %s", label, value)} }

// pageLines is the centre page for a row, from the db alone.
func pageLines(r row) []line {
	if f := r.f; f != nil {
		ls := []line{{stAccent, "#" + f.ID + " " + f.Title}, {stDim, f.URL}, {}, field("status", "filed · waiting for the loop's next sync")}
		if len(f.Blockers) > 0 {
			ls = append(ls, field("blocked by", "#"+strings.Join(f.Blockers, ", #")), line{stDim, "The loop holds it out of the table until its blockers are done."})
		}
		return ls
	}
	t := r.t
	status := t.Status
	if t.Status == "in_progress" {
		status += " · " + cmp.Or(t.Stage, "implement")
	}
	difficulty, confidence := "–", "–"
	if t.Difficulty > 0 {
		difficulty = fmt.Sprintf("%d/5", t.Difficulty)
	}
	if t.Confidence != nil {
		confidence = fmt.Sprintf("%.2f", *t.Confidence)
	}
	usage := "nothing recorded"
	if t.Tokens > 0 || t.Minutes > 0 {
		usage = fmt.Sprintf("%d tokens · %.1f min", t.Tokens, t.Minutes)
	}
	ls := []line{{stAccent, "#" + t.ID + " " + t.Title}, {stDim, cmp.Or(t.URL, "(no url)")}, {}, field("status", status)}
	if t.StackedOn != "" {
		ls = append(ls, field("stacked on", "#"+t.StackedOn))
	}
	ls = append(ls, field("model", cmp.Or(t.Model, "–")), field("difficulty", difficulty), field("confidence", confidence))
	if t.PRURL != "" {
		ls = append(ls, field("PR", t.PRURL))
	}
	ls = append(ls, field("usage", usage))
	for _, s := range []struct {
		label, text string
		st          uv.Style
	}{{"question", t.Question, stWarn}, {"triage reason", t.Reason, uv.Style{}}, {"answers", t.Answers, uv.Style{}}, {"body", cmp.Or(t.Body, "(empty)"), uv.Style{}}} {
		if s.text != "" {
			ls = append(ls, line{}, line{stBold, s.label})
			for _, l := range strings.Split(s.text, "\n") {
				ls = append(ls, line{s.st, l})
			}
		}
	}
	return ls
}

// box clears a centred area with a border and returns its inner x, y and width.
func (u *UI) box(width, height int) (int, int, int) {
	width, height = min(width, u.w-2), min(height, u.h-2)
	x, y := (u.w-width)/2, max(1, (u.h-height)/3)
	area := uv.Rect(x, y, width, height)
	screen.ClearArea(u.scr, area)
	b := uv.RoundedBorder().Style(stAccent)
	b.Draw(u.scr, area)
	return x + 2, y + 1, width - 4
}

func (u *UI) titleModal() {
	x, y, w := u.box(70, 5)
	u.put(stBold, "quick add: the new ticket's title", x, y, w)
	in := string(u.input)
	in = ansi.TruncateLeft(in, max(0, ansi.StringWidth(in)-(w-3)), "…")
	u.put(stAccent, "› ", x, y+1, 2)
	u.put(uv.Style{}, in, x+2, y+1, w-2)
	u.put(stDim, "enter preview · esc cancel", x, y+2, w)
	u.scr.SetCursorPosition(x+2+ansi.StringWidth(in), y+1)
	u.scr.ShowCursor()
}

func (u *UI) verdictModal() {
	v, d := u.verdict, u.draft
	st := stOK
	if v.Status != "ready" {
		st = stWarn
	}
	ls := []line{{stBold, "triage preview: " + d.Title}, {}, {st, fmt.Sprintf("%-11s %s", "status", v.Status)},
		field("difficulty", fmt.Sprintf("%d/5", v.Difficulty)), field("model", v.Model), field("confidence", fmt.Sprintf("%.2f", v.Confidence))}
	if len(d.Blockers) > 0 {
		ls = append(ls, field("blocked by", "#"+strings.Join(d.Blockers, ", #")))
	}
	ls = append(ls, line{}, line{stBold, "reason"}, line{uv.Style{}, v.Reason})
	if v.Question != nil && *v.Question != "" {
		ls = append(ls, line{}, line{stBold, "question"}, line{stWarn, *v.Question})
	}
	if v.Status == "needs_human" {
		ls = append(ls, line{}, line{stWarn, "! Filed as it is, it will wait in needs_human for your answer in /pipeline:pipeline-status."})
	}
	footer := line{stDim, "enter file it · e edit · esc discard"}
	if u.mode == modeFiling {
		footer = line{stWarn, fmt.Sprintf("filing… %s", time.Since(u.since).Round(time.Second))}
	}
	ls = append(ls, line{}, footer)
	width := min(80, u.w-4)
	ls = wrap(ls, width-4)
	x, y, w := u.box(width, len(ls)+2)
	for i, l := range ls {
		if i >= u.h-4 {
			break
		}
		u.put(l.st, l.text, x, y+i, w)
	}
}
