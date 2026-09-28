/**
 * Run a DSL YAML against the mock target end-to-end:
 *   pnpm build && node examples/run-dsl.ts examples/dsl/toggle-autoupdate.yaml mock
 * (imports the compiled dist/ — build first; "mock" needs no hardware)
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(root, "dist");
if (!existsSync(join(dist, "scripting/runner.js"))) {
  console.error("dist/ not built — run `pnpm build` first");
  process.exit(1);
}

const file = process.argv[2] ?? join(here, "dsl/toggle-autoupdate.yaml");
const platform = process.argv[3] ?? "mock";

const { parseDsl } = await import(join(dist, "scripting/dsl.js"));
const { DslRunner } = await import(join(dist, "scripting/runner.js"));
const { PlatformRouter } = await import(join(dist, "platforms/router.js"));
const { MockAdapter } = await import(join(dist, "platforms/mock/adapter.js"));
const { MockProvider } = await import(join(dist, "providers/mock/provider.js"));
const { loadConfig } = await import(join(dist, "config.js"));

const script = parseDsl(readFileSync(file, "utf8"));
if (platform === "mock") {
  // hermetic demo path; real platforms register via src/platforms/register.ts
  const router = new PlatformRouter();
  router.register({
    platform: "mock" as never,
    factory: async () => new MockAdapter(),
    probe: async () => ({ available: true }),
  });
  const runner = new DslRunner(router, new MockProvider(), loadConfig());
  const result = await runner.run({ script, target: { type: "local", platform: "mock" as never } });
  console.log(JSON.stringify({ status: result.status, steps: result.steps.length, assertions: result.assertions.length }, null, 2));
  process.exit(result.status === "PASS" ? 0 : 1);
}

// non-mock platforms: hand over to the full server context
const { buildContext } = await import(join(dist, "context.js"));
const ctx = await buildContext();
const result = await ctx.dsl.run({ script, target: { type: "local", platform: platform as never } });
console.log(JSON.stringify({ status: result.status, steps: result.steps.length }, null, 2));
process.exit(result.status === "PASS" ? 0 : 1);
