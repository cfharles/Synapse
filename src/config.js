import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
  vaultPath: "./my-vault",
  model: "claude-sonnet-5",
  confidenceThreshold: 0.8, // start high: ask often, guess never
  maxLinks: 4,
  maxClarifyRounds: 2,
};

export function loadConfig(repoRoot = process.cwd()) {
  let fileCfg = {};
  const p = path.join(repoRoot, "synapse.config.json");
  if (fs.existsSync(p)) {
    fileCfg = JSON.parse(fs.readFileSync(p, "utf8"));
  }
  const cfg = { ...DEFAULTS, ...fileCfg, repoRoot };
  cfg.vaultPath = path.resolve(repoRoot, process.env.SYNAPSE_VAULT || cfg.vaultPath);
  return cfg;
}
