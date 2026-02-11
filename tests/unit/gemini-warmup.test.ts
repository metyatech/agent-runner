import { describe, expect, it } from "vitest";
import { evaluateGeminiWarmup, type GeminiWarmupState } from "../../src/gemini-warmup.js";
import type { GeminiUsage, GeminiUsageGateConfig } from "../../src/gemini-usage.js";

describe("evaluateGeminiWarmup", () => {
  it("schedules warmup when usage is full and reset is outside the window", () => {
    const now = new Date("2026-02-07T00:00:00Z");
    const usage: GeminiUsage = {
      "gemini-3-pro-preview": {
        limit: 100,
        usage: 0,
        resetAt: new Date("2026-02-08T00:00:00Z")
      },
      "gemini-3-flash-preview": {
        limit: 100,
        usage: 0,
        resetAt: new Date("2026-02-08T00:00:00Z")
      }
    };
    const gate: GeminiUsageGateConfig = {
      enabled: true,
      strategy: "spare-only",
      startMinutes: 240,
      minRemainingPercentAtStart: 100,
      minRemainingPercentAtEnd: 0
    };
    const state: GeminiWarmupState = { models: {} };

    const decision = evaluateGeminiWarmup(usage, gate, state, now);

    expect(decision.warmupPro).toBe(true);
    expect(decision.warmupFlash).toBe(true);
  });

  it("does not schedule warmup when warmup is disabled", () => {
    const now = new Date("2026-02-07T00:00:00Z");
    const usage: GeminiUsage = {
      "gemini-3-pro-preview": {
        limit: 100,
        usage: 0,
        resetAt: new Date("2026-02-08T00:00:00Z")
      },
      "gemini-3-flash-preview": {
        limit: 100,
        usage: 0,
        resetAt: new Date("2026-02-08T00:00:00Z")
      }
    };
    const gate: GeminiUsageGateConfig = {
      enabled: true,
      strategy: "spare-only",
      warmup: { enabled: false },
      startMinutes: 240,
      minRemainingPercentAtStart: 100,
      minRemainingPercentAtEnd: 0
    };
    const state: GeminiWarmupState = { models: {} };

    const decision = evaluateGeminiWarmup(usage, gate, state, now);

    expect(decision.warmupPro).toBe(false);
    expect(decision.warmupFlash).toBe(false);
  });

  it("respects cooldown to avoid repeated warmup attempts", () => {
    const now = new Date("2026-02-07T01:00:00Z");
    const usage: GeminiUsage = {
      "gemini-3-pro-preview": {
        limit: 100,
        usage: 0,
        resetAt: new Date("2026-02-08T01:00:00Z")
      },
      "gemini-3-flash-preview": {
        limit: 100,
        usage: 0,
        resetAt: new Date("2026-02-08T01:00:00Z")
      }
    };
    const gate: GeminiUsageGateConfig = {
      enabled: true,
      strategy: "spare-only",
      warmup: { cooldownMinutes: 60 },
      startMinutes: 240,
      minRemainingPercentAtStart: 100,
      minRemainingPercentAtEnd: 0
    };
    const state: GeminiWarmupState = {
      models: {
        "gemini-3-pro-preview": { lastAttemptAt: "2026-02-07T00:30:00Z" },
        "gemini-3-flash-preview": { lastAttemptAt: "2026-02-07T00:30:00Z" }
      }
    };

    const decision = evaluateGeminiWarmup(usage, gate, state, now);

    expect(decision.warmupPro).toBe(false);
    expect(decision.warmupFlash).toBe(false);
  });

  it("does not schedule warmup when usage is not full", () => {
    const now = new Date("2026-02-07T00:00:00Z");
    const usage: GeminiUsage = {
      "gemini-3-pro-preview": {
        limit: 100,
        usage: 0.1,
        resetAt: new Date("2026-02-08T00:00:00Z")
      },
      "gemini-3-flash-preview": {
        limit: 100,
        usage: 0.1,
        resetAt: new Date("2026-02-08T00:00:00Z")
      }
    };
    const gate: GeminiUsageGateConfig = {
      enabled: true,
      strategy: "spare-only",
      startMinutes: 240,
      minRemainingPercentAtStart: 100,
      minRemainingPercentAtEnd: 0
    };
    const state: GeminiWarmupState = { models: {} };

    const decision = evaluateGeminiWarmup(usage, gate, state, now);

    expect(decision.warmupPro).toBe(false);
    expect(decision.warmupFlash).toBe(false);
  });
});
