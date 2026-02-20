import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { evaluateUsageRamp } from "./usage-gate-common.js";

export type RateLimitWindow = {
  // Both spellings are supported for compatibility with session/API shapes and tests.
  used_percent?: number;
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null; // epoch seconds
};

export type RateLimitSnapshot = {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
};

export type UsageWindowKey = "fiveHour" | "weekly";

export type UsageWindow = {
  key: UsageWindowKey;
  label: string;
  percentLeft: number;
  resetAt: Date;
};

export type CodexStatus = {
  windows: UsageWindow[];
};

export type FetchCodexRateLimitsOptions = {
  codexHome?: string;
  timeoutSeconds?: number;
  timingSink?: (phase: string, durationMs: number) => void;
};

/**
 * Fetches Codex rate limits.
 *
 * Priority:
 * 1) Local session JSONL (most recent token_count rate_limits), looking back up to 7 days.
 * 2) Backend usage API, authenticated via `auth.json` in the Codex home directory.
 */
export async function fetchCodexRateLimits(
  options?: FetchCodexRateLimitsOptions
): Promise<RateLimitSnapshot | null> {
  const codexHome = resolveCodexHome(options?.codexHome);

  const sessionStart = Date.now();
  const sessionSnapshot = await readCodexRateLimitsFromSessions(codexHome, new Date());
  if (options?.timingSink) {
    options.timingSink("sessions", Date.now() - sessionStart);
  }
  if (sessionSnapshot) {
    return sessionSnapshot;
  }

  const apiStart = Date.now();
  const apiSnapshot = await fetchCodexRateLimitsFromApi(
    codexHome,
    options?.timeoutSeconds ?? 20
  );
  if (options?.timingSink) {
    options.timingSink("api", Date.now() - apiStart);
  }
  return apiSnapshot;
}

export function rateLimitSnapshotToStatus(
  snapshot: RateLimitSnapshot,
  now: Date = new Date()
): CodexStatus | null {
  const primary = normalizeWindow(snapshot.primary);
  const secondary = normalizeWindow(snapshot.secondary);
  if (!primary && !secondary) return null;

  const fiveHour = pickWindowByDuration([primary, secondary], 300) ?? primary;
  const weekly = pickWindowByDuration([primary, secondary], 10080) ?? secondary;

  const windows: UsageWindow[] = [];
  if (fiveHour) {
    const resetAt = windowResetAt(fiveHour, now);
    if (resetAt) {
      windows.push({
        key: "fiveHour",
        label: "5h",
        percentLeft: Math.max(0, Math.min(100, 100 - fiveHour.used_percent)),
        resetAt
      });
    }
  }
  if (weekly) {
    const resetAt = windowResetAt(weekly, now);
    if (resetAt) {
      windows.push({
        key: "weekly",
        label: "7d",
        percentLeft: Math.max(0, Math.min(100, 100 - weekly.used_percent)),
        resetAt
      });
    }
  }

  return windows.length > 0 ? { windows } : null;
}

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

function resolveCodexHome(codexHome?: string): string {
  if (codexHome) return codexHome;
  const env = process.env.CODEX_HOME;
  if (env && env.trim()) return env;
  return path.join(os.homedir(), ".codex");
}

type NormalizedRateLimitWindow = {
  used_percent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

function normalizeWindow(window: RateLimitWindow | null): NormalizedRateLimitWindow | null {
  if (!window) return null;
  const usedPercent = window.used_percent ?? window.usedPercent;
  if (typeof usedPercent !== "number") return null;
  const windowDurationMins =
    window.windowDurationMins === undefined ? null : window.windowDurationMins;
  const resetsAt = window.resetsAt === undefined ? null : window.resetsAt;
  return {
    used_percent: usedPercent,
    windowDurationMins,
    resetsAt
  };
}

function windowResetAt(window: NormalizedRateLimitWindow, now: Date): Date | null {
  if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
    return new Date(window.resetsAt * 1000);
  }
  return null;
}

function pickWindowByDuration(
  windows: Array<NormalizedRateLimitWindow | null>,
  mins: number
): NormalizedRateLimitWindow | null {
  for (const w of windows) {
    if (!w) continue;
    if (w.windowDurationMins === mins) return w;
  }
  return null;
}

async function readCodexRateLimitsFromSessions(
  codexHome: string,
  now: Date
): Promise<RateLimitSnapshot | null> {
  const sessionsRoot = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessionsRoot)) return null;

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const day = new Date(now.getTime() - dayOffset * 86400000);
    const yyyy = day.getFullYear().toString();
    const mm = (day.getMonth() + 1).toString().padStart(2, "0");
    const dd = day.getDate().toString().padStart(2, "0");
    const dayDir = path.join(sessionsRoot, yyyy, mm, dd);
    if (!fs.existsSync(dayDir)) continue;

    const files = fs
      .readdirSync(dayDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(dayDir, entry.name))
      .map((p) => ({ path: p, mtimeMs: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const file of files) {
      const snapshot = readLatestTokenCountRateLimitsFromJsonl(file.path, now);
      if (snapshot) return snapshot;
    }
  }

  return null;
}

function readLatestTokenCountRateLimitsFromJsonl(
  jsonlPath: string,
  now: Date
): RateLimitSnapshot | null {
  let raw = "";
  try {
    raw = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = obj?.payload;
    if (!payload || payload.type !== "token_count") continue;
    const rateLimits = payload?.info?.rate_limits;
    const snapshot = sessionRateLimitsToSnapshot(rateLimits, now);
    if (snapshot) return snapshot;
  }
  return null;
}

function sessionRateLimitsToSnapshot(
  rateLimits: any,
  now: Date
): RateLimitSnapshot | null {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const nowSecs = Math.floor(now.getTime() / 1000);

  const convert = (candidate: any): RateLimitWindow | null => {
    if (!candidate || typeof candidate !== "object") return null;
    const used = candidate.used_percent;
    if (typeof used !== "number") return null;
    const duration = candidate.window_duration_minutes;
    const resetsIn = candidate.resets_in_seconds;
    return {
      used_percent: used,
      windowDurationMins: typeof duration === "number" ? duration : null,
      resetsAt: typeof resetsIn === "number" ? nowSecs + resetsIn : null
    };
  };

  const primary = convert(rateLimits.primary);
  const secondary = convert(rateLimits.secondary);
  if (!primary && !secondary) return null;
  return { primary, secondary };
}

async function fetchCodexRateLimitsFromApi(
  codexHome: string,
  timeoutSeconds: number
): Promise<RateLimitSnapshot | null> {
  const authPath = path.join(codexHome, "auth.json");
  if (!fs.existsSync(authPath)) return null;

  let auth: any;
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    return null;
  }

  const accessToken = auth?.tokens?.access_token;
  if (!accessToken || typeof accessToken !== "string") return null;
  const accountId = auth?.tokens?.account_id ?? auth?.account_id;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json"
  };
  if (accountId && typeof accountId === "string") {
    headers["chatgpt-account-id"] = accountId;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers,
      signal: controller.signal
    });

    if (!response.ok) return null;

    const json = await response.json();
    return apiUsageToSnapshot(json, new Date());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function apiUsageToSnapshot(payload: any, now: Date): RateLimitSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const legacy = record["rate_limits"];
  const modern = record["rate_limit"];

  let primaryCandidate: any = null;
  let secondaryCandidate: any = null;

  if (legacy && typeof legacy === "object") {
    primaryCandidate = (legacy as any).primary;
    secondaryCandidate = (legacy as any).secondary;
  } else if (modern && typeof modern === "object") {
    primaryCandidate = (modern as any).primary_window ?? (modern as any).primaryWindow;
    secondaryCandidate = (modern as any).secondary_window ?? (modern as any).secondaryWindow;
  } else {
    return null;
  }

  const nowSecs = Math.floor(now.getTime() / 1000);

  const convert = (candidate: any): RateLimitWindow | null => {
    if (!candidate || typeof candidate !== "object") return null;
    const used = candidate.used_percent;
    if (typeof used !== "number") return null;
    const limitWindowSeconds = candidate.limit_window_seconds;
    const resetAfterSeconds = candidate.reset_after_seconds;
    const resetAt = candidate.reset_at;
    return {
      used_percent: used,
      windowDurationMins:
        typeof limitWindowSeconds === "number" ? limitWindowSeconds / 60 : null,
      resetsAt:
        typeof resetAt === "number"
          ? resetAt
          : typeof resetAfterSeconds === "number"
            ? nowSecs + resetAfterSeconds
            : null
    };
  };

  const primary = convert(primaryCandidate);
  const secondary = convert(secondaryCandidate);
  if (!primary && !secondary) return null;
  return { primary, secondary };
}
