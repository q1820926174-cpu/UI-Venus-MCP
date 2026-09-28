/**
 * Central adapter registration (spec §5/§48).
 *
 * Each platform adapter is loaded dynamically: an adapter that is absent
 * (not built), not applicable on this host (e.g. windows/*.exe tooling on
 * macOS), or fails its probe is skipped honestly instead of crashing the
 * server. list_targets reflects exactly what is available.
 */
import type { AdapterRegistration } from "./router.js";

/** Specifiers kept as plain strings so a missing/unbuilt adapter module is a runtime skip, not a compile error. */
const ADAPTER_SPECS: Record<string, string> = {
  macos: "./macos/adapter.js",
  windows: "./windows/adapter.js",
  linux: "./linux/adapter.js",
  android: "./android/adapter.js",
  ios: "./ios/adapter.js",
  browser: "./browser/adapter.js",
};

async function tryLoad(spec: string): Promise<Record<string, unknown> | null> {
  try {
    const mod = (await import(/* webpackIgnore: true */ spec)) as Record<string, unknown>;
    return mod;
  } catch {
    return null;
  }
}

/**
 * Build the adapter list for this host. Each entry provides:
 *   { AdapterClass, probe } — probe answers "could this target work here?"
 */
export async function adapterRegistrations(): Promise<AdapterRegistration[]> {
  const regs: AdapterRegistration[] = [];

  // ---- macOS (only meaningful on darwin)
  if (process.platform === "darwin") {
    const mod = await tryLoad(ADAPTER_SPECS["macos"]!);
    const adapterModule = mod as { MacosAdapter?: new () => import("./adapter.js").PlatformAdapter } | null;
    if (adapterModule?.MacosAdapter) {
      const { MacosAdapter } = adapterModule;
      regs.push({
        platform: "macos",
        factory: async () => new MacosAdapter(),
        probe: async () => {
          try {
            const a = new MacosAdapter();
            const info = await a.open();
            return { available: true, details: info.details as Record<string, unknown> };
          } catch (e) {
            return { available: false, reason: (e as Error).message };
          }
        },
      });
    }
  }

  // ---- Windows (only meaningful on win32; scripts also usable via remote bundles)
  if (process.platform === "win32") {
    const mod = await tryLoad(ADAPTER_SPECS["windows"]!);
    const adapterModule = mod as { WindowsAdapter?: new () => import("./adapter.js").PlatformAdapter } | null;
    if (adapterModule?.WindowsAdapter) {
      const { WindowsAdapter } = adapterModule;
      regs.push({
        platform: "windows",
        factory: async () => new WindowsAdapter(),
        probe: async () => {
          try {
            const a = new WindowsAdapter();
            const info = await a.open();
            return { available: true, details: info.details as Record<string, unknown> };
          } catch (e) {
            return { available: false, reason: (e as Error).message };
          }
        },
      });
    }
  } else {
    // host cannot serve a local Windows target — still register so
    // list_targets can explain WHY it is unavailable (honesty > silence)
    regs.push({
      platform: "windows",
      factory: async () => {
        throw new (await import("../core/errors.js")).ComputerUseError(
          "unsupported",
          "Local Windows target requires running the MCP server on Windows",
          { hint: "Run ui-venus-mcp on the Windows machine, or target a remote/vm host (roadmap)." },
        );
      },
      probe: async () => ({
        available: false,
        reason: `host platform is ${process.platform}; Windows adapter needs a Windows host (see docs/install/windows.md for remote testing)`,
      }),
    });
  }

  // ---- Linux
  if (process.platform === "linux") {
    const mod = await tryLoad(ADAPTER_SPECS["linux"]!);
    const adapterModule = mod as {
      LinuxAdapter?: new () => import("./adapter.js").PlatformAdapter;
      linuxProbe?: () => Promise<{ available: boolean; reason?: string; details?: Record<string, unknown> }>;
    } | null;
    if (adapterModule?.LinuxAdapter) {
      const { LinuxAdapter, linuxProbe } = adapterModule;
      regs.push({
        platform: "linux",
        factory: async () => new LinuxAdapter(),
        probe: linuxProbe ?? (async () => ({ available: true })),
      });
    }
  } else {
    regs.push({
      platform: "linux",
      factory: async () => {
        throw new (await import("../core/errors.js")).ComputerUseError(
          "unsupported",
          "Local Linux target requires running the MCP server on Linux",
        );
      },
      probe: async () => ({ available: false, reason: `host platform is ${process.platform}; Linux adapter needs a Linux host` }),
    });
  }

  // ---- Android (adb may exist on any host)
  {
    const mod = await tryLoad(ADAPTER_SPECS["android"]!);
    const adapterModule = mod as {
      AndroidAdapter?: new (opts?: object) => import("./adapter.js").PlatformAdapter;
      androidProbe?: () => Promise<{ available: boolean; reason?: string; details?: Record<string, unknown> }>;
    } | null;
    if (adapterModule?.AndroidAdapter) {
      const { AndroidAdapter, androidProbe } = adapterModule;
      regs.push({
        platform: "android",
        factory: async () => new AndroidAdapter(),
        probe: androidProbe ?? (async () => ({ available: true })),
      });
    }
  }

  // ---- iOS (simctl on macOS; WDA/idb anywhere reachable)
  {
    const mod = await tryLoad(ADAPTER_SPECS["ios"]!);
    const adapterModule = mod as {
      IosAdapter?: new (opts?: object) => import("./adapter.js").PlatformAdapter;
      iosProbe?: () => Promise<{ available: boolean; reason?: string; details?: Record<string, unknown> }>;
    } | null;
    if (adapterModule?.IosAdapter) {
      const { IosAdapter, iosProbe } = adapterModule;
      regs.push({
        platform: "ios",
        factory: async () => new IosAdapter(),
        probe: iosProbe ?? (async () => ({ available: true })),
      });
    }
  }

  // ---- Browser (needs optional playwright dependency)
  {
    const mod = await tryLoad(ADAPTER_SPECS["browser"]!);
    const adapterModule = mod as {
      BrowserAdapter?: new (opts?: object) => import("./adapter.js").PlatformAdapter;
      browserProbe?: () => Promise<{ available: boolean; reason?: string; details?: Record<string, unknown> }>;
    } | null;
    if (adapterModule?.BrowserAdapter) {
      const { BrowserAdapter, browserProbe } = adapterModule;
      regs.push({
        platform: "browser",
        factory: async () => new BrowserAdapter(),
        probe: browserProbe ?? (async () => ({ available: true })),
      });
    }
  }

  return regs;
}
