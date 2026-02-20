/**
 * Claude usage — fetching delegated to @metyatech/ai-quota.
 * Gate/ramp evaluation stays here.
 */
export type { ClaudeUsageData, ClaudeUsageBucket } from "@metyatech/ai-quota";
import { fetchClaudeRateLimits } from "@metyatech/ai-quota";

import { evaluateUsageRamp, type UsageRampSchedule } from "./usage-gate-common.js";
import type { ClaudeUsageData } from "@metyatech/ai-quota";

export interface ClaudeUsageGateConfig {
  enabled: boolean;
  minRemainingPercent?: {
    fiveHour: number; // hard floor, e.g. 50
  };
  weeklySchedule?: UsageRampSchedule;
}

export type ClaudeUsageGateDecision = {
  allowed: boolean;
  reason: string;
};

export async function fetchClaudeUsage(timeoutMs?: number): Promise<ClaudeUsageData | null> {
  try {
    const data = await fetchClaudeRateLimits(timeoutMs);
    return data ?? null;
  } catch {
    return null;
  }
}

export function evaluateClaudeUsageGate(
  usage: ClaudeUsageData | null,
  gate: ClaudeUsageGateConfig,
  now: Date = new Date()
): ClaudeUsageGateDecision {
  if (!gate.enabled) {
    return { allowed: false, reason: "Gate disabled." };
  }

  if (!usage) {
    return { allowed: false, reason: "Usage data unavailable." };
  }

  // Step 1: Weekly schedule check (ramp, same as Codex)
  if (gate.weeklySchedule && usage.seven_day) {
    const bucket = usage.seven_day;
    const remainingPercent = Math.max(0, Math.min(100, 100 - bucket.utilization));
    const resetAt = new Date(bucket.resets_at);
    const decision = evaluateUsageRamp(remainingPercent, resetAt, gate.weeklySchedule, now);
    if (!decision.allow) {
      return { allowed: false, reason: `Weekly blocked (${decision.reason})` };
    }
  } else if (gate.weeklySchedule && !usage.seven_day) {
    return { allowed: false, reason: "Weekly blocked (seven_day usage data unavailable)." };
  }

  // Step 2: 5-hour hard floor check (only if weekly passed or not configured)
  if (gate.minRemainingPercent?.fiveHour !== undefined && usage.five_hour) {
    const fiveHourRemaining = Math.max(0, Math.min(100, 100 - usage.five_hour.utilization));
    const threshold = gate.minRemainingPercent.fiveHour;
    if (fiveHourRemaining < threshold) {
      return {
        allowed: false,
        reason: `Five-hour floor: ${fiveHourRemaining.toFixed(1)}% remaining (threshold ${threshold}%)`
      };
    }
  }

  if (!gate.weeklySchedule && gate.minRemainingPercent?.fiveHour === undefined) {
    return { allowed: false, reason: "No applicable usage window configured." };
  }

  return { allowed: true, reason: "Claude usage gate passed." };
}
