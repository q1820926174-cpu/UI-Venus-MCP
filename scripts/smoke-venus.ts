/**
 * One-request smoke test for the UI-Venus endpoint:
 *   pnpm smoke:venus
 * Sends the calibration fixture with the official grounding prompt and
 * prints the model's normalized coordinates + the pixel-space conversion.
 * Exit 0 when the endpoint answers parseable coordinates.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { VenusClient } from "../src/providers/ui-venus/client.js";
import { groundingPrompt, parseGroundingPoint } from "../src/providers/ui-venus/prompts.js";
import { normalizedToScreenshot } from "../src/coordinate/index.js";

async function main(): Promise<void> {
  const cfg = loadConfig().venus;
  if (!cfg.apiKey) {
    console.error("VENUS_API_KEY is not configured (see .env.example)");
    process.exit(1);
  }
  const base64 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../tests/fixtures/calibration.png")).toString("base64");
  console.log(`endpoint : ${cfg.baseUrl}`);
  console.log(`model    : ${cfg.model}`);
  const t0 = Date.now();
  const client = new VenusClient(cfg);
  const raw = await client.chatWithImage(base64, "image/png", groundingPrompt("CLOSE button"), { maxTokens: 32 });
  const dt = Date.now() - t0;
  console.log(`raw      : ${raw.trim()}`);
  const parsed = parseGroundingPoint(raw);
  if (!parsed) {
    console.error("FAIL: cannot parse grounding output");
    process.exit(1);
  }
  if (!parsed.feasible) {
    console.log("model reported the instruction infeasible ([-1,-1])");
    process.exit(0);
  }
  const pixel = normalizedToScreenshot(parsed, 1920, 1080);
  console.log(`normalized: [${parsed.x}, ${parsed.y}]  (expected [677, 685] for the calibration fixture)`);
  console.log(`pixel     : (${Math.round(pixel.x)}, ${Math.round(pixel.y)})  on 1920×1080 (expected ~(1300, 740))`);
  console.log(`latency   : ${dt}ms`);
  const inTolerance = Math.abs(parsed.x - 677) <= 30 && Math.abs(parsed.y - 685) <= 30;
  console.log(inTolerance ? "OK: within 30/1000 tolerance" : "WARN: outside tolerance — check model/deployment");
  process.exit(inTolerance ? 0 : 2);
}

main().catch((e) => {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
