// Task intelligence: parse tasks.md, score every task, re-render the file
// ranked. tasks.md stays the single source of truth (Obsidian-compatible
// markdown), metadata lives inline:  📅 due · ⏫ high / 🔽 low · ➕ added
import fs from "node:fs";
import { dateStamp } from "./vault.js";

const HEADERS = {
  top5: "## Top 5",
  week: "## This week",
  later: "## Later",
  waiting: "## Waiting",
};

// ---------- parse ----------

export function parseTasks(md) {
  const tasks = [];
  let bucket = "later";
  for (const line of md.split("\n")) {
    const h = Object.entries(HEADERS).find(([, hdr]) => line.trim() === hdr);
    if (h) {
      bucket = h[0];
      continue;
    }
    const m = line.match(/^- \[( |x)\] (.*)$/);
    if (!m) continue;
    let text = m[2];
    const due = (text.match(/📅 (\d{4}-\d{2}-\d{2})/) || [])[1] || null;
    const added = (text.match(/➕ (\d{4}-\d{2}-\d{2})/) || [])[1] || null;
    const priority = text.includes("⏫") ? "high" : text.includes("🔽") ? "low" : "normal";
    text = text
      .replace(/📅 \d{4}-\d{2}-\d{2}/g, "")
      .replace(/➕ \d{4}-\d{2}-\d{2}/g, "")
      .replace(/[⏫🔽]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    tasks.push({ text, done: m[1] === "x", due, added, priority, bucket });
  }
  return tasks;
}

// ---------- score ----------

export function score(t, now = new Date()) {
  let s = 0;
  if (t.priority === "high") s += 40;
  if (t.priority === "low") s -= 20;
  if (t.due) {
    // Date-only comparison (both parse to UTC midnight → exact whole days).
    const days = Math.round((new Date(t.due) - new Date(dateStamp(now))) / 86_400_000);
    if (days < 0) s += 100; // overdue: screaming
    else if (days === 0) s += 50;
    else if (days <= 2) s += 30;
    else if (days <= 7) s += 15;
  }
  if (t.added && !t.due) {
    const age = Math.floor((now - new Date(t.added)) / 86_400_000);
    if (age > 30) s -= 10; // stale, decays downward
  }
  return s;
}

// ---------- render (ranked) ----------

function taskLine(t) {
  const meta =
    (t.due ? ` 📅 ${t.due}` : "") +
    (t.priority === "high" ? " ⏫" : t.priority === "low" ? " 🔽" : "") +
    (t.added ? ` ➕ ${t.added}` : "");
  return `- [${t.done ? "x" : " "}] ${t.text}${meta}`;
}

export function render(tasks, now = new Date()) {
  const open = tasks.filter((t) => !t.done);
  const waiting = open.filter((t) => t.bucket === "waiting");
  const rankable = open
    .filter((t) => t.bucket !== "waiting")
    .sort((a, b) => score(b, now) - score(a, now));

  const top5 = rankable.slice(0, 5).filter((t) => score(t, now) > 0);
  const rest = rankable.filter((t) => !top5.includes(t));
  const week = rest.filter(
    (t) => score(t, now) >= 15 || (t.due && new Date(t.due) - now < 7 * 86_400_000)
  );
  const later = rest.filter((t) => !week.includes(t));

  const section = (hdr, list) =>
    `${hdr}\n${list.length ? list.map(taskLine).join("\n") : ""}\n`;

  return (
    `# Tasks\n\n` +
    section(HEADERS.top5, top5) +
    `\n` +
    section(HEADERS.week, week) +
    `\n` +
    section(HEADERS.later, later) +
    `\n` +
    section(HEADERS.waiting, waiting) +
    `\n<!-- Ranked by Synapse: urgency (📅 proximity) + importance (⏫/🔽) - age decay.\n` +
    `     Edit freely; the next resort respects your text and metadata. -->\n`
  );
}

// ---------- operations ----------

function readMd(vault) {
  const f = vault.p("tasks.md");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "# Tasks\n";
}

const normText = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Add a task and re-rank the whole file. Returns { bucket, duplicate }. */
export function addTask(vault, { cleaned, due = null, priority = "normal", bucket = null }) {
  const tasks = parseTasks(readMd(vault));
  // Dedupe: the same task phrased the same way is filed once.
  const dup = tasks.find(
    (t) => !t.done && (normText(t.text) === normText(cleaned) ||
      normText(t.text).includes(normText(cleaned)) || normText(cleaned).includes(normText(t.text)))
  );
  if (dup) return { bucket: null, duplicate: true, existing: dup.text };
  tasks.push({
    text: cleaned,
    done: false,
    due,
    added: dateStamp(),
    priority,
    bucket: bucket === "waiting" ? "waiting" : "later", // rank decides the rest
  });
  const md = render(tasks);
  fs.writeFileSync(vault.p("tasks.md"), md);
  if (bucket === "waiting") return { bucket: "waiting", duplicate: false };
  const line = md.split("\n").find((l) => l.includes(cleaned));
  const before = md.slice(0, md.indexOf(line));
  let landed = "top5";
  if (before.includes(HEADERS.later)) landed = "later";
  else if (before.includes(HEADERS.week)) landed = "week";
  return { bucket: landed, duplicate: false };
}

/** Complete a task from the UI: archive it immediately with today's date. */
export function completeTask(vault, text) {
  const tasks = parseTasks(readMd(vault));
  const t = tasks.find((x) => !x.done && x.text === text);
  if (!t) return false;
  fs.mkdirSync(vault.p("archive"), { recursive: true });
  fs.appendFileSync(
    vault.p("archive", "done-tasks.md"),
    `- [x] ${t.text} ✅ ${dateStamp()}\n`
  );
  fs.writeFileSync(vault.p("tasks.md"), render(tasks.filter((x) => x !== t)));
  return true;
}

/** Re-rank in place (run any time; cheap and idempotent). */
export function resort(vault) {
  fs.writeFileSync(vault.p("tasks.md"), render(parseTasks(readMd(vault))));
}

/** Ranked list with scores, for the CLI. */
export function listRanked(vault) {
  const now = new Date();
  return parseTasks(readMd(vault))
    .filter((t) => !t.done)
    .sort((a, b) => score(b, now) - score(a, now))
    .map((t) => {
      const s = score(t, now);
      return `${String(s).padStart(4)}  ${t.bucket === "waiting" ? "⏸ " : ""}${t.text}${t.due ? ` (due ${t.due})` : ""}`;
    });
}

/**
 * Weekly hygiene: archive done tasks, re-rank, surface stale ones.
 * Returns { archived, stale } for the confirmation line.
 */
export function cleanup(vault) {
  const now = new Date();
  const tasks = parseTasks(readMd(vault));
  const done = tasks.filter((t) => t.done);
  const open = tasks.filter((t) => !t.done);

  if (done.length) {
    const archDir = vault.p("archive");
    fs.mkdirSync(archDir, { recursive: true });
    fs.appendFileSync(
      vault.p("archive", "done-tasks.md"),
      done.map((t) => `- [x] ${t.text} ✅ ${dateStamp(now)}`).join("\n") + "\n"
    );
  }

  const stale = open.filter(
    (t) => !t.due && t.added && (now - new Date(t.added)) / 86_400_000 > 30
  );

  fs.writeFileSync(vault.p("tasks.md"), render(open, now));
  return { archived: done.length, stale: stale.map((t) => t.text) };
}
