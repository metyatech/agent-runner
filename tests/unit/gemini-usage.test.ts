import { describe, it, expect } from "vitest";
import { evaluateGeminiUsageGate, type GeminiUsage, type GeminiUsageGateConfig } from "../../src/gemini-usage.js";

describe("evaluateGeminiUsageGate", () => {
  const gate: GeminiUsageGateConfig = {
    enabled: true,
    strategy: "spare-only",
    startMinutes: 240,
    minRemainingPercentAtStart: 100,
    minRemainingPercentAtEnd: 0
  };

  it("should block both if usage is missing", () => {
    const usage: GeminiUsage = {};
    const decision = evaluateGeminiUsageGate(usage, gate);
    expect(decision.allowPro).toBe(false);
    expect(decision.allowFlash).toBe(false);
    expect(decision.reason).toContain("Pro blocked (No usage data)");
  });

  it("should allow pro if reset is close and has high remaining percent", () => {
    const now = new Date("2026-02-03T10:00:00Z");
    const usage: GeminiUsage = {
      "gemini-3-pro-preview": {
        limit: 100,
        usage: 10,
        resetAt: new Date("2026-02-03T13:00:00Z") // 3 hours (180m) later
      }
    };
    // 180m / 240m = 0.75 ratio. Required = 0 + (100-0)*0.75 = 75%.
    // Remaining = 90%. 90 > 75, so allowed.
    const decision = evaluateGeminiUsageGate(usage, gate, now);
    expect(decision.allowPro).toBe(true);
  });

  it("should block pro if remaining percent is below the ramp threshold", () => {
    const now = new Date("2026-02-03T10:00:00Z");
    const usage: GeminiUsage = {
      "gemini-3-pro-preview": {
        limit: 100,
        usage: 50,
        resetAt: new Date("2026-02-03T13:00:00Z") // 3 hours (180m) later
      }
    };
    // Required = 75%. Remaining = 50%. 50 < 75, so blocked.
    const decision = evaluateGeminiUsageGate(usage, gate, now);
    expect(decision.allowPro).toBe(false);
    expect(decision.reason).toContain("Remaining 50.0% < required 75.0%");
  });

  it("should allow pro with low remaining percent if reset is very close", () => {
    const now = new Date("2026-02-03T10:00:00Z");
    const usage: GeminiUsage = {
      "gemini-3-pro-preview": {
        limit: 100,
        usage: 90,
        resetAt: new Date("2026-02-03T10:10:00Z") // 10m later
      }
    };
    // Required = 0 + 100 * (10/240) = 4.16%.
    // Remaining = 10%. 10 > 4.16, so allowed.
    const decision = evaluateGeminiUsageGate(usage, gate, now);
    expect(decision.allowPro).toBe(true);
  });

  it("should block both if quota is exhausted", () => {
    const now = new Date("2026-02-03T10:00:00Z");
    const usage: GeminiUsage = {
      "gemini-3-pro-preview": {
        limit: 100,
        usage: 100,
        resetAt: new Date("2026-02-03T11:00:00Z")
      },
      "gemini-3-flash-preview": {
        limit: 1000,
        usage: 1000,
        resetAt: new Date("2026-02-03T11:00:00Z")
      }
    };
    const decision = evaluateGeminiUsageGate(usage, gate, now);
    expect(decision.allowPro).toBe(false);
    expect(decision.allowFlash).toBe(false);
    expect(decision.reason).toContain("Remaining 0.0% < required");
  });

  it("should allow both if both are within window", () => {
    const now = new Date("2026-02-03T10:00:00Z");
    const usage: GeminiUsage = {
      "gemini-3-pro-preview": {
        limit: 100,
        usage: 0,
        resetAt: new Date("2026-02-03T12:00:00Z")
      },
      "gemini-3-flash-preview": {
        limit: 1000,
        usage: 500,
        resetAt: new Date("2026-02-03T12:00:00Z")
      }
    };
    const decision = evaluateGeminiUsageGate(usage, gate, now);
    expect(decision.allowPro).toBe(true);
    expect(decision.allowFlash).toBe(true);
    expect(decision.reason).toContain("Pro allowed");
    expect(decision.reason).toContain("Flash allowed");
  });
});
