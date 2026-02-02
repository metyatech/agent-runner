import { describe, expect, it } from "vitest";
import {
  evaluateCopilotUsageGate,
  parseCopilotQuotaHeader,
  parseCopilotUserInfo
} from "../../src/copilot-usage.js";

describe("parseCopilotUserInfo", () => {
  it("parses premium interactions snapshot", () => {
    const usage = parseCopilotUserInfo({
      quota_snapshots: {
        premium_interactions: {
          entitlement: 3000,
          percent_remaining: 72,
          overage_count: 1,
          overage_permitted: true
        }
      },
      quota_reset_date: "2026-02-15T00:00:00Z"
    });

    expect(usage).not.toBeNull();
    expect(usage?.percentRemaining).toBe(72);
    expect(usage?.entitlement).toBe(3000);
    expect(usage?.overageUsed).toBe(1);
    expect(usage?.overageEnabled).toBe(true);
  });
});

describe("parseCopilotQuotaHeader", () => {
  it("parses quota header snapshot", () => {
    const usage = parseCopilotQuotaHeader(
      "ent=3000&rem=64&rst=2026-02-15T00:00:00Z&ov=0&ovPerm=false"
    );

    expect(usage).not.toBeNull();
    expect(usage?.percentRemaining).toBe(64);
    expect(usage?.entitlement).toBe(3000);
    expect(usage?.overageEnabled).toBe(false);
  });
});

describe("evaluateCopilotUsageGate", () => {
  it("blocks when reset is too far out", () => {
    const now = new Date("2026-02-02T00:00:00Z");
    const decision = evaluateCopilotUsageGate(
      {
        percentRemaining: 80,
        resetAt: new Date("2026-03-05T00:00:00Z"),
        entitlement: 3000,
        overageUsed: 0,
        overageEnabled: false,
        source: "user",
        raw: {}
      },
      {
        enabled: true,
        timeoutSeconds: 20,
        monthlySchedule: {
          startMinutes: 1440,
          minRemainingPercentAtStart: 100,
          minRemainingPercentAtEnd: 0
        }
      },
      now
    );

    expect(decision.allow).toBe(false);
  });

  it("blocks when remaining percent is below threshold", () => {
    const now = new Date("2026-02-02T00:00:00Z");
    const decision = evaluateCopilotUsageGate(
      {
        percentRemaining: 2,
        resetAt: new Date("2026-02-02T12:00:00Z"),
        entitlement: 3000,
        overageUsed: 0,
        overageEnabled: false,
        source: "user",
        raw: {}
      },
      {
        enabled: true,
        timeoutSeconds: 20,
        monthlySchedule: {
          startMinutes: 1440,
          minRemainingPercentAtStart: 100,
          minRemainingPercentAtEnd: 0
        }
      },
      now
    );

    expect(decision.allow).toBe(false);
  });

  it("allows when remaining percent is above threshold", () => {
    const now = new Date("2026-02-02T00:00:00Z");
    const decision = evaluateCopilotUsageGate(
      {
        percentRemaining: 80,
        resetAt: new Date("2026-02-02T12:00:00Z"),
        entitlement: 3000,
        overageUsed: 0,
        overageEnabled: false,
        source: "user",
        raw: {}
      },
      {
        enabled: true,
        timeoutSeconds: 20,
        monthlySchedule: {
          startMinutes: 1440,
          minRemainingPercentAtStart: 100,
          minRemainingPercentAtEnd: 0
        }
      },
      now
    );

    expect(decision.allow).toBe(true);
  });
});
