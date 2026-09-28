# Run the example DSL against the mock target via the CLI-less runner:
#   npx tsx examples/run-dsl.ts [path-to-yaml] [platform]
import { readFileSync } from "node:fs";
import { PlatformRouter, type AdapterRegistration } from "../src/platforms/router.js";
import { MockAdapter } from "../src/platforms/mock/adapter.js";
import { loadConfig } from "../src/config.js";
import { DslRunner } from "../src/scripting/runner.js";
import { parseDsl } from "../src/scripting/dsl.js";
import { MockProvider } from "../src/providers/mock/provider.js";

async function main(): Promise<void> {
  const file = process.argv[2] ?? "examples/dsl/toggle-autoupdate.yaml";
  const platform = process.argv[3] ?? "mock";
  const yaml = readFileSync(file, "utf8");
  const script = parseDsl(yaml);

  const router = new PlatformRouter();
  if (platform === "mock") {
    const reg: AdapterRegistration = {
      platform: "mock" as never,
      factory: async () => new MockAdapter(),
      probe: async () => ({ available: true }),
    };
    router.register(reg);
  }
  // Real platforms register themselves via src/platforms/register.ts —
  // call buildContext() instead for the full server wiring.

  const cfg = loadConfig();
  const runner = new DslRunner(router, new MockProvider(), cfg);
  const result = await runner.run({
    script,
    target: { type: "local", platform: platform as never },
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "PASS" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
