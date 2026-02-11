import { describe, expect, it } from "vitest";
import { evaluateUsageGate, parseCodexStatus, rateLimitSnapshotToStatus } from "../../src/codex-status.js";

describe("parseCodexStatus", () => {
  it("extracts usage windows and credits", () => {
    const output = [
      "╭──────────────────────────────────────────────────────────────────────────╮",
      "│  >_ OpenAI Codex (v0.93.0)                                               │",
      "│                                                                          │",
      "│  5h limit:       [██░░░░░░░░░░░░░░░░░░] 8% left (resets 14:59)           │",
      "│  Weekly limit:   [██████████████░░░░░░] 72% left (resets 10:30 on 9 Feb) │",
      "│  Credits:        171 credits                                             │",
      "╰──────────────────────────────────────────────────────────────────────────╯"
    ].join("\n");
    const now = new Date(2026, 1, 2, 12, 0, 0);
    const status = parseCodexStatus(output, now);

    expect(status).not.toBeNull();
    expect(status?.credits).toBe(171);
    expect(status?.windows).toHaveLength(2);

    const fiveHour = status?.windows.find(window => window.key === "fiveHour");
    const weekly = status?.windows.find(window => window.key === "weekly");

    expect(fiveHour?.percentLeft).toBe(8);
    expect(fiveHour?.resetAt).toEqual(new Date(2026, 1, 2, 14, 59, 0));
    expect(weekly?.percentLeft).toBe(72);
    expect(weekly?.resetAt).toEqual(new Date(2026, 1, 9, 10, 30, 0));
  });
});

describe("evaluateUsageGate", () => {
  it("allows idle when a window is within the threshold", () => {
    const output = [
      "5h limit: [██░░] 12% left (resets 13:00)",
      "Weekly limit: [██████████] 60% left (resets 13:00 on 2 Feb)"
    ].join("\n");
    const now = new Date(2026, 1, 2, 12, 30, 0);
    const status = parseCodexStatus(output, now);

    expect(status).not.toBeNull();

    const decision = evaluateUsageGate(
      status!,
      {
        enabled: true,
        command: "codex",
        args: [],
        timeoutSeconds: 20,
        minRemainingPercent: {
          fiveHour: 5
        },
        weeklySchedule: {
          startMinutes: 60,
          minRemainingPercentAtStart: 20,
          minRemainingPercentAtEnd: 0
        }
      },
      now
    );

    expect(decision.allow).toBe(true);
  });

  it("blocks idle when 5h remaining is below threshold", () => {
    const output = [
      "5h limit: [██░░] 0% left (resets 13:00)",
      "Weekly limit: [██████████] 60% left (resets 13:00 on 2 Feb)"
    ].join("\n");
    const now = new Date(2026, 1, 2, 12, 30, 0);
    const status = parseCodexStatus(output, now);

    expect(status).not.toBeNull();

    const decision = evaluateUsageGate(
      status!,
      {
        enabled: true,
        command: "codex",
        args: [],
        timeoutSeconds: 20,
        minRemainingPercent: {
          fiveHour: 1
        },
        weeklySchedule: {
          startMinutes: 60,
          minRemainingPercentAtStart: 20,
          minRemainingPercentAtEnd: 0
        }
      },
      now
    );

    expect(decision.allow).toBe(false);
  });
});

describe("rateLimitSnapshotToStatus", () => {
  it("maps primary/secondary windows to 5h and weekly usage", () => {
    const now = new Date("2026-02-02T10:00:00Z");
    const snapshot = {
      primary: {
        usedPercent: 40,
        windowDurationMins: 300,
        resetsAt: 1_770_020_000
      },
      secondary: {
        usedPercent: 10,
        windowDurationMins: 10080,
        resetsAt: 1_770_120_000
      }
    };

    const status = rateLimitSnapshotToStatus(snapshot, now);
    expect(status).not.toBeNull();
    const fiveHour = status?.windows.find(window => window.key === "fiveHour");
    const weekly = status?.windows.find(window => window.key === "weekly");

    expect(fiveHour?.percentLeft).toBe(60);
    expect(weekly?.percentLeft).toBe(90);
  });
});
