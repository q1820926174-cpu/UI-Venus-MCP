import { describe, expect, it } from "vitest";
import { evaluateAction, evaluateDevice, matchesSensitive, ConfirmationRegistry } from "../../src/orchestrator/security.js";
import type { SecurityConfig } from "../../src/orchestrator/security.js";

const cfg = (over: Partial<SecurityConfig> = {}): SecurityConfig => ({
  confirmSensitiveActions: true,
  sensitiveKeywords: ["删除", "delete", "pay", "支付", "转账", "transfer"],
  confirmationTimeoutMs: 1000,
  ...over,
});

describe("security policy (spec §35)", () => {
  it("allows innocuous actions", () => {
    const v = evaluateAction({ type: "click", point: { x: 1, y: 2 } }, cfg());
    expect(v.verdict).toBe("allow");
  });

  it("confirms clicking a delete button (sensitive element name)", () => {
    const v = evaluateAction(
      { type: "click", element: { id: "e", source: "uia", name: "删除所有数据" } },
      cfg(),
    );
    expect(v.verdict).toBe("confirm");
  });

  it("confirms typing payment text", () => {
    const v = evaluateAction({ type: "type", text: "转账 10000 元" }, cfg());
    expect(v.verdict).toBe("confirm");
  });

  it("denies blocked apps", () => {
    const v = evaluateAction({ type: "launch_app", app: "WhatsApp" }, cfg({ blockedApps: ["whatsapp"] }));
    expect(v.verdict).toBe("deny");
  });

  it("enforces action allowlists", () => {
    const c = cfg({ allowedActions: ["click", "type"] });
    expect(evaluateAction({ type: "launch_app", app: "calc" }, c).verdict).toBe("deny");
    expect(evaluateAction({ type: "click", point: { x: 1, y: 1 } }, c).verdict).toBe("allow");
    // wait/finish stay structural even under allowlists
    expect(evaluateAction({ type: "wait", durationMs: 5 }, c).verdict).toBe("allow");
  });

  it("device allowlist gates targets", () => {
    const c = cfg({ allowedDevices: ["emulator-5554"] });
    expect(evaluateDevice("emulator-5554", c).verdict).toBe("allow");
    expect(evaluateDevice("phone-99", c).verdict).toBe("deny");
    expect(evaluateDevice(undefined, c).verdict).toBe("allow");
  });
});

describe("confirmation registry", () => {
  it("parks and confirms", async () => {
    const reg = new ConfirmationRegistry();
    const token = reg.park({ type: "launch_app", app: "x" }, "sensitive", 5000);
    let released = false;
    const waitP = reg.waitFor(token, 5000).then(() => {
      released = true;
    });
    expect(reg.confirm(token)).toBe(true);
    await waitP;
    expect(released).toBe(true);
    expect(reg.confirm(token)).toBe(false); // consumed
  });

  it("cancels with a rejection", async () => {
    const reg = new ConfirmationRegistry();
    const token = reg.park({ type: "launch_app", app: "x" }, "sensitive", 5000);
    const p = reg.waitFor(token, 5000);
    reg.cancel(token);
    await expect(p).rejects.toThrow(/cancelled|rejected/i);
  });

  it("rejects unknown tokens", async () => {
    const reg = new ConfirmationRegistry();
    await expect(reg.waitFor("nope", 100)).rejects.toThrow(/unknown/i);
  });
});
