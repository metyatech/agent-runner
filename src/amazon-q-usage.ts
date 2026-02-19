/**
 * Amazon Q usage — fetching/state management delegated to @metyatech/ai-quota.
 * Gate/ramp evaluation stays here.
 */
export type { AmazonQUsageSnapshot } from "@metyatech/ai-quota";
export {
  recordAmazonQUsage,
  loadAmazonQUsageState,
  saveAmazonQUsageState,
  resolveAmazonQUsageStatePath
} from "@metyatech/ai-quota";
import { fetchAmazonQRateLimits } from "@metyatech/ai-quota";

import { evaluateUsageRamp, type UsageRampSchedule } from "./usage-gate-common.js";
import type { AmazonQUsageSnapshot } from "@metyatech/ai-quota";

export type AmazonQUsageGateConfig = {
  enabled: boolean;
  monthlyLimit: number;
  monthlySchedule: UsageRampSchedule;
};

export type AmazonQUsageGateDecision = {
  allow: boolean;
  reason: string;
  percentRemaining?: number;
  minutesToReset?: number;
  resetAt?: Date;
  used?: number;
  limit?: number;
};

/**
 * Adapter: preserves the original agent-runner call signature
 * (statePath, gate, now?) while delegating to @metyatech/ai-quota.
 */
export function getAmazonQUsageSnapshot(
  statePath: string,
  gate: AmazonQUsageGateConfig,
  now: Date = new Date()
): AmazonQUsageSnapshot {
  return fetchAmazonQRateLimits(statePath, gate.monthlyLimit, now);
}

export function evaluateAmazonQUsageGate(
  usage: AmazonQUsageSnapshot,
  gate: AmazonQUsageGateConfig,
  now: Date = new Date()
): AmazonQUsageGateDecision {
  const decision = evaluateUsageRamp(
    usage.percentRemaining,
    usage.resetAt,
    gate.monthlySchedule,
    now
  );

  return {
    allow: decision.allow,
    reason: `Monthly ${decision.reason}`,
    percentRemaining: usage.percentRemaining,
    minutesToReset: decision.minutesToReset,
    resetAt: usage.resetAt,
    used: usage.used,
    limit: usage.limit
  };
}
