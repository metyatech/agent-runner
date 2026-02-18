import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluateClaudeUsageGate,
  getClaudeUsageSnapshot,
  recordClaudeUsage,
  resolveClaudeUsageStatePath
} from "../../src/claude-usage.js";

describe("recordClaudeUsage", () => {
  it("increments and resets on period change", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-claude-"));
    try {
      const statePath = resolveClaudeUsageStatePath(root);

      recordClaudeUsage(statePath, 1, new Date("2026-02-02T00:00:00Z"));
      recordClaudeUsage(statePath, 2, new Date("2026-02-02T00:00:00Z"));

      const feb = getClaudeUsageSnapshot(
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

      recordClaudeUsage(statePath, 1, new Date("2026-03-01T00:00:00Z"));
      const mar = getClaudeUsageSnapshot(
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

  it("returns zero usage when state file does not exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-claude-"));
    try {
      const statePath = resolveClaudeUsageStatePath(root);
      const snapshot = getClaudeUsageSnapshot(
        statePath,
        {
          enabled: true,
          monthlyLimit: 100,
          monthlySchedule: {
            startMinutes: 1440,
            minRemainingPercentAtStart: 100,
            minRemainingPercentAtEnd: 0
          }
        },
        new Date("2026-02-10T00:00:00Z")
      );
      expect(snapshot.used).toBe(0);
      expect(snapshot.percentRemaining).toBe(100);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("evaluateClaudeUsageGate", () => {
  it("blocks when reset is too far out", () => {
    const now = new Date("2026-02-02T00:00:00Z");
    const decision = evaluateClaudeUsageGate(
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
    const decision = evaluateClaudeUsageGate(
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
    const decision = evaluateClaudeUsageGate(
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

  it("includes usage metadata in decision", () => {
    const now = new Date("2026-02-28T23:00:00Z");
    const decision = evaluateClaudeUsageGate(
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

    expect(decision.used).toBe(10);
    expect(decision.limit).toBe(50);
    expect(decision.percentRemaining).toBe(80);
  });
});
