#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";
import { loadConfig } from "./config.js";
import { Vault } from "./vault.js";
import { processMessage } from "./pipeline.js";
import { GoogleCalendar, getCalendar } from "./gcal.js";
import { listRanked, cleanup } from "./tasks.js";
import { review, briefing } from "./memory.js";

const cfg = loadConfig();
let vault;
try {
  vault = new Vault(cfg.vaultPath);
} catch (e) {
  console.error(e.message);
  exit(1);
}

const rl = readline.createInterface({ input: stdin, output: stdout });
const io = {
  ask: (q) => rl.question(`❓ ${q}\n> `),
  say: (line) => console.log(line),
};

const oneShot = argv.slice(2).join(" ").trim();

if (oneShot === "auth-gcal") {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (docs/gcal-setup.md)");
    exit(1);
  }
  await new GoogleCalendar(cfg).authFlow();
  rl.close();
} else if (oneShot === "agenda") {
  const cal = getCalendar(cfg, vault);
  if (!cal) {
    console.log("Calendar not configured (docs/gcal-setup.md)");
  } else {
    const lines = await cal.agenda(7);
    console.log(lines.length ? lines.join("\n") : "Next 7 days: nothing booked.");
  }
  rl.close();
} else if (oneShot === "brief") {
  console.log(await briefing(vault, cfg, getCalendar(cfg, vault)));
  rl.close();
} else if (oneShot === "review") {
  const r = await review(vault, cfg);
  console.log(r.summary);
  if (r.themes?.length) {
    console.log("\nRecurring themes (last 30 days):");
    for (const t of r.themes) console.log(`  · ${t.theme} (${t.count} thoughts) — want a hub note or a task?`);
  }
  rl.close();
} else if (oneShot === "tasks") {
  const lines = listRanked(vault);
  console.log(lines.length ? "score  task\n" + lines.join("\n") : "No open tasks.");
  rl.close();
} else if (oneShot === "cleanup") {
  const { archived, stale } = cleanup(vault);
  vault.commit("synapse: cleanup (archive done, re-rank)");
  console.log(`✓ Archived ${archived} done task${archived === 1 ? "" : "s"}, re-ranked the rest.`);
  if (stale.length) {
    console.log(`\nStale (>30 days, no deadline) — do, keep, or kill?`);
    for (const s of stale) console.log(`  · ${s}`);
  }
  rl.close();
} else if (oneShot === "undo") {
  const r = vault.undoLast();
  console.log(r.ok ? `↩ Reverted: ${r.reverted}` : r.reason);
  rl.close();
} else if (oneShot) {
  await processMessage(oneShot, { vault, cfg, io });
  rl.close();
} else {
  console.log('Synapse. Dump anything. "undo" reverts, "quit" exits.\n');
  for (;;) {
    const msg = (await rl.question("💭 ")).trim();
    if (!msg) continue;
    if (msg === "quit" || msg === "exit") break;
    if (msg === "undo") {
      const r = vault.undoLast();
      console.log(r.ok ? `↩ Reverted: ${r.reverted}` : r.reason);
      continue;
    }
    try {
      await processMessage(msg, { vault, cfg, io });
    } catch (e) {
      console.error(`⚠ ${e.message} — your words are safe in archive/capture.log`);
    }
  }
  rl.close();
}
