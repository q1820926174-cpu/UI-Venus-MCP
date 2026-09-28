/**
 * Vision provider registry (spec §19) — providers are pluggable; the MCP
 * core never hard-codes UI-Venus.
 */
import type { ServerConfig } from "../config.js";
import { ComputerUseError } from "../core/errors.js";
import type { ComputerVisionProvider } from "./types.js";
import { UiVenusProvider } from "./ui-venus/provider.js";
import { MockProvider, type MockProviderScript } from "./mock/provider.js";

const factories: Record<string, (cfg: ServerConfig) => ComputerVisionProvider> = {
  "ui-venus": (cfg) => new UiVenusProvider(cfg.venus),
};

const transient: Record<string, (cfg: ServerConfig) => ComputerVisionProvider> = {
  mock: (cfg) => new MockProvider((cfg as ServerConfig & { mockScript?: MockProviderScript }).mockScript),
};

export function listProviders(): string[] {
  return [...Object.keys(factories), ...Object.keys(transient)];
}

export function createProvider(name: string, cfg: ServerConfig): ComputerVisionProvider {
  const f = factories[name] ?? transient[name];
  if (!f) {
    throw new ComputerUseError("invalid_request", `Unknown vision provider "${name}"`, {
      hint: `Available: ${listProviders().join(", ")}`,
    });
  }
  return f(cfg);
}

export function createDefaultProvider(cfg: ServerConfig): ComputerVisionProvider {
  return createProvider(cfg.defaultProvider, cfg);
}
