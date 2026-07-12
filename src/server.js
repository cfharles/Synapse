// The Synapse web UI server. Localhost-only, zero dependencies.
// Serves ui/index.html and a small JSON API over the same pipeline the CLI uses.
//
//   npm run ui   →   http://127.0.0.1:8377

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { Vault, slugify } from "./vault.js";
import { processMessage } from "./pipeline.js";
import { getCalendar } from "./gcal.js";
import { parseTasks, score } from "./tasks.js";
import { briefing } from "./memory.js";

const PORT = Number(process.env.SYNAPSE_PORT || 8377);
const cfg = loadConfig();
let vault;
try {
  vault = new Vault(cfg.vaultPath);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// ---------- chat sessions (the ask-don't-guess flow over HTTP) ----------
// A message may trigger a clarifying question mid-pipeline. We hold the
// pipeline's promise open and resolve it when the answer arrives.

const sessions = new Map();

function startSession(text) {
  const id = crypto.randomUUID();
  const s = { id, question: null, waiter: null, resolveAnswer: null, confirmations: [] };
  const io = {
    ask: (q) =>
      new Promise((resolve) => {
        s.resolveAnswer = resolve;
        const payload = { question: q, id };
        if (s.waiter) {
          s.waiter(payload);
          s.waiter = null;
        } else {
          s.question = payload;
        }
      }),
    say: (line) => s.confirmations.push(line),
  };
  s.done = processMessage(text, { vault, cfg, io })
    .then(() => ({ confirmations: s.confirmations, id, done: true }))
    .catch((e) => ({ error: e.message, id, done: true }));
  sessions.set(id, s);
  return s;
}

function nextEvent(s) {
  return Promise.race([
    s.done,
    new Promise((resolve) => {
      if (s.question) {
        resolve(s.question);
        s.question = null;
      } else {
        s.waiter = resolve;
      }
    }),
  ]).then((ev) => {
    if (ev.done) sessions.delete(s.id);
    return ev;
  });
}

// ---------- read-model endpoints ----------

function thoughtsList() {
  const dir = vault.p("thoughts");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, 30)
    .map((f) => {
      const txt = fs.readFileSync(path.join(dir, f), "utf8");
      const date = (txt.match(/^date: (.*)$/m) || [])[1] || "";
      const cleaned = (txt.split(/## Cleaned\s*/)[1] || "").split(/\n## /)[0].trim();
      const links = [...txt.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
      return { name: f.replace(/\.md$/, ""), date, cleaned, links };
    });
}

function graphData() {
  const nodes = new Map();
  const edges = [];
  const addNode = (id, type) => {
    if (!nodes.has(id) || type === "hub") nodes.set(id, { id, type });
  };
  for (const dir of ["thoughts", "notes"]) {
    const full = vault.p(dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith(".md")) continue;
      const name = f.replace(/\.md$/, "");
      const txt = fs.readFileSync(path.join(full, f), "utf8");
      const isHub = /^type:\s*hub/m.test(txt.slice(0, 300));
      addNode(name, dir === "thoughts" ? "thought" : isHub ? "hub" : "note");
      for (const m of txt.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const target = slugify(m[1]);
        addNode(target, "note");
        if (target !== name) edges.push({ source: name, target });
      }
    }
  }
  // Dedupe edges (hub backlinks mirror thought links).
  const seen = new Set();
  const uniq = edges.filter((e) => {
    const k = [e.source, e.target].sort().join("→");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { nodes: [...nodes.values()], edges: uniq };
}

function tasksList() {
  const f = vault.p("tasks.md");
  const md = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  const now = new Date();
  return parseTasks(md)
    .filter((t) => !t.done)
    .map((t) => ({ ...t, score: score(t, now) }))
    .sort((a, b) => b.score - a.score);
}

async function agendaList() {
  const cal = getCalendar(cfg, vault);
  if (cal) {
    try {
      return { source: "google", events: await cal.agenda(7) };
    } catch (e) {
      return { source: "error", events: [], error: e.message };
    }
  }
  const f = vault.p("calendar-mirror.md");
  const lines = fs.existsSync(f)
    ? fs.readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("- "))
    : [];
  return { source: "mirror", events: lines.map((l) => l.slice(2)) };
}

// ---------- http ----------

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function body(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

const uiPath = path.join(cfg.repoRoot, "ui", "index.html");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /":
        res.writeHead(200, { "content-type": "text/html" });
        res.end(fs.readFileSync(uiPath, "utf8"));
        return;
      case "POST /api/message": {
        const { text } = await body(req);
        if (!text?.trim()) return json(res, 400, { error: "empty message" });
        return json(res, 200, await nextEvent(startSession(text.trim())));
      }
      case "POST /api/answer": {
        const { id, answer } = await body(req);
        const s = sessions.get(id);
        if (!s?.resolveAnswer) return json(res, 404, { error: "no pending question" });
        const resolve = s.resolveAnswer;
        s.resolveAnswer = null;
        resolve(answer ?? "");
        return json(res, 200, await nextEvent(s));
      }
      case "POST /api/undo": {
        const r = vault.undoLast();
        return json(res, 200, r);
      }
      case "GET /api/thoughts":
        return json(res, 200, thoughtsList());
      case "GET /api/graph":
        return json(res, 200, graphData());
      case "GET /api/tasks":
        return json(res, 200, tasksList());
      case "GET /api/agenda":
        return json(res, 200, await agendaList());
      case "GET /api/brief":
        return json(res, 200, { text: await briefing(vault, cfg, getCalendar(cfg, vault)) });
      default:
        return json(res, 404, { error: "not found" });
    }
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

// Localhost only, deliberately: exposing this needs auth first (see docs).
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Synapse UI → http://127.0.0.1:${PORT}`);
});
