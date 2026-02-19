/**
 * Codex status — fetching delegated to @metyatech/ai-quota.
 * Gate/ramp evaluation stays here.
 */
export type { RateLimitWindow, RateLimitSnapshot } from "@metyatech/ai-quota";
export {
  fetchCodexRateLimits,
  rateLimitSnapshotToStatus
} from "@metyatech/ai-quota";
export type { CodexStatus, UsageWindow, UsageWindowKey } from "@metyatech/ai-quota";

import { evaluateUsageRamp } from "./usage-gate-common.js";
import type { CodexStatus, UsageWindow } from "@metyatech/ai-quota";

export type UsageGateConfig = {
  enabled: boolean;
  codexHome?: string;
  timeoutSeconds: number;
  minRemainingPercent: {
    fiveHour: number;
  };
  weeklySchedule: {
    startMinutes: number;
    minRemainingPercentAtStart: number;
    minRemainingPercentAtEnd: number;
  };
};

export type UsageGateDecision = {
  allow: boolean;
  reason: string;
  window?: UsageWindow;
  minutesToReset?: number;
};

export function evaluateUsageGate(
  status: CodexStatus,
  gate: UsageGateConfig,
  now: Date = new Date()
): UsageGateDecision {
  const weekly = status.windows.find((window) => window.key === "weekly");
  const fiveHour = status.windows.find((window) => window.key === "fiveHour");

  if (!weekly) {
    return { allow: false, reason: "Weekly window not found in /status output." };
  }
  if (!fiveHour) {
    return { allow: false, reason: "5h window not found in /status output." };
  }

  const weeklyDecision = evaluateUsageRamp(
    weekly.percentLeft,
    weekly.resetAt,
    gate.weeklySchedule,
    now
  );

  if (!weeklyDecision.allow) {
    return {
      allow: false,
      reason: `Weekly ${weeklyDecision.reason}`
    };
  }

  const fiveHourRemainingThreshold = gate.minRemainingPercent.fiveHour;
  if (fiveHour.percentLeft < fiveHourRemainingThreshold) {
    return {
      allow: false,
      reason: `5h remaining too low: ${fiveHour.percentLeft}% left (threshold ${fiveHourRemainingThreshold}%).`
    };
  }

  return {
    allow: true,
    reason: `Weekly window within ${gate.weeklySchedule.startMinutes}m with ${weekly.percentLeft}% left and 5h has ${fiveHour.percentLeft}% remaining.`,
    window: weekly,
    minutesToReset: weeklyDecision.minutesToReset
  };
}
