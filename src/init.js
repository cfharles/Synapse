#!/usr/bin/env node
// Copies vault-template/ to your private vault path and git-inits it.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const template = path.join(cfg.repoRoot, "vault-template");

if (!fs.existsSync(template)) {
  console.error(`vault-template/ not found in ${cfg.repoRoot}`);
  process.exit(1);
}
if (fs.existsSync(path.join(cfg.vaultPath, "memory", "agent-rules.md"))) {
  console.log(`Vault already exists at ${cfg.vaultPath} — nothing to do.`);
  process.exit(0);
}

fs.cpSync(template, cfg.vaultPath, { recursive: true });
execFileSync("git", ["init"], { cwd: cfg.vaultPath });
execFileSync("git", ["add", "-A"], { cwd: cfg.vaultPath });
execFileSync("git", ["commit", "-m", "synapse: vault initialized"], {
  cwd: cfg.vaultPath,
});
console.log(`✓ Vault created at ${cfg.vaultPath} (own git repo, keep it private)`);
console.log("  Point Obsidian at it, then: npm start");
