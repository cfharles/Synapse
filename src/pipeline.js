import { classify } from "./llm.js";
import { getCalendar } from "./gcal.js";
import { addTask } from "./tasks.js";
import { logCorrection, logClarification } from "./memory.js";

/**
 * The pipeline: capture → split/classify → clarify → clean → route → confirm.
 * io = { ask: async (question) => answer, say: (line) => void }
 */
export async function processMessage(message, { vault, cfg, io }) {
  const calendar = getCalendar(cfg, vault);
  // 1. Capture verbatim before anything else (guardrail #2).
  vault.capture(message);

  const rules = vault.readRules();
  const vaultIndex = vault.index();

  // 2-4. Classify; clarify in rounds while questions remain.
  const qa = [];
  let result = await classify({ message, rules, vaultIndex, cfg, qa });
  for (let round = 0; round < cfg.maxClarifyRounds; round++) {
    const pending = (result.items || []).filter(
      (it) => it.question || it.confidence < cfg.confidenceThreshold
    );
    if (pending.length === 0) break;
    for (const it of pending) {
      const q = it.question || `Is this a ${it.type}? "${it.raw}"`;
      const a = await io.ask(q);
      qa.push({ q, a });
    }
    result = await classify({ message, rules, vaultIndex, cfg, qa });
  }

  // Clarification answers are learning signal: log them for the self-review.
  for (const x of qa) logClarification(vault, x);

  // 5-6. Route each item.
  const confirmations = [];
  for (const it of result.items || []) {
    // Still unresolved after clarification → inbox, never guessed, never dropped.
    if (it.question || it.type === "unclear" || it.confidence < cfg.confidenceThreshold) {
      vault.appendInbox("UNRESOLVED", it.raw);
      confirmations.push(`→ Couldn't resolve, parked in inbox: "${trunc(it.raw)}"`);
      continue;
    }
    switch (it.type) {
      case "thought": {
        const links = (it.links || []).slice(0, cfg.maxLinks);
        const name = vault.writeThought({
          title: it.title, raw: it.raw, cleaned: it.cleaned,
          tags: it.tags || [], links,
        });
        const linkStr = links.length
          ? `, linked to ${links.map((l) => `[[${l.target}]]`).join(" ")}`
          : "";
        confirmations.push(`→ Thought filed as ${name}${linkStr}`);
        break;
      }
      case "task": {
        const due = it.task?.due || null;
        const landed = addTask(vault, {
          cleaned: it.cleaned,
          due,
          priority: it.task?.priority || "normal",
          bucket: it.task?.bucket || null,
        });
        // Hard deadlines also get an all-day calendar entry.
        let deadlineNote = "";
        if (due && calendar) {
          await calendar.create({ title: `Due: ${it.cleaned}`, date: due, time: null });
          vault.appendCalendarMirror(`- ${due} (all day) — Due: ${it.cleaned}`);
          deadlineNote = ", deadline on calendar";
        }
        const bucketNames = { top5: "Top 5", week: "This week", later: "Later", waiting: "Waiting" };
        confirmations.push(
          `→ Task ranked into ${bucketNames[landed]}${due ? ` (due ${due})` : ""}${deadlineNote}: "${trunc(it.cleaned)}"`
        );
        break;
      }
      case "note": {
        const topic = vault.appendTopicNote({ topic: it.topic || "general", cleaned: it.cleaned });
        confirmations.push(`→ Note merged into [[${topic}]]`);
        break;
      }
      case "event": {
        const ev = it.event || {};
        if (!calendar) {
          vault.appendInbox("EVENT (calendar not configured)", it.raw);
          confirmations.push(`→ Event parked in inbox (set up Google Calendar: docs/gcal-setup.md)`);
          break;
        }
        // Guardrail #1: required fields or nothing. Clarification should have
        // filled these; if not, park it — never guess a date or time.
        if (!ev.date || !ev.time) {
          vault.appendInbox("EVENT-INCOMPLETE", it.raw);
          confirmations.push(`→ Event missing date/time even after asking, parked in inbox: "${trunc(it.raw)}"`);
          break;
        }
        const durationMin = ev.durationMin || 60;
        const assumedDuration = !ev.durationMin;
        const start = new Date(`${ev.date}T${ev.time}:00`);
        const end = new Date(start.getTime() + durationMin * 60_000);
        const overlaps = await calendar.conflicts(start, end);
        if (overlaps.length > 0) {
          const a = await io.ask(`That overlaps "${overlaps[0]}". Book anyway? (y/n)`);
          if (!/^\s*y/i.test(a)) {
            vault.appendInbox("EVENT-SKIPPED (conflict)", it.raw);
            confirmations.push(`→ Not booked (conflict), parked in inbox: "${trunc(it.raw)}"`);
            break;
          }
        }
        const title = it.title || it.cleaned;
        await calendar.create({
          title, date: ev.date, time: ev.time, durationMin,
          location: ev.location || null, attendees: ev.attendees || [],
        });
        vault.appendCalendarMirror(`- ${ev.date} ${ev.time} — ${title}`);
        confirmations.push(
          `→ Event booked ${ev.date} ${ev.time}: "${trunc(title)}"${assumedDuration ? " (assumed 1h, say if wrong)" : ""}`
        );
        break;
      }
      case "correction": {
        // Guardrail #6: corrections are law. Logged now, generalized into a
        // permanent rule by the `review` command.
        logCorrection(vault, it.cleaned || it.raw);
        confirmations.push(
          `→ Correction noted, becomes a rule at the next review. ("undo" reverts the last filing if needed.)`
        );
        break;
      }
      default: {
        vault.appendInbox("UNKNOWN", it.raw);
        confirmations.push(`→ Unknown type, parked in inbox: "${trunc(it.raw)}"`);
      }
    }
  }

  // Git commit = the undo unit (guardrail #5).
  const summary = summarize(result.items || []);
  vault.commit(`synapse: ${summary}`);

  // 7. Confirm.
  for (const line of confirmations) io.say(line);
  return confirmations;
}

function summarize(items) {
  const counts = {};
  for (const it of items) counts[it.type] = (counts[it.type] || 0) + 1;
  const parts = Object.entries(counts).map(([t, n]) => `${n} ${t}${n > 1 ? "s" : ""}`);
  return parts.length ? `filed ${parts.join(", ")}` : "no-op";
}

function trunc(s, n = 50) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
