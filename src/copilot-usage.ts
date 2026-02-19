/**
 * Copilot usage — fetching delegated to @metyatech/ai-quota.
 * Gate/ramp evaluation stays here.
 */
export type { CopilotUsage } from "@metyatech/ai-quota";
export {
  parseCopilotUserInfo,
  parseCopilotQuotaHeader
} from "@metyatech/ai-quota";
import { fetchCopilotRateLimits } from "@metyatech/ai-quota";

import { evaluateUsageRamp } from "./usage-gate-common.js";
import type { CopilotUsage } from "@metyatech/ai-quota";

export type CopilotUsageGateConfig = {
  enabled: boolean;
  timeoutSeconds: number;
  apiBaseUrl?: string;
  apiVersion?: string;
  monthlySchedule: {
    startMinutes: number;
    minRemainingPercentAtStart: number;
    minRemainingPercentAtEnd: number;
  };
};

export type CopilotUsageGateDecision = {
  allow: boolean;
  reason: string;
  percentRemaining?: number;
  minutesToReset?: number;
  resetAt?: Date;
};

/**
 * Adapter: preserves the original agent-runner call signature
 * (token, gate, now?) while delegating to @metyatech/ai-quota.
 */
export async function fetchCopilotUsage(
  token: string,
  gate: CopilotUsageGateConfig,
  now: Date = new Date()
): Promise<CopilotUsage | null> {
  return fetchCopilotRateLimits(
    {
      token,
      timeoutSeconds: gate.timeoutSeconds,
      apiBaseUrl: gate.apiBaseUrl,
      apiVersion: gate.apiVersion
    },
    now
  );
}

export function evaluateCopilotUsageGate(
  usage: CopilotUsage,
  gate: CopilotUsageGateConfig,
  now: Date = new Date()
): CopilotUsageGateDecision {
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
    resetAt: usage.resetAt
  };
}
