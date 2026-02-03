import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluateAmazonQUsageGate,
  getAmazonQUsageSnapshot,
  recordAmazonQUsage,
  resolveAmazonQUsageStatePath
} from "../../src/amazon-q-usage.js";

describe("recordAmazonQUsage", () => {
  it("increments and resets on period change", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-amazonq-"));
    try {
      const statePath = resolveAmazonQUsageStatePath(root);

      recordAmazonQUsage(statePath, 1, new Date("2026-02-02T00:00:00Z"));
      recordAmazonQUsage(statePath, 2, new Date("2026-02-02T00:00:00Z"));

      const feb = getAmazonQUsageSnapshot(
        statePath,
        {
          enabled: true,
          monthlyLimit: 50,
          monthlySchedule: {
            startMinutes: 1440,
            minRemainingPercentAtStart: 100,
            minRemainingPercentAtEnd: 0
          }
        },
        new Date("2026-02-10T00:00:00Z")
      );
      expect(feb.used).toBe(3);
      expect(feb.periodKey).toBe("2026-02");

      recordAmazonQUsage(statePath, 1, new Date("2026-03-01T00:00:00Z"));
      const mar = getAmazonQUsageSnapshot(
        statePath,
        {
          enabled: true,
          monthlyLimit: 50,
          monthlySchedule: {
            startMinutes: 1440,
            minRemainingPercentAtStart: 100,
            minRemainingPercentAtEnd: 0
          }
        },
        new Date("2026-03-01T00:00:00Z")
      );
      expect(mar.used).toBe(1);
      expect(mar.periodKey).toBe("2026-03");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("evaluateAmazonQUsageGate", () => {
  it("blocks when reset is too far out", () => {
    const now = new Date("2026-02-02T00:00:00Z");
    const decision = evaluateAmazonQUsageGate(
      {
        used: 0,
        limit: 50,
        percentRemaining: 100,
        resetAt: new Date("2026-03-01T00:00:00Z"),
        periodKey: "2026-02"
      },
      {
        enabled: true,
        monthlyLimit: 50,
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
    const now = new Date("2026-02-28T23:00:00Z");
    const decision = evaluateAmazonQUsageGate(
      {
        used: 50,
        limit: 50,
        percentRemaining: 0,
        resetAt: new Date("2026-03-01T00:00:00Z"),
        periodKey: "2026-02"
      },
      {
        enabled: true,
        monthlyLimit: 50,
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
    const now = new Date("2026-02-28T23:00:00Z");
    const decision = evaluateAmazonQUsageGate(
      {
        used: 10,
        limit: 50,
        percentRemaining: 80,
        resetAt: new Date("2026-03-01T00:00:00Z"),
        periodKey: "2026-02"
      },
      {
        enabled: true,
        monthlyLimit: 50,
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

