# Synapse 🧠

**Obsidian minus the manual labor.** You dump messy thoughts into one box; an AI librarian writes the clean note, earns the links, ranks your tasks, and books your calendar — asking instead of guessing when it's unsure.

## What it does

Every message goes through one pipeline:

```
capture (verbatim, never lost)
  → split (one message may contain several items)
  → classify (thought | task | event | note | unclear)
  → clarify (missing info or low confidence → ask, never guess)
  → clean (LLM rewrite, raw always preserved)
  → route (vault / calendar / task list)
  → confirm (one line: what went where)
```

- **Thoughts** → one markdown note each: your raw words + a cleaned version + a few *earned* `[[wikilinks]]`. The graph builds itself. Fully Obsidian-compatible.
- **Tasks** → detected (asks "task or thought?" when ambiguous), ranked by urgency × importance × age.
- **Events** → straight into Google Calendar — but only when title, date, and time are known. Missing info triggers a question, never a made-up default.
- **Memory** → every correction you make becomes a rule in `memory/agent-rules.md`. The agent rewrites its own rules weekly. It gets better because you use it.

## Hard guardrails

1. Never invent dates, times, names, or intent — ask.
2. Never lose your raw words — cleaned versions are added, not substituted.
3. Confirm every action in one line.
4. Everything is git-versioned — undo always works.
5. Corrections are law.

## Repo layout

```
prompts/          # the agent's system prompt + guardrails
vault-template/   # empty vault skeleton (copy to start your own)
ui/               # chat-box web app        (phase 4)
integrations/     # google calendar tool    (phase 2)
docs/
```

Your personal vault is **your own private copy** of `vault-template/` — never commit it here.

## Status

Early. Build phases: 0 skeleton ✅ · 1 thought pipeline · 2 calendar · 3 tasks · 4 UI · 5 memory loop · 6 packaging.

## License

MIT
