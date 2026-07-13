# Synapse 🧠

**Obsidian minus the manual labor.** You dump messy thoughts into one box. An AI librarian writes the clean note, earns the links, ranks your tasks, and books your calendar. When it's unsure, it asks instead of guessing.

## How it works

Every message goes through one pipeline:

```
capture (verbatim, never lost)
  → split (one message may contain several items)
  → classify (thought | task | event | note | unclear)
  → clarify (missing info or low confidence: ask, never guess)
  → clean (LLM rewrite, raw always preserved)
  → route (vault / calendar / task list)
  → confirm (one line: what went where)
```

What each type becomes:

| You say | It becomes |
|---|---|
| "mayb the memory part is the real product??" | A thought note: your raw words + a cleaned version + max 4 *earned* `[[wikilinks]]`. The graph builds itself. |
| "gotta email marc by friday, urgent" | A ranked task (urgency + importance + age), deadline synced to your calendar. |
| "dinner with lea thursday 8pm" | A Google Calendar event, conflict-checked. "dinner thursday" gets asked "What time?" instead of a made-up default. |
| "remember: coworking wifi is FIBRE123" | A fact merged into the right topic note. |

## Hard guardrails

1. Never invent dates, times, names, or intent: ask.
2. Never lose your raw words. Cleaned versions are added, not substituted.
3. Confirm every action in one line.
4. Everything is git-versioned, so `undo` always works.
5. Corrections are law: fix it once, it learns the pattern.

## Quickstart

Requires Node 18+ and git. Zero npm dependencies.

```bash
git clone <this repo> && cd Synapse
npm run init                 # creates ./my-vault from the template (private git repo)
cp .env.example .env         # add your ANTHROPIC_API_KEY (.env is loaded automatically)
npm run ui                   # → http://127.0.0.1:8377
```

Point Obsidian at `my-vault/` to watch the graph grow. Google Calendar setup (optional, 5 min): `docs/gcal-setup.md`.

## Commands

| Command | What it does |
|---|---|
| `npm run ui` | **The app**: chat box + Thoughts / Graph / Tasks / Agenda at http://127.0.0.1:8377 |
| `npm start` | Same pipeline in the terminal |
| `node src/index.js "any messy text"` | One-shot filing |
| `node src/index.js tasks` | Ranked task list with scores |
| `node src/index.js agenda` | Next 7 days from Google Calendar |
| `node src/index.js brief` | Morning briefing: agenda + top tasks + what's on your mind |
| `node src/index.js review` | Self-review: turn your corrections into permanent rules |
| `node src/index.js cleanup` | Archive done tasks, re-rank, surface stale ones |
| `node src/index.js undo` | Revert the last filing (git revert) |
| `node src/index.js auth-gcal` | One-time Google Calendar authorization |

To correct the agent, just tell it: "no, the rust thing was a thought not a task". It logs the correction, and `review` generalizes it into a rule in `memory/agent-rules.md` so the mistake never repeats. Automate the routines with cron:

```cron
0 8 * * 1-5  cd ~/Synapse && node src/index.js brief      # weekday mornings
0 18 * * 0   cd ~/Synapse && node src/index.js cleanup && node src/index.js review   # sunday evening
```

Offline / no API key: prefix any command with `SYNAPSE_MOCK=1`.

## Repo map

```
src/
├── index.js      CLI entry: interactive loop + commands
├── pipeline.js   the 7-step pipeline (the brain's spine)
├── llm.js        one Claude call: split + classify + clean + link
├── tasks.js      ranking engine: score, resort, cleanup, decay
├── memory.js     the learning loop: corrections → review → new rules; briefing
├── server.js     localhost web server for the UI (same pipeline as the CLI)
├── gcal.js       Google Calendar: OAuth, booking, conflicts, agenda
├── vault.js      all vault file I/O + git (commit per action, undo)
├── config.js     defaults + synapse.config.json overrides
└── init.js       copies vault-template → your private vault
prompts/          reference system prompt (the agent's constitution)
vault-template/   empty vault skeleton with example notes
docs/             plan.md · architecture.md · gcal-setup.md
```

Your personal vault is a **private copy** of `vault-template/` (default `./my-vault`, gitignored). Never commit it here.

## Status

Phases: 0 skeleton ✅ · 1 thought pipeline ✅ · 2 calendar ✅ · 3 task ranking ✅ · 4 web UI ✅ · 5 memory loop ✅ · 6 packaging. See `docs/plan.md` for the full design.

The UI binds to 127.0.0.1 only. Do not expose it to a network without adding auth first.

## License

MIT
