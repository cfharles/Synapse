// The memory loop: what makes month 3 smoother than week 1.
// Corrections and clarification answers are logged as raw material; the
// `review` command generalizes them into rules inside agent-rules.md.
// Behaviorally it's the learning loop; technically it's plain text + git.

import fs from "node:fs";
import { dateStamp, timeStamp } from "./vault.js";
import { complete } from "./llm.js";
import { listRanked, parseTasks } from "./tasks.js";

const LOG = ["memory", "corrections.log"];
const RULES = ["memory", "agent-rules.md"];

// ---------- capture the learning signal ----------

export function logCorrection(vault, text) {
  fs.appendFileSync(vault.p(...LOG), `[${timeStamp()}] CORRECTION | ${text}\n`);
}

export function logClarification(vault, { q, a }) {
  fs.appendFileSync(vault.p(...LOG), `[${timeStamp()}] QA | Q: ${q} | A: ${a}\n`);
}

// ---------- recurring-thought detection ----------

/** Themes (tags + link targets) mentioned in ≥3 thoughts over the last 30 days. */
export function recurring(vault, minCount = 3, days = 30) {
  const dir = vault.p("thoughts");
  if (!fs.existsSync(dir)) return [];
  const cutoff = Date.now() - days * 86_400_000;
  const counts = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const txt = fs.readFileSync(vault.p("thoughts", f), "utf8");
    const date = (txt.match(/^date: (\d{4}-\d{2}-\d{2})/m) || [])[1];
    if (date && new Date(date).getTime() < cutoff) continue;
    const tags = (txt.match(/^tags: \[(.*)\]$/m) || [, ""])[1]
      .split(",").map((s) => s.trim()).filter(Boolean);
    const links = [...txt.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
    for (const theme of new Set([...tags, ...links])) {
      counts[theme] = (counts[theme] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1])
    .map(([theme, n]) => ({ theme, count: n }));
}

// ---------- the self-review ----------

/**
 * Reads corrections.log, generalizes entries into rules, rewrites
 * agent-rules.md (git-committed so the diff is reviewable), archives the log.
 */
export async function review(vault, cfg) {
  const logPath = vault.p(...LOG);
  const rulesPath = vault.p(...RULES);
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  const entries = log.split("\n").filter((l) => l.startsWith("["));
  const themes = recurring(vault);

  if (entries.length === 0 && themes.length === 0) {
    return { updated: false, summary: "Nothing to learn yet: no corrections, no recurring themes." };
  }
  if (entries.length === 0) {
    return { updated: false, summary: "No corrections to learn from this time.", themes };
  }

  let rules = fs.readFileSync(rulesPath, "utf8");

  if (process.env.SYNAPSE_MOCK === "1") {
    // Deterministic generalization for tests: one pattern line per entry.
    const lines = entries.map((e) => {
      const qa = e.match(/QA \| Q: (.*) \| A: (.*)$/);
      if (qa) return `- When asked "${qa[1]}", the user answered "${qa[2]}" (learned ${dateStamp()})`;
      const corr = e.match(/CORRECTION \| (.*)$/);
      return `- ${corr ? corr[1] : e} (correction ${dateStamp()})`;
    });
    rules = addPatterns(rules, lines);
  } else {
    // Real mode: the model rewrites ONLY the learned sections, full file out.
    rules = await complete({
      cfg,
      system:
        "You maintain the rules file of a personal organizing agent. You will " +
        "receive the current agent-rules.md, a log of corrections and " +
        "clarification answers, and recurring thought themes. Generalize the " +
        "log into concise reusable rules under '## Learned patterns' and update " +
        "'## About the user' if warranted. NEVER touch the guardrails section. " +
        "Keep every rule short, dated, and general enough to prevent repeat " +
        "questions. Respond with ONLY the complete updated file, no fences.",
      user:
        `CURRENT FILE:\n${rules}\n\nLOG:\n${log}\n\nRECURRING THEMES (last 30 days):\n` +
        themes.map((t) => `- ${t.theme}: ${t.count} thoughts`).join("\n"),
    });
  }

  fs.writeFileSync(rulesPath, rules);

  // Archive the processed log so nothing is learned twice.
  if (entries.length) {
    fs.mkdirSync(vault.p("archive"), { recursive: true });
    fs.appendFileSync(vault.p("archive", `corrections-${dateStamp()}.log`), log);
    fs.writeFileSync(
      logPath,
      "# Corrections log — raw material for the weekly self-review\n"
    );
  }

  vault.commit("synapse: self-review (rules updated — check the diff)");
  return {
    updated: true,
    summary: `✓ Learned from ${entries.length} log entr${entries.length === 1 ? "y" : "ies"}. Review the diff: git -C ${vault.root} show`,
    themes,
  };
}

function addPatterns(rules, lines) {
  const heading = "## Learned patterns";
  const i = rules.indexOf(heading);
  if (i === -1) return rules + `\n${heading}\n\n${lines.join("\n")}\n`;
  const sectionEnd = rules.indexOf("\n## ", i + heading.length);
  const end = sectionEnd === -1 ? rules.length : sectionEnd;
  let section = rules.slice(i, end);
  section = section.includes("(none yet)")
    ? section.replace("(none yet)", lines.join("\n"))
    : section.trimEnd() + "\n" + lines.join("\n") + "\n";
  return rules.slice(0, i) + section + rules.slice(end);
}

// ---------- morning briefing ----------

export async function briefing(vault, cfg, calendar) {
  const out = [];
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
  out.push(`☀ ${today}`);

  if (calendar) {
    try {
      const events = await calendar.agenda(1);
      out.push(events.length ? `📅 Today:\n${events.map((e) => `   ${e}`).join("\n")}` : "📅 Today: clear.");
    } catch (e) {
      out.push(`📅 (calendar unavailable: ${e.message})`);
    }
  }

  const top = listRanked(vault).slice(0, 5);
  out.push(top.length ? `✅ Top tasks:\n${top.map((t) => `   ${t}`).join("\n")}` : "✅ No open tasks.");

  const md = fs.existsSync(vault.p("tasks.md")) ? fs.readFileSync(vault.p("tasks.md"), "utf8") : "";
  const overdue = parseTasks(md).filter(
    (t) => !t.done && t.due && t.due < dateStamp()
  ).length;
  if (overdue) out.push(`⚠ ${overdue} overdue task${overdue === 1 ? "" : "s"}.`);

  const inbox = fs.existsSync(vault.p("inbox.md"))
    ? fs.readFileSync(vault.p("inbox.md"), "utf8").split("\n").filter((l) => l.startsWith("- ")).length
    : 0;
  if (inbox) out.push(`📥 ${inbox} unresolved item${inbox === 1 ? "" : "s"} in the inbox.`);

  const themes = recurring(vault);
  if (themes.length) {
    out.push(`💭 On your mind: ${themes.slice(0, 3).map((t) => `${t.theme} (${t.count}×)`).join(", ")}`);
  }
  return out.join("\n");
}
