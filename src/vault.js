import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ---------- helpers ----------

export function slugify(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}

export function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function timeStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${dateStamp(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- vault ----------

export class Vault {
  constructor(root) {
    this.root = root;
    if (!fs.existsSync(path.join(root, "memory", "agent-rules.md"))) {
      throw new Error(
        `No vault at ${root} (memory/agent-rules.md missing). Run: npm run init`
      );
    }
  }

  p(...parts) {
    return path.join(this.root, ...parts);
  }

  readRules() {
    return fs.readFileSync(this.p("memory", "agent-rules.md"), "utf8");
  }

  /** Guardrail #2: raw words are persisted before anything else happens. */
  capture(rawMessage) {
    const dir = this.p("archive");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "capture.log"),
      `\n[${timeStamp()}]\n${rawMessage}\n`
    );
  }

  /** Titles of all existing notes, for the linker's context. */
  index() {
    const entries = [];
    for (const dir of ["thoughts", "notes"]) {
      const full = this.p(dir);
      if (!fs.existsSync(full)) continue;
      for (const f of fs.readdirSync(full)) {
        if (!f.endsWith(".md")) continue;
        const name = f.replace(/\.md$/, "");
        const head = fs.readFileSync(path.join(full, f), "utf8").slice(0, 400);
        const isHub = /^type:\s*hub/m.test(head);
        entries.push({ name, dir, isHub });
      }
    }
    return entries;
  }

  writeThought({ title, raw, cleaned, tags = [], links = [] }) {
    const dir = this.p("thoughts");
    fs.mkdirSync(dir, { recursive: true });
    let base = `${dateStamp()}-${slugify(title)}`;
    let file = path.join(dir, `${base}.md`);
    for (let i = 2; fs.existsSync(file); i++) {
      file = path.join(dir, `${base}-${i}.md`);
    }
    const linkLines = links.length
      ? links.map((l) => `- [[${l.target}]]: ${l.reason}`).join("\n")
      : "_(no links earned yet)_";
    const body = `---
date: ${timeStamp()}
type: thought
tags: [${tags.join(", ")}]
---

## Raw

${raw}

## Cleaned

${cleaned}

## Links

${linkLines}
`;
    fs.writeFileSync(file, body);
    const noteName = path.basename(file, ".md");
    for (const l of links) this.linkIntoHub(l, noteName);
    return noteName;
  }

  /** Create a new hub when proposed; append a backlink when the hub exists. */
  linkIntoHub(link, thoughtName) {
    const hubPath = this.p("notes", `${slugify(link.target)}.md`);
    if (link.isNewHub && !fs.existsSync(hubPath)) {
      fs.mkdirSync(this.p("notes"), { recursive: true });
      fs.writeFileSync(
        hubPath,
        `---
type: hub
tags: []
---

# ${link.target}

## Thoughts on this theme

- [[${thoughtName}]]
`
      );
      return;
    }
    if (fs.existsSync(hubPath)) {
      const txt = fs.readFileSync(hubPath, "utf8");
      if (
        /## Thoughts on this theme/.test(txt) &&
        !txt.includes(`[[${thoughtName}]]`)
      ) {
        fs.writeFileSync(hubPath, txt.trimEnd() + `\n- [[${thoughtName}]]\n`);
      }
    }
  }

  // (task writing lives in tasks.js — the ranking engine owns tasks.md)

  appendTopicNote({ topic, cleaned }) {
    const dir = this.p("notes");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${slugify(topic)}.md`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `---\ntype: note\ntags: []\n---\n\n# ${topic}\n`);
    }
    fs.appendFileSync(file, `\n- ${cleaned} _(added ${dateStamp()})_\n`);
    return slugify(topic);
  }

  /** Lightweight local mirror of booked events (GCal is the source of truth). */
  appendCalendarMirror(line) {
    const file = this.p("calendar-mirror.md");
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, "# Calendar — booked by Synapse\n");
    }
    fs.appendFileSync(file, `${line}\n`);
  }

  /** Fallback buffer: anything not routable yet lands here, never dropped. */
  appendInbox(label, raw) {
    fs.appendFileSync(
      this.p("inbox.md"),
      `\n- **[${label}]** ${raw} _(captured ${timeStamp()})_\n`
    );
  }

  // ---------- git: every write is one commit; undo = revert last ----------

  git(...args) {
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8" });
  }

  ensureRepo() {
    try {
      this.git("rev-parse", "--git-dir");
    } catch {
      this.git("init");
      this.git("add", "-A");
      this.git("commit", "-m", "synapse: vault initialized");
    }
  }

  commit(message) {
    this.ensureRepo();
    this.git("add", "-A");
    try {
      this.git("commit", "-m", message);
    } catch (e) {
      if (!String(e.stdout || e.message).includes("nothing to commit")) throw e;
    }
  }

  undoLast() {
    this.ensureRepo();
    const last = this.git("log", "-1", "--pretty=%s").trim();
    if (!last.startsWith("synapse:")) {
      return { ok: false, reason: `Last commit isn't mine ("${last}") — undo manually.` };
    }
    this.git("revert", "--no-edit", "HEAD");
    return { ok: true, reverted: last };
  }
}
