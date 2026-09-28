import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Real-device / live-provider E2E is opt-in via env so `pnpm test`
    // stays hermetic on any machine.
    env: {
      RUN_MACOS_E2E: process.env.RUN_MACOS_E2E ?? "",
      RUN_VENUS_LIVE: process.env.RUN_VENUS_LIVE ?? "",
      RUN_BROWSER_E2E: process.env.RUN_BROWSER_E2E ?? "1",
    },
  },
});
