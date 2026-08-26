import { spawnSync } from "node:child_process";

// Workers Builds ignores Wrangler custom-build configuration, so its default
// deploy command needs the static assets to exist before the deploy phase.
if (process.env.WORKERS_CI !== "1" || process.env.WORKERS_BUILD_RUNNING === "1") {
  process.exit(0);
}

console.log("[workers-build] Building frontend assets before Cloudflare deploy.");

const env = { ...process.env, WORKERS_BUILD_RUNNING: "1" };

// Run tsc -b directly using node to avoid pnpm lifecycle hook recursion during postinstall
const tscResult = spawnSync(process.execPath, ["./node_modules/typescript/bin/tsc", "-b"], {
  env,
  stdio: "inherit",
});

if (tscResult.status !== 0) {
  console.error("[workers-build] TypeScript typecheck failed.");
  process.exit(tscResult.status ?? 1);
}

// Run vite build directly using node
const buildResult = spawnSync(
  process.execPath,
  ["./node_modules/vite/bin/vite.js", "build", "--configLoader", "runner"],
  {
    env,
    stdio: "inherit",
  },
);

if (buildResult.status !== 0) {
  console.error("[workers-build] Vite build failed.");
  process.exit(buildResult.status ?? 1);
}

console.log("[workers-build] Build complete.");
