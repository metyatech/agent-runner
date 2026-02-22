import fs from "node:fs";
import path from "node:path";
import { evaluateUsageRamp } from "./usage-gate-common.js";
import type { GeminiModelUsage, GeminiUsage, GeminiUsageGateConfig } from "./gemini-usage.js";

export type GeminiWarmupConfig = {
  enabled: boolean;
  cooldownMinutes: number;
};

export type GeminiWarmupState = {
  models: Record<string, { lastAttemptAt: string }>;
};

export type GeminiWarmupDecision = {
  warmupPro: boolean;
  warmupFlash: boolean;
  reason: string;
};

const DEFAULT_STATE: GeminiWarmupState = { models: {} };

export function resolveGeminiWarmupStatePath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "gemini-warmup.json");
}

export function loadGeminiWarmupState(statePath: string): GeminiWarmupState {
  if (!fs.existsSync(statePath)) {
    return { ...DEFAULT_STATE };
  }

  const raw = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid Gemini warmup state at ${statePath}`);
  }
  const record = parsed as Record<string, unknown>;

  const models = record.models;
  if (!models || typeof models !== "object") {
    throw new Error(`Invalid Gemini warmup state at ${statePath}`);
  }

  const normalized: GeminiWarmupState = { models: {} };
  for (const [key, value] of Object.entries(models as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const lastAttemptAt = typeof entry.lastAttemptAt === "string" ? entry.lastAttemptAt : null;
    if (!lastAttemptAt) continue;
    normalized.models[key] = { lastAttemptAt };
  }

  return normalized;
}

export function saveGeminiWarmupState(statePath: string, state: GeminiWarmupState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function recordGeminiWarmupAttempt(
  statePath: string,
  modelId: string,
  now: Date = new Date()
): GeminiWarmupState {
  let state: GeminiWarmupState;
  try {
    state = loadGeminiWarmupState(statePath);
  } catch {
    state = { ...DEFAULT_STATE, models: {} };
  }
  state.models[modelId] = { lastAttemptAt: now.toISOString() };
  saveGeminiWarmupState(statePath, state);
  return state;
}

function getWarmupConfig(gate: GeminiUsageGateConfig): GeminiWarmupConfig {
  const enabled = gate.warmup?.enabled ?? true;
  const cooldownMinutesRaw = gate.warmup?.cooldownMinutes;
  const cooldownMinutes =
    typeof cooldownMinutesRaw === "number" && Number.isFinite(cooldownMinutesRaw)
      ? Math.max(0, Math.floor(cooldownMinutesRaw))
      : 60;

  return { enabled, cooldownMinutes };
}

function getPercentRemaining(modelUsage: GeminiModelUsage): number {
  if (modelUsage.limit <= 0) return 0;
  return Math.min(100, Math.max(0, (1.0 - modelUsage.usage / modelUsage.limit) * 100));
}

function isEffectivelyFull(percentRemaining: number): boolean {
  return percentRemaining >= 99.999;
}

function isBlockedByResetWindow(
  modelUsage: GeminiModelUsage,
  gate: GeminiUsageGateConfig,
  now: Date
): boolean {
  const percentRemaining = getPercentRemaining(modelUsage);
  const decision = evaluateUsageRamp(percentRemaining, modelUsage.resetAt, gate, now);
  return (
    !decision.allow &&
    typeof decision.minutesToReset === "number" &&
    decision.minutesToReset > gate.startMinutes
  );
}

function isCooldownActive(
  lastAttemptAt: string | null,
  cooldownMinutes: number,
  now: Date
): boolean {
  if (!lastAttemptAt || cooldownMinutes <= 0) return false;
  const parsed = Date.parse(lastAttemptAt);
  if (!Number.isFinite(parsed)) return false;
  const cooldownMs = cooldownMinutes * 60 * 1000;
  return now.getTime() - parsed < cooldownMs;
}

function shouldWarmupModel(options: {
  modelUsage?: GeminiModelUsage;
  modelId: string;
  gate: GeminiUsageGateConfig;
  warmup: GeminiWarmupConfig;
  state: GeminiWarmupState;
  now: Date;
}): boolean {
  const { modelUsage, modelId, gate, warmup, state, now } = options;
  if (!warmup.enabled) return false;
  if (!modelUsage) return false;

  const percentRemaining = getPercentRemaining(modelUsage);
  if (!isEffectivelyFull(percentRemaining)) return false;
  if (!isBlockedByResetWindow(modelUsage, gate, now)) return false;

  const lastAttemptAt = state.models[modelId]?.lastAttemptAt ?? null;
  if (isCooldownActive(lastAttemptAt, warmup.cooldownMinutes, now)) {
    return false;
  }

  return true;
}

export function evaluateGeminiWarmup(
  usage: GeminiUsage,
  gate: GeminiUsageGateConfig,
  state: GeminiWarmupState,
  now: Date = new Date()
): GeminiWarmupDecision {
  const warmup = getWarmupConfig(gate);
  if (!warmup.enabled) {
    return { warmupPro: false, warmupFlash: false, reason: "Warmup disabled." };
  }

  const warmupPro = shouldWarmupModel({
    modelUsage: usage["gemini-3-pro-preview"],
    modelId: "gemini-3-pro-preview",
    gate,
    warmup,
    state,
    now
  });
  const warmupFlash = shouldWarmupModel({
    modelUsage: usage["gemini-3-flash-preview"],
    modelId: "gemini-3-flash-preview",
    gate,
    warmup,
    state,
    now
  });

  if (!warmupPro && !warmupFlash) {
    return { warmupPro: false, warmupFlash: false, reason: "No warmup needed." };
  }

  return {
    warmupPro,
    warmupFlash,
    reason:
      "Warmup scheduled: Gemini is at 100% and reset countdown appears stuck at ~24h; run one idle task to start the countdown."
  };
}
