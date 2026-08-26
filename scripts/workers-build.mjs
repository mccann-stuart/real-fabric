import { spawnSync } from "node:child_process";

// Workers Builds ignores Wrangler custom-build configuration, so its default
// deploy command needs the static assets to exist before the deploy phase.
if (process.env.WORKERS_CI !== "1") {
  process.exit(0);
}

console.log("[workers-build] Building frontend assets before Cloudflare deploy.");

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(pnpmCommand, ["run", "build"], {
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(`[workers-build] Could not start "pnpm run build": ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  console.error(`[workers-build] "pnpm run build" was terminated by signal ${result.signal}.`);
  process.exit(1);
}

process.exit(result.status ?? 1);
