// LLM layer: one call classifies, splits, cleans, and proposes links.
// SYNAPSE_MOCK=1 uses a deterministic heuristic instead (for tests / offline).

const API_URL = "https://api.anthropic.com/v1/messages";

function systemPrompt(rules, vaultIndex, cfg) {
  const noteList = vaultIndex
    .map((n) => `- ${n.name}${n.isHub ? " (hub)" : ""}`)
    .join("\n");
  return `You are Synapse, a personal organizing agent. Obey these rules absolutely:

${rules}

You receive one user message. Respond with ONLY valid JSON, no prose, matching:

{
  "items": [
    {
      "type": "thought" | "task" | "event" | "note" | "correction" | "unclear",
      "confidence": 0.0-1.0,
      "raw": "the exact words of the user for this item, verbatim",
      "question": null | "ONE short clarifying question",
      "title": "3-6 word title",
      "cleaned": "clear, concise rewrite in the user's voice, no editorializing",
      "tags": ["lowercase", "topic", "tags"],
      "links": [{ "target": "existing-note-or-new-hub-name", "reason": "one line", "isNewHub": false }],
      "topic": "for type=note only: topic file name",
      "task": { "due": null | "YYYY-MM-DD", "priority": "high" | "normal" | "low", "bucket": null | "waiting" },
      "event": { "date": "YYYY-MM-DD", "time": "HH:MM 24h", "durationMin": null | 90, "location": null, "attendees": [] }
    }
  ]
}

Current date/time: ${new Date().toString()} — resolve relative dates ("thursday",
"tomorrow") against this. A weekday with no other qualifier means the NEXT
occurrence of that weekday.

Rules for this call:
- Split the message into separate items when it contains several.
- "raw" must be the user's exact words. Never paraphrase inside "raw".
- links: at most ${cfg.maxLinks}, real conceptual connections only, never shared
  keywords. Prefer existing notes/hubs from the list below. Propose isNewHub=true
  only when this thought clearly starts or joins a theme with no home yet.
- If a required event field (title, date, start time) is missing, or the item is
  ambiguous, set "question". NEVER guess. NEVER invent dates or times.
- task.priority: "high" only for real urgency in the user's words ("asap",
  "urgent", "must"). task.bucket: "waiting" only when blocked on someone else;
  otherwise null (the ranking engine places it).
- "correction": the user is telling you a previous filing or behavior was wrong
  ("no, that was...", "actually...", "stop doing..."). cleaned = one concise
  statement of what should change. Corrections become permanent rules.
- If prior clarifying answers are provided, use them and do not re-ask.

Existing notes in the vault:
${noteList || "- (empty vault)"}`;
}

/** Generic completion, shared by classify and the self-review. */
export async function complete({ system, user, cfg }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example)");
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}

export async function classify({ message, rules, vaultIndex, cfg, qa = [] }) {
  if (process.env.SYNAPSE_MOCK === "1") return mockClassify(message, qa);

  const userContent =
    qa.length === 0
      ? message
      : `${message}\n\nClarifying answers:\n${qa
          .map((x) => `Q: ${x.q}\nA: ${x.a}`)
          .join("\n")}`;

  const text = await complete({
    system: systemPrompt(rules, vaultIndex, cfg),
    user: userContent,
    cfg,
  });
  const json = text.replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(json);
}

// ---------- deterministic mock (tests only) ----------

function mockClassify(message, qa) {
  const parts = message
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const items = parts.map((raw) => {
    const lower = raw.toLowerCase();
    const answered = qa.length > 0;
    if (/^(no,|actually|that was|stop )/i.test(raw)) {
      return {
        type: "correction", confidence: 0.9, raw, question: null,
        title: raw.slice(0, 30), cleaned: raw, tags: [], links: [],
      };
    }
    if (/\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\btomorrow\b/.test(lower)) {
      const timeSrc = answered ? `${lower} ${qa[qa.length - 1].a.toLowerCase()}` : lower;
      const time = mockParseTime(timeSrc);
      return {
        type: "event",
        confidence: 0.9,
        raw,
        question: time ? null : "What time?",
        title: raw.slice(0, 30),
        cleaned: raw,
        tags: [],
        links: [],
        event: { date: mockParseDate(lower), time, durationMin: null, location: null, attendees: [] },
      };
    }
    if (/^(todo|need to|gotta|must)\b/i.test(raw)) {
      const due = (raw.match(/by (\d{4}-\d{2}-\d{2})/) || [])[1] || null;
      return {
        type: "task", confidence: 0.9, raw, question: null,
        title: raw.slice(0, 30),
        cleaned: raw.replace(/^(todo:?\s*)/i, "").replace(/\s*by \d{4}-\d{2}-\d{2}/, ""),
        tags: [], links: [],
        task: {
          due,
          priority: /asap|urgent/i.test(raw) ? "high" : "normal",
          bucket: /waiting/i.test(raw) ? "waiting" : null,
        },
      };
    }
    if (/^remember\b/i.test(raw)) {
      return {
        type: "note", confidence: 0.9, raw, question: null,
        title: raw.slice(0, 30), cleaned: raw.replace(/^remember:?\s*/i, ""),
        tags: [], links: [], topic: "general",
      };
    }
    if (/should maybe|maybe i should/.test(lower) && !answered) {
      return {
        type: "unclear", confidence: 0.4, raw,
        question: "Task or just a thought?",
        title: raw.slice(0, 30), cleaned: raw, tags: [], links: [],
      };
    }
    return {
      type: answered && /task/i.test(qa[qa.length - 1].a) ? "task" : "thought",
      confidence: 0.95, raw, question: null,
      title: raw.split(/\s+/).slice(0, 5).join(" "),
      cleaned: raw.charAt(0).toUpperCase() + raw.slice(1),
      tags: ["mock"],
      links: [{ target: "example-hub", reason: "mock link for testing", isNewHub: false }],
      task: { due: null, bucket: "week" },
    };
  });
  return { items };
}

function mockParseTime(s) {
  const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${m[2] || "00"}`;
}

function mockParseDate(s) {
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const d = new Date();
  if (/\btomorrow\b/.test(s)) {
    d.setDate(d.getDate() + 1);
  } else {
    const target = days.findIndex((day) => s.includes(day));
    if (target >= 0) {
      let diff = (target - d.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      d.setDate(d.getDate() + diff);
    }
  }
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
