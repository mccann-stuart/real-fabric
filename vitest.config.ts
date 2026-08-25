import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".cache/vitest",
  plugins: [
    cloudflareTest({
      main: "./src/worker/index.ts",
      miniflare: {
        // The pinned test runtime currently trails the Worker deployment date by three days.
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          APP_ENV: "test",
          MOQT_DRAFT: "20",
          MOQ_RELAY_URL: "",
          MOQT_TRANSPORT_VERIFIED: "false",
          MOQ_ROUTING_ENFORCEMENT: "cooperative",
          MOQ_DISCOVERY: "unknown",
        },
        durableObjects: { ROOMS: { className: "Room", useSQLite: true } },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    coverage: { reporter: ["text", "json"] },
  },
});
