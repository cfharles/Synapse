import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
  vaultPath: "./my-vault",
  model: "claude-sonnet-5",
  confidenceThreshold: 0.8, // start high: ask often, guess never
  maxLinks: 4,
  maxClarifyRounds: 2,
};

/** Auto-load .env so users never need to export manually. Shell env wins. */
function loadDotEnv(repoRoot) {
  const p = path.join(repoRoot, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

export function loadConfig(repoRoot = process.cwd()) {
  loadDotEnv(repoRoot);
  let fileCfg = {};
  const p = path.join(repoRoot, "synapse.config.json");
  if (fs.existsSync(p)) {
    fileCfg = JSON.parse(fs.readFileSync(p, "utf8"));
  }
  const cfg = { ...DEFAULTS, ...fileCfg, repoRoot };
  cfg.vaultPath = path.resolve(repoRoot, process.env.SYNAPSE_VAULT || cfg.vaultPath);
  return cfg;
}
