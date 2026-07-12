# Architecture

One rule explains the whole design: **the files are the product; the code is a librarian that maintains them.** Everything is plain markdown in a git repo, readable and editable by hand, by Obsidian, or by any other tool. Synapse never holds state the vault doesn't.

## Data flow

```
your message
    │
    ▼
capture ──────────────► archive/capture.log        (verbatim, before anything)
    │
    ▼
llm.js ── one Claude call: split, classify, clean, propose links
    │           ▲
    │           └── reads memory/agent-rules.md (guardrails + learned patterns)
    ▼
clarify loop ── questions come back to you; answers re-classify (max 2 rounds)
    │
    ▼
route:
  thought ──► thoughts/YYYY-MM-DD-slug.md   raw + cleaned + earned links
  task ─────► tasks.md via tasks.js         scored, ranked, deadline → calendar
  event ────► Google Calendar via gcal.js   conflict-checked, ask-don't-guess
  note ─────► notes/topic.md                merged, not duplicated
  unresolved► inbox.md                      parked, never guessed, never dropped
    │
    ▼
git commit (one per message) ──► "undo" = git revert
    │
    ▼
one-line confirmation
```

## Modules

**pipeline.js** is the spine; read it first. It owns the 7-step contract and calls everything else. No module below it knows about the others.

**llm.js** makes exactly one API call per message (plus one per clarify round). The system prompt embeds `agent-rules.md` in full, so editing that file changes behavior without touching code. `SYNAPSE_MOCK=1` swaps in a deterministic heuristic so tests run offline.

**tasks.js** owns `tasks.md`. Score = urgency (due-date proximity: overdue +100 → within-week +15) + importance (⏫ +40, 🔽 −20) − age decay (>30 days without deadline −10). Rendering regroups into Top 5 / This week / Later / Waiting on every write. The file stays hand-editable; parse → score → re-render is idempotent.

**gcal.js** is the only network integration. Plain-fetch OAuth (loopback redirect), token auto-refresh, `calendar.events` scope only. Timed events get conflict checks; task deadlines become all-day events. A file-backed mock mirrors the interface for tests.

**vault.js** is the only module that touches vault files for thoughts/notes/inbox, plus git (init, commit-per-action, revert-based undo). Guardrail enforcement lives here: capture-before-processing, raw-preserved-alongside-cleaned.

**config.js / init.js** — defaults (model, thresholds, vault path) overridable via `synapse.config.json` or `SYNAPSE_VAULT`; init copies the template to a private vault with its own git history.

## Design decisions and why

- **Ask-don't-guess is enforced in two places.** The LLM is instructed to emit a `question` for missing fields, and the pipeline *also* refuses to book an event without date+time even if the LLM misbehaves. Guardrails you care about get code enforcement, not just prompt enforcement.
- **Confidence threshold starts high (0.8).** Early on the agent asks more; as `agent-rules.md` accumulates learned patterns, lower it in `synapse.config.json`.
- **Links are scarce by design** (max 4, each with a stored reason). An over-linked graph is as useless as no graph. Clusters form through hub notes, not pairwise linking.
- **tasks.md over a database.** Obsidian renders it, humans edit it, git diffs it. The ranking engine treats it as source of truth and survives any manual edit.
- **Zero npm dependencies.** Less to audit, nothing to break on install, clones run instantly. The cost (hand-rolled OAuth, emoji parsing) was one file each.

## What's next (see docs/plan.md §3)

Phase 4: web UI (chat box + thoughts/graph/tasks/agenda tabs). Phase 5: memory loop (corrections log → weekly self-review rewrites agent-rules.md). Phase 6: packaging, daemon mode, phone capture.
