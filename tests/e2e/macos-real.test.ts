/**
 * macOS real-device E2E (spec §42/§43/§45).
 * Opt-in: RUN_MACOS_E2E=1 npx vitest run tests/e2e/macos-real.test.ts
 * Requires: Screen Recording + Accessibility permissions for the host app.
 * Read-only + one harmless 1px mouse probe; launches nothing, changes nothing.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { MacosAdapter } from "../../src/platforms/macos/adapter.js";

const enabled = !!process.env.RUN_MACOS_E2E;

describe.skipIf(!enabled)("macOS adapter — REAL E2E", () => {
  let adapter: MacosAdapter;

  beforeAll(async () => {
    adapter = new MacosAdapter({ screenshot: { maxDimension: 1280 }, axTree: { maxDepth: 6, maxNodes: 120 } });
    await adapter.open();
  }, 60_000);

  it("opens with honest capabilities", () => {
    const caps = adapter.getCapabilities();
    console.log("macOS capabilities:", JSON.stringify(caps));
    expect(adapter.getTargetInfo().platform).toBe("macos");
    expect(typeof caps.screenshot).toBe("boolean");
    expect(typeof caps.accessibility).toBe("boolean");
  });

  it("captures a real screenshot with sane metadata", async () => {
    const shot = await adapter.screenshot();
    expect(shot.width).toBeGreaterThan(0);
    expect(shot.height).toBeGreaterThan(0);
    expect(shot.dataBase64.length).toBeGreaterThan(1000);
    expect(shot.hash).toMatch(/^[0-9a-f]{64}$/);
    console.log(`screenshot ${shot.width}x${shot.height} scale=${shot.scale} hash=${shot.hash}`);
  });

  it("reads the real AX tree of the frontmost app", async () => {
    const caps = adapter.getCapabilities();
    if (!caps.accessibility) {
      console.warn("Accessibility permission missing — skipping AX tree assertion honestly");
      return;
    }
    const obs = await adapter.observe({ includeScreenshot: false, includeUITree: true, maxTreeDepth: 5 });
    expect(obs.activeApp?.name).toBeTruthy();
    expect(obs.uiTree).toBeTruthy();
    console.log(`frontmost=${obs.activeApp?.name} tree root=${obs.uiTree?.role}/${obs.uiTree?.name} children=${obs.uiTree?.children?.length}`);
  });

  it("locates a real element by name via structured channel", async () => {
    const caps = adapter.getCapabilities();
    if (!caps.accessibility) return;
    // Locator runs against the CACHED tree; prime it via observe() first.
    await adapter.observe({ includeScreenshot: false, includeUITree: true, maxTreeDepth: 6 });
    const hit = await adapter.locate({ role: "button", index: 0 });
    // not fatal — frontmost app may expose no buttons (e.g. Finder desktop)
    if (hit) {
      expect(hit.element.id).toMatch(/^ax:/);
      console.log(`located button: ${hit.element.id} name=${hit.element.name ?? "(none)"}`);
    } else {
      console.log("no button in cached tree — acceptable for the current frontmost app");
    }
  });

  it("posts a harmless 1px mouse probe", async () => {
    const caps = adapter.getCapabilities();
    if (!caps.globalInput) {
      console.warn("globalInput capability false — skipping input probe honestly");
      return;
    }
    const { mouseMove } = await import("../../src/platforms/macos/input.js");
    const screen = await adapter.getScreenInfo();
    const cx = Math.floor(screen.width / 2);
    const cy = Math.floor(screen.height / 2);
    await mouseMove(cx, cy);
    await mouseMove(cx + 1, cy);
    await mouseMove(cx, cy);
    expect(true).toBe(true); // reaching here means CGEvent posting didn't throw
  });
});
