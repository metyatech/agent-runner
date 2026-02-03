import fs from "node:fs";
import path from "node:path";
import { evaluateUsageRamp, type UsageRampSchedule } from "./usage-gate-common.js";

export type AmazonQUsageGateConfig = {
  enabled: boolean;
  monthlyLimit: number;
  monthlySchedule: UsageRampSchedule;
};

export type AmazonQUsageSnapshot = {
  used: number;
  limit: number;
  percentRemaining: number;
  resetAt: Date;
  periodKey: string;
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

type AmazonQUsageState = {
  periodKey: string;
  used: number;
  updatedAt: string;
};

function resolveMonthlyPeriodKey(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function resolveNextMonthlyResetAt(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

function normalizeUsed(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

export function resolveAmazonQUsageStatePath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "amazon-q-usage.json");
}

export function loadAmazonQUsageState(statePath: string, now: Date = new Date()): AmazonQUsageState {
  const currentPeriodKey = resolveMonthlyPeriodKey(now);
  if (!fs.existsSync(statePath)) {
    return {
      periodKey: currentPeriodKey,
      used: 0,
      updatedAt: now.toISOString()
    };
  }

  const raw = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid Amazon Q usage state at ${statePath}`);
  }
  const record = parsed as Record<string, unknown>;

  const periodKey = typeof record.periodKey === "string" ? record.periodKey : null;
  const used = normalizeUsed(record.used);
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : null;

  if (!periodKey || used === null || !updatedAt) {
    throw new Error(`Invalid Amazon Q usage state at ${statePath}`);
  }

  if (periodKey !== currentPeriodKey) {
    return {
      periodKey: currentPeriodKey,
      used: 0,
      updatedAt: now.toISOString()
    };
  }

  return { periodKey, used, updatedAt };
}

export function saveAmazonQUsageState(statePath: string, state: AmazonQUsageState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function recordAmazonQUsage(
  statePath: string,
  count: number = 1,
  now: Date = new Date()
): AmazonQUsageState {
  const normalizedCount = Math.max(0, Math.floor(count));
  const state = loadAmazonQUsageState(statePath, now);
  const updated: AmazonQUsageState = {
    periodKey: state.periodKey,
    used: state.used + normalizedCount,
    updatedAt: now.toISOString()
  };
  saveAmazonQUsageState(statePath, updated);
  return updated;
}

export function getAmazonQUsageSnapshot(
  statePath: string,
  gate: AmazonQUsageGateConfig,
  now: Date = new Date()
): AmazonQUsageSnapshot {
  const state = loadAmazonQUsageState(statePath, now);
  const limit = gate.monthlyLimit;
  const used = Math.max(0, state.used);
  const percentRemaining =
    limit <= 0 ? 0 : Math.min(100, Math.max(0, ((limit - used) / limit) * 100));

  return {
    used,
    limit,
    percentRemaining,
    resetAt: resolveNextMonthlyResetAt(now),
    periodKey: state.periodKey
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

