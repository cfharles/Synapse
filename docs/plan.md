# Synapse — Detailed Plan (v2)

One input box. You type messy. The agent classifies, cleans, files, and asks when unsure. Outputs land in three places you already trust: an **Obsidian vault** (thoughts + notes + tasks), **Google Calendar** (events), and a **ranked task list** (inside the vault). Open source from day one.

---

## 1. What the agent does (behavior spec)

### 1.1 The contract

Every message you send goes through the same pipeline, no exceptions:

```
capture (verbatim, never lost)
  → split (one message may contain several items)
  → classify (thought | task | event | note | mixed | unclear)
  → clarify (if confidence low or required info missing → ask, never guess)
  → clean (LLM rewrite, raw always preserved)
  → route (vault / calendar / task list)
  → confirm (one line: what went where)
```

### 1.2 Hard guardrails (non-negotiable, encoded in the system prompt)

1. **Never invent.** No made-up dates, times, names, places, or intent. If a required field is missing, ask.
2. **Never lose the raw.** Your exact words are stored verbatim before any processing. The cleaned version is *added*, never a replacement.
3. **Ask when confused.** Below a confidence threshold on classification → ask ("Is this a task or just a thought?"). Missing required event fields → ask ("What time Thursday?"). One short question at a time, never a questionnaire.
4. **Confirm every action.** One line after filing: "→ Thought filed, linked to [[startup-idea]]. Task added, ranked #3."
5. **Everything reversible.** The vault is git-versioned; every agent write is a commit. "Undo that" always works.
6. **Corrections are law.** When you correct the agent, the correction is written to memory and applied from then on.

### 1.3 Thoughts — Obsidian-style, raw + cleaned, graph-linked

You write messy, stream-of-consciousness. The agent creates one note per thought in the vault:

```markdown
---
date: 2026-07-08 14:32
type: thought
tags: [startups, ai]
---

## Raw
gotta think abt the agent thing... mayb the memory part is the real
product?? like everyone does chat nobody does memory right

## Cleaned
The memory layer might be the real product opportunity. Chat interfaces
are commoditized; persistent, self-correcting memory is not.

## Links
[[personal-agent]] · [[product-ideas]] · [[memory-systems]]
```

- **Raw** = exactly what you typed. **Cleaned** = LLM rewrite: clear, concise, your voice, no editorializing.
- **Links**: the agent scans the vault for related notes and inserts `[[wikilinks]]`. This is what builds the graph — rendered in-app and in Obsidian alike.
- **Linking discipline** (the graph is only useful if links are scarce and earned):
  - Max 2–4 links per thought, real conceptual connections only — never shared keywords.
  - Every link stores a one-line reason ("→ [[memory-systems]]: same core idea, product angle") so the graph is auditable.
  - Clusters form via **hub notes**: when several thoughts orbit one theme, the agent creates a hub and links them there instead of cross-linking all pairs. Clusters, not spaghetti.
  - Weekly review prunes links that turned out weak, same as it prunes stale tasks.
- **Recurring-thought detection:** weekly, the agent notices clusters ("4 thoughts about memory-systems this month") and surfaces them — optionally proposing a task or a hub note.

### 1.4 Calendar — auto-insert, ask-don't-guess

- Event detected → created **directly in Google Calendar**, no confirmation step needed when info is complete.
- Required fields: **title, date, start time**. Any of them missing → the agent asks. It never defaults ("I'll assume 9am") and never fabricates.
- Nice-to-haves (duration, location, attendees) get sensible defaults only where harmless (1h duration) and are flagged in the confirm line so you can correct.
- Conflict check before insert: "That overlaps your 3pm — book anyway?"
- Tasks with hard deadlines get a calendar entry too (see below).

### 1.5 Tasks — classified, then ranked

Task detection is fuzzy by design — "I should call mom" might be a task, a thought, or both. The agent decides in this order:

1. Clear action + implied commitment → task, filed silently.
2. Ambiguous → ask once: "Task or just a thought?" Your answer is remembered as a pattern ("things phrased like X → task") so the same question isn't asked twice.
3. Some items are *both*: a thought that contains an action gets filed as a thought **and** spawns a linked task.

Tasks live in the vault (`tasks.md` + Obsidian Tasks plugin format so they render as checkboxes and are queryable), ranked by a simple score:

| Factor | Signal |
|---|---|
| Urgency | deadline proximity, your words ("asap", "before Friday") |
| Importance | linked project, stakes, how often you mention it |
| Age | stale tasks decay downward and get resurfaced monthly: do / keep / kill |

Rendered as an ordered list — **Top 5** (do now), **This week**, **Later**, **Waiting on someone**. Deadline tasks sync to Google Calendar. The ranking is the agent's opinion; you can override any position and the override is remembered.

### 1.6 Memory & learning (the "feels like RL" part)

Not model training — a feedback loop over files, which behaviorally converges the same way:

- `memory/agent-rules.md` — the routing rules + everything learned: your phrasing patterns, classification corrections, ranking overrides, people, projects, preferences.
- **Every correction is logged** with the context it happened in, then generalized into a rule at the weekly consolidation ("Charles's 'maybe I should X' = thought, not task, unless a date is attached").
- **Weekly self-review** (scheduled): the agent rereads its week — misclassifications, questions it had to ask, your overrides — and rewrites its own rules. This is the reward signal → policy update loop, implemented in plain text you can read and edit.

---

## 2. Architecture — the parts

```
┌─────────────────────────────────────────────────────┐
│  INTERFACE — one clean chat box (web app)            │
│  type → send → one-line confirmations + questions    │
│  quick tabs: Thoughts · Tasks · Calendar             │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP/WebSocket
┌──────────────────────▼──────────────────────────────┐
│  GATEWAY (OpenClaw, local daemon)                    │
│  auth, sessions, channel routing, scheduled jobs     │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  ORCHESTRATOR AGENT (the brain)                      │
│  system prompt = guardrails + memory/agent-rules.md  │
│  runs the pipeline, decides when to ask questions    │
├─────────┬───────────┬───────────┬───────────────────┤
│Classifier│ Thought   │ Calendar  │ Task              │
│(split +  │ processor │ agent     │ agent             │
│label +   │(raw+clean │(GCal API, │(detect, rank,     │
│confidence)│+wikilinks)│ask-first) │dedupe, decay)     │
├─────────┴───────────┴───────────┴───────────────────┤
│  MEMORY AGENT — logs corrections, weekly             │
│  consolidation, rewrites agent-rules.md              │
└─────────┬───────────────────────┬───────────────────┘
          │                       │
┌─────────▼─────────┐   ┌─────────▼─────────┐
│ OBSIDIAN VAULT     │   │ GOOGLE CALENDAR   │
│ (git repo, local)  │   │ (API/connector)   │
│ thoughts/ notes/   │   │ events, deadlines │
│ tasks.md memory/   │   │                   │
└────────────────────┘   └───────────────────┘
```

### Component details

**Interface.** A single-page web app, Claude/ChatGPT aesthetic: centered input box, message stream above showing only your entries + the agent's one-line confirmations and questions. Three tabs or sidebar links: Thoughts (recent thoughts + graph), Tasks (the ranked list, live), Calendar (agenda view). Keyboard-first: `Cmd+Enter` send, `u` undo last filing. No settings pages, no clutter — the agent *is* the settings, you tell it what to change.

**Build vs. integrate (interface strategy).** One app, thin views, open data underneath — no required extra downloads:

- *Thoughts/graph — build.* Obsidian can't be embedded (closed source), but its value is the open format, not the app. Render the graph in-app from the wikilinks with a JS library (force-graph / cytoscape.js) — same visual, same data. "Your data is a full Obsidian vault" becomes an optional power feature, not a dependency.
- *Tasks — build.* A ranked checklist is the simplest UI of the three; owning it keeps ranking, clarification, and undo in one place. A third-party task app would add an account + sync + app for no gain.
- *Calendar — integrate.* Never rebuild a calendar. In-app agenda view (today + 7 days) via the GCal API covers most glances; deep-link to Google Calendar for full editing; official GCal iframe embed available if a month view is wanted cheaply.

The file format *is* the integration layer: anything that reads markdown interoperates, and the app stays self-sufficient.

**Gateway (OpenClaw).** Always-on local daemon. Hosts the web UI, holds API keys, runs scheduled jobs (morning brief, weekly consolidation), and optionally adds capture channels later (Telegram/WhatsApp → same pipeline) so you can dump thoughts from your phone. Follow OpenClaw's security runbook before exposing anything beyond localhost/Tailscale.

**Orchestrator.** One Claude call per message with the full rule file in context, using tools (vault read/write, GCal, ask-user). Sub-agents are logical roles inside the orchestration, not necessarily separate processes — start simple (one prompt, tool calls), split into real sub-agents only if quality demands it.

**Vault layout:**

```
vault/
├── thoughts/            # one note per thought (raw + cleaned + links)
├── notes/               # topic notes, people, projects, hub notes (MOCs)
├── tasks.md             # ranked list, Obsidian Tasks format
├── calendar-mirror.md   # next 2 weeks, read-only convenience
├── memory/
│   ├── agent-rules.md   # guardrails + learned rules (the "policy")
│   └── corrections.log  # every correction, raw, for weekly consolidation
├── inbox.md             # fallback buffer if anything ever fails to route
└── archive/
```

Obsidian is just a viewer on this folder — graph view, backlinks, and Tasks queries all work out of the box. The agent never needs Obsidian running; it writes files.

---

## 3. Build plan — small parts, in order

Each phase is independently useful; you get value from week one.

**Phase 0 — Foundation (a day).**
Create the vault skeleton + git repo. Write `agent-rules.md` v1: the guardrails from §1.2 and initial routing rules. Point Obsidian at the folder. *Done when: vault opens in Obsidian, rules file reads clean.*

**Phase 1 — Thought pipeline (the core, ~a weekend).**
Capture → classify → raw+clean thought notes with wikilinks. Text-only interface for now (Cowork chat or CLI is fine). *Done when: you dump 10 messy thoughts and each becomes a proper note, linked, with your raw words intact, and the graph shows structure.*

**Phase 2 — Calendar (~2 evenings).**
Google Calendar API wired in. Ask-don't-guess enforced with test cases: "dinner thursday" must trigger a question, "dinner thursday 8pm with Marc" must auto-insert. Conflict detection. *Done when: 10 event phrasings behave correctly, zero fabricated fields.*

**Phase 3 — Tasks (~2 evenings).**
Task detection incl. the "task or thought?" question, ranking score, tasks.md rendering, deadline→calendar sync, weekly decay/resurface job. *Done when: mixed dumps (thought+task+event in one message) split and route correctly.*

**Phase 4 — Interface (~a weekend).**
The chat box web app + tabs, served by the OpenClaw gateway. Undo command. *Done when: you stop opening anything else to capture.*

**Phase 5 — Memory loop (~ongoing, wire-up is an evening).**
corrections.log, weekly self-review job that rewrites agent-rules.md (with a git diff you can review), recurring-thought detection, morning briefing. *Done when: the same mistake stops happening twice.*

**Phase 6 — Open source & polish.**
Public repo = template (vault skeleton, rules, prompts, UI, setup script — MIT); your private vault lives in a separate repo, never published. README, docs, demo GIF. Optional: phone capture channel via Telegram. *Done when: a stranger can clone and run it in 15 minutes.*

### Repo structure

```
Synapse/
├── README.md
├── LICENSE (MIT)
├── prompts/               # orchestrator + sub-agent prompts, guardrails
├── vault-template/        # empty skeleton with example notes
├── ui/                    # the chat box web app
├── gateway/               # OpenClaw config + install script
├── integrations/gcal/     # calendar tool
└── docs/
```

---

## 4. Risks & honest notes

- **Confident misclassification.** "Ask when unsure" catches errors the agent *knows* it might make; the residual risk is mistakes made with high confidence — no question gets asked because the agent doesn't know it's wrong. Mitigation: start the confidence threshold high (more questions, near-zero errors), lower it as `agent-rules.md` matures; every confident mistake you correct becomes a rule that kills that error class.
- **Don't over-engineer sub-agents.** One well-prompted orchestrator with tools beats five chatty agents. Split only when a measured quality problem demands it.
- **Cost:** every capture is a model call. With Haiku-class models for classification and a bigger model only for cleaning/linking, this stays cheap; still, meter it in week one.
- **"RL" is memory, not training.** Restated to keep expectations honest: the agent improves by rewriting its own rule file from your corrections. That's the right tool for this job.
