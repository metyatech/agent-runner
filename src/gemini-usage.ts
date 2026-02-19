/**
 * Gemini usage — fetching delegated to @metyatech/ai-quota.
 * Gate/ramp evaluation stays here.
 */
export type { GeminiUsage, GeminiModelUsage } from "@metyatech/ai-quota";
export { fetchGeminiRateLimits as fetchGeminiUsage } from "@metyatech/ai-quota";

import { evaluateUsageRamp, type UsageRampSchedule } from "./usage-gate-common.js";
import type { GeminiUsage, GeminiModelUsage } from "@metyatech/ai-quota";

export type GeminiUsageGateConfig = {
  enabled: boolean;
  strategy: "spare-only";
  warmup?: {
    enabled?: boolean;
    cooldownMinutes?: number;
  };
} & UsageRampSchedule;

export type GeminiUsageGateDecision = {
  allowPro: boolean;
  allowFlash: boolean;
  reason: string;
  proUsage?: GeminiModelUsage;
  flashUsage?: GeminiModelUsage;
};

export function evaluateGeminiUsageGate(
  usage: GeminiUsage,
  gate: GeminiUsageGateConfig,
  now: Date = new Date()
): GeminiUsageGateDecision {
  if (!gate.enabled) {
    return { allowPro: false, allowFlash: false, reason: "Gate disabled." };
  }

  const checkModel = (modelUsage?: GeminiModelUsage): { allowed: boolean; reason?: string } => {
    if (!modelUsage) return { allowed: false, reason: "No usage data" };

    const percentRemaining = (1.0 - modelUsage.usage / modelUsage.limit) * 100;
    const decision = evaluateUsageRamp(percentRemaining, modelUsage.resetAt, gate, now);

    return { allowed: decision.allow, reason: decision.reason };
  };

  const pro = checkModel(usage["gemini-3-pro-preview"]);
  const flash = checkModel(usage["gemini-3-flash-preview"]);

  const reasons: string[] = [];
  if (pro.allowed) reasons.push("Pro allowed");
  else reasons.push(`Pro blocked (${pro.reason})`);

  if (flash.allowed) reasons.push("Flash allowed");
  else reasons.push(`Flash blocked (${flash.reason})`);

  return {
    allowPro: pro.allowed,
    allowFlash: flash.allowed,
    reason: reasons.join(", "),
    proUsage: usage["gemini-3-pro-preview"],
    flashUsage: usage["gemini-3-flash-preview"]
  };
}
