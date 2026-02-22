/**
 * Amazon Q usage — tracked locally by agent-runner.
 *
 * Amazon Q does not currently provide a straightforward usage API that we can
 * query from the runner, so we track usage for *agent-runner initiated runs*
 * and apply a monthly gate based on that local state.
 */
import fs from "node:fs";
import path from "node:path";

import { evaluateUsageRamp, type UsageRampSchedule } from "./usage-gate-common.js";

export type AmazonQUsageSnapshot = {
  used: number;
  limit: number;
  percentRemaining: number;
  resetAt: Date;
  /**
   * Monthly period key in UTC, e.g. "2026-02".
   */
  periodKey: string;
};

type AmazonQUsageState = {
  periodKey: string;
  used: number;
};

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

export function getAmazonQUsageSnapshot(
  statePath: string,
  gate: AmazonQUsageGateConfig,
  now: Date = new Date()
): AmazonQUsageSnapshot {
  const periodKey = toPeriodKey(now);
  const state = loadAmazonQUsageState(statePath);
  const used = state?.periodKey === periodKey ? state.used : 0;
  const limit = gate.monthlyLimit;
  const percentRemaining =
    limit > 0 ? Math.max(0, Math.min(100, ((limit - used) / limit) * 100)) : 0;

  return {
    used,
    limit,
    percentRemaining,
    resetAt: nextMonthUtcStart(now),
    periodKey
  };
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

export function resolveAmazonQUsageStatePath(workdirRoot: string): string {
  return path.join(workdirRoot, "agent-runner", "state", "amazonq-usage.json");
}

export function loadAmazonQUsageState(statePath: string): AmazonQUsageState | null {
  if (!fs.existsSync(statePath)) return null;
  const raw = fs.readFileSync(statePath, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const periodKey = record["periodKey"];
  const used = record["used"];
  if (typeof periodKey !== "string") return null;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  return { periodKey, used };
}

export function saveAmazonQUsageState(statePath: string, state: AmazonQUsageState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function recordAmazonQUsage(
  statePath: string,
  increment: number,
  now: Date = new Date()
): AmazonQUsageState {
  const periodKey = toPeriodKey(now);
  const existing = loadAmazonQUsageState(statePath);
  const used = existing && existing.periodKey === periodKey ? existing.used + increment : increment;
  const nextState: AmazonQUsageState = { periodKey, used };
  saveAmazonQUsageState(statePath, nextState);
  return nextState;
}

function toPeriodKey(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function nextMonthUtcStart(now: Date): Date {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  return new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0));
}
