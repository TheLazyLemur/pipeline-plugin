// A stand-in for pipeline-plugin's bin/pipeline.ts, for pipeline-tui's tests and for trying the TUI without a tracker.
// Like the real one, a failure exits 1 with one stderr line, "pipeline <command>: <reason>".
// It keeps its "tracker" in <cwd>/.claude/pipeline/fake-tracker.jsonl, one line per create or link.
//   tracker create          stdin {title, body}; a title starting "fail" exits 1 with a message on stderr
//   tracker link-blocker    <id> <blocker-id>
//   triage-preview          stdin {title, body}; needs_human for an empty body, else ready.
//                           FAKE_TRIAGE_DELAY_MS slows it down like the real Haiku call
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'

const log = '.claude/pipeline/fake-tracker.jsonl'
const record = (entry: object) => {
  mkdirSync('.claude/pipeline', { recursive: true })
  appendFileSync(log, JSON.stringify(entry) + '\n')
}
const input = () => JSON.parse(readFileSync(0, 'utf8')) as { title: string; body: string }
const fail = (msg: string) => {
  console.error(`pipeline ${process.argv.slice(2, 4).join(' ')}: ${msg}`)
  process.exit(1)
}

const [cmd, sub, ...args] = process.argv.slice(2)
if (cmd === 'tracker' && sub === 'create') {
  const t = input()
  if (t.title.startsWith('fail')) fail('tracker unreachable: 503 from the fake tracker')
  const id = String(100 + (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(l => l.includes('"op":"create"')).length : 0) + 1)
  record({ op: 'create', id, ...t })
  console.log(JSON.stringify({ id, url: `https://tracker.example/issues/${id}` }))
} else if (cmd === 'tracker' && sub === 'link-blocker') {
  record({ op: 'link', id: args[0], blocker: args[1] })
} else if (cmd === 'triage-preview') {
  const t = input()
  await new Promise(r => setTimeout(r, Number(process.env.FAKE_TRIAGE_DELAY_MS ?? 0)))
  console.log(JSON.stringify(t.body.trim() === ''
    ? { status: 'needs_human', ready: false, question: 'What should change, and how will we know it is done?', difficulty: 2, confidence: 0.4, model: 'sonnet', reason: 'The ticket has a title and no description or acceptance criteria.' }
    : { status: 'ready', ready: true, question: null, difficulty: 2, confidence: 0.9, model: 'sonnet', reason: 'Clear change with checkable acceptance criteria.' }))
} else {
  fail('unknown command')
}
