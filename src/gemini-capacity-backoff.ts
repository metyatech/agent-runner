import fs from "node:fs";
import path from "node:path";

export type GeminiCapacityBackoffState = {
  models: Record<string, { blockedUntil: string }>;
};

const DEFAULT_STATE: GeminiCapacityBackoffState = { models: {} };

export function resolveGeminiCapacityBackoffStatePath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "gemini-capacity-backoff.json");
}

export function loadGeminiCapacityBackoffState(statePath: string): GeminiCapacityBackoffState {
  if (!fs.existsSync(statePath)) {
    return { ...DEFAULT_STATE, models: {} };
  }

  const raw = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid Gemini capacity backoff state at ${statePath}`);
  }
  const record = parsed as Record<string, unknown>;
  const modelsRaw = record.models;
  if (!modelsRaw || typeof modelsRaw !== "object") {
    throw new Error(`Invalid Gemini capacity backoff state at ${statePath}`);
  }

  const models: Record<string, { blockedUntil: string }> = {};
  for (const [key, value] of Object.entries(modelsRaw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const blockedUntil = typeof entry.blockedUntil === "string" ? entry.blockedUntil : null;
    if (!blockedUntil) continue;
    models[key] = { blockedUntil };
  }

  return { models };
}

export function saveGeminiCapacityBackoffState(statePath: string, state: GeminiCapacityBackoffState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function recordGeminiCapacityBackoff(
  statePath: string,
  modelId: string,
  blockedUntil: Date
): GeminiCapacityBackoffState {
  let state: GeminiCapacityBackoffState;
  try {
    state = loadGeminiCapacityBackoffState(statePath);
  } catch {
    state = { ...DEFAULT_STATE, models: {} };
  }
  state.models[modelId] = { blockedUntil: blockedUntil.toISOString() };
  saveGeminiCapacityBackoffState(statePath, state);
  return state;
}

export function getGeminiCapacityBackoffUntil(
  state: GeminiCapacityBackoffState,
  modelId: string
): Date | null {
  const raw = state.models[modelId]?.blockedUntil;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed);
}

export function isGeminiModelBlockedByCapacity(
  state: GeminiCapacityBackoffState,
  modelId: string,
  now: Date = new Date()
): boolean {
  const until = getGeminiCapacityBackoffUntil(state, modelId);
  if (!until) return false;
  return until.getTime() > now.getTime();
}

