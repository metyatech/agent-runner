import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { evaluateUsageRamp } from "./usage-gate-common.js";

export type UsageWindowKey = "fiveHour" | "weekly";

export type UsageWindow = {
  key: UsageWindowKey;
  label: string;
  percentLeft: number;
  resetAt: Date;
  resetText: string;
};

export type CodexStatus = {
  windows: UsageWindow[];
  credits: number | null;
  raw: string;
};

export type RateLimitWindow = {
  usedPercent?: number;
  used_percent?: number;
  windowDurationMins?: number | null;
  window_minutes?: number | null;
  windowMinutes?: number | null;
  resetsAt?: number | null;
  resets_at?: number | null;
};

export type RateLimitSnapshot = {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: unknown;
  planType?: string | null;
  plan_type?: string | null;
};

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

function resolveWindowMinutes(window: RateLimitWindow): number | null {
  const candidates = [
    window.windowDurationMins,
    window.windowMinutes,
    window.window_minutes
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function resolveResetsAt(window: RateLimitWindow): number | null {
  const candidates = [window.resetsAt, window.resets_at];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function normalizeRateLimitWindow(
  window: RateLimitWindow,
  now: Date
): { usedPercent: number; windowMinutes: number | null; resetAt: Date | null } | null {
  const usedPercent =
    typeof window.usedPercent === "number"
      ? window.usedPercent
      : typeof window.used_percent === "number"
        ? window.used_percent
        : Number.NaN;

  if (!Number.isFinite(usedPercent)) {
    return null;
  }

  const windowMinutes = resolveWindowMinutes(window);
  const resetsAt = resolveResetsAt(window);
  let resetAt: Date | null = null;
  if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) {
    resetAt = new Date(resetsAt * 1000);
  } else if (windowMinutes !== null) {
    resetAt = new Date(now.getTime() + windowMinutes * 60000);
  }

  return { usedPercent, windowMinutes, resetAt };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 100);
}

export function rateLimitSnapshotToStatus(
  snapshot: RateLimitSnapshot,
  now: Date = new Date()
): CodexStatus | null {
  const candidates = [
    snapshot.primary ? { source: "primary", data: normalizeRateLimitWindow(snapshot.primary, now) } : null,
    snapshot.secondary ? { source: "secondary", data: normalizeRateLimitWindow(snapshot.secondary, now) } : null
  ].filter((item): item is { source: "primary" | "secondary"; data: { usedPercent: number; windowMinutes: number | null; resetAt: Date | null } } =>
    Boolean(item?.data)
  );

  if (candidates.length === 0) {
    return null;
  }

  let fiveHourCandidate: typeof candidates[0] | null = null;
  let weeklyCandidate: typeof candidates[0] | null = null;

  if (candidates.length === 2) {
    const [first, second] = candidates;
    if (first.data.windowMinutes !== null && second.data.windowMinutes !== null) {
      if (first.data.windowMinutes <= second.data.windowMinutes) {
        fiveHourCandidate = first;
        weeklyCandidate = second;
      } else {
        fiveHourCandidate = second;
        weeklyCandidate = first;
      }
    } else {
      fiveHourCandidate = first.source === "primary" ? first : second;
      weeklyCandidate = first.source === "primary" ? second : first;
    }
  } else {
    const lone = candidates[0];
    if (lone.data.windowMinutes !== null && lone.data.windowMinutes >= 24 * 60) {
      weeklyCandidate = lone;
    } else {
      fiveHourCandidate = lone;
    }
  }

  const windows: UsageWindow[] = [];

  if (fiveHourCandidate?.data.resetAt) {
    windows.push({
      key: "fiveHour",
      label: "5h",
      percentLeft: clampPercent(100 - fiveHourCandidate.data.usedPercent),
      resetAt: fiveHourCandidate.data.resetAt,
      resetText: fiveHourCandidate.data.resetAt.toISOString()
    });
  }

  if (weeklyCandidate?.data.resetAt) {
    windows.push({
      key: "weekly",
      label: "Weekly",
      percentLeft: clampPercent(100 - weeklyCandidate.data.usedPercent),
      resetAt: weeklyCandidate.data.resetAt,
      resetText: weeklyCandidate.data.resetAt.toISOString()
    });
  }

  if (windows.length === 0) {
    return null;
  }

  return {
    windows,
    credits: null,
    raw: JSON.stringify(snapshot)
  };
}

function resolveCodexHome(codexHome?: string): string {
  return codexHome ?? join(homedir(), ".codex");
}

type JsonlRateLimitEntry = {
  primary?: { used_percent?: number; window_duration_minutes?: number; resets_in_seconds?: number } | null;
  secondary?: { used_percent?: number; window_duration_minutes?: number; resets_in_seconds?: number } | null;
};

function convertJsonlRateLimits(entry: JsonlRateLimitEntry, now: Date): RateLimitSnapshot {
  const nowSecs = Math.floor(now.getTime() / 1000);

  const convertWindow = (
    w: { used_percent?: number; window_duration_minutes?: number; resets_in_seconds?: number } | null | undefined
  ): RateLimitWindow | null => {
    if (!w || typeof w.used_percent !== "number") {
      return null;
    }
    return {
      used_percent: w.used_percent,
      windowDurationMins: typeof w.window_duration_minutes === "number" ? w.window_duration_minutes : null,
      resetsAt: typeof w.resets_in_seconds === "number" ? nowSecs + w.resets_in_seconds : null
    };
  };

  return {
    primary: convertWindow(entry.primary),
    secondary: convertWindow(entry.secondary)
  };
}

async function readCodexRateLimitsFromSessions(
  codexHome: string,
  now: Date
): Promise<RateLimitSnapshot | null> {
  const sessionsDir = join(codexHome, "sessions");

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const date = new Date(now.getTime() - dayOffset * 86400000);
    const yyyy = date.getFullYear().toString();
    const mm = (date.getMonth() + 1).toString().padStart(2, "0");
    const dd = date.getDate().toString().padStart(2, "0");
    const dayDir = join(sessionsDir, yyyy, mm, dd);

    let files: string[];
    try {
      const entries = await readdir(dayDir);
      const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
      if (jsonlFiles.length === 0) {
        continue;
      }
      // Sort by modification time (newest first)
      const withStats = await Promise.all(
        jsonlFiles.map(async (f) => {
          const fullPath = join(dayDir, f);
          try {
            const s = await stat(fullPath);
            return { name: f, mtimeMs: s.mtimeMs };
          } catch {
            return { name: f, mtimeMs: 0 };
          }
        })
      );
      withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
      files = withStats.map((f) => join(dayDir, f.name));
    } catch {
      // Directory does not exist or is not readable; skip.
      continue;
    }

    for (const filePath of files) {
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      // Read in reverse (last lines = most recent)
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          typeof parsed !== "object" ||
          parsed === null
        ) {
          continue;
        }
        const obj = parsed as Record<string, unknown>;
        const payload = obj["payload"];
        if (
          typeof payload !== "object" ||
          payload === null
        ) {
          continue;
        }
        const p = payload as Record<string, unknown>;
        if (p["type"] !== "token_count") {
          continue;
        }
        const info = p["info"];
        if (typeof info !== "object" || info === null) {
          continue;
        }
        const rateLimits = (info as Record<string, unknown>)["rate_limits"];
        if (typeof rateLimits !== "object" || rateLimits === null) {
          continue;
        }
        return convertJsonlRateLimits(rateLimits as JsonlRateLimitEntry, now);
      }
    }
  }

  return null;
}

type AuthJson = {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
  account_id?: string;
};

async function fetchCodexRateLimitsFromApi(
  codexHome: string,
  timeoutMs: number,
  timingSink?: (phase: string, durationMs: number) => void
): Promise<RateLimitSnapshot | null> {
  const authPath = join(codexHome, "auth.json");
  let auth: AuthJson;
  try {
    const raw = await readFile(authPath, "utf8");
    auth = JSON.parse(raw) as AuthJson;
  } catch {
    return null;
  }

  const accessToken = auth?.tokens?.access_token;
  if (!accessToken) {
    return null;
  }

  const accountId = auth?.tokens?.account_id ?? auth?.account_id;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json"
  };
  if (accountId) {
    headers["chatgpt-account-id"] = accountId;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const apiStart = Date.now();
  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers,
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (timingSink) {
      timingSink("api", Date.now() - apiStart);
    }

    const rateLimits = data["rate_limits"];
    if (typeof rateLimits !== "object" || rateLimits === null) {
      return null;
    }

    const now = new Date();
    const nowSecs = Math.floor(now.getTime() / 1000);
    const rl = rateLimits as Record<string, unknown>;

    const convertApiWindow = (
      w: unknown
    ): RateLimitWindow | null => {
      if (typeof w !== "object" || w === null) {
        return null;
      }
      const ww = w as Record<string, unknown>;
      const usedPercent = ww["used_percent"];
      if (typeof usedPercent !== "number") {
        return null;
      }
      const limitWindowSeconds = ww["limit_window_seconds"];
      const resetAfterSeconds = ww["reset_after_seconds"];
      return {
        used_percent: usedPercent,
        windowDurationMins: typeof limitWindowSeconds === "number" ? limitWindowSeconds / 60 : null,
        resetsAt: typeof resetAfterSeconds === "number" ? nowSecs + resetAfterSeconds : null
      };
    };

    return {
      primary: convertApiWindow(rl["primary"]),
      secondary: convertApiWindow(rl["secondary"])
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCodexRateLimits(options?: {
  codexHome?: string;
  timeoutSeconds?: number;
  timingSink?: (phase: string, durationMs: number) => void;
}): Promise<RateLimitSnapshot | null> {
  const totalStart = Date.now();
  const codexHome = resolveCodexHome(options?.codexHome);
  const timeoutSeconds = options?.timeoutSeconds ?? 20;
  const timingSink = options?.timingSink;

  const sessionsStart = Date.now();
  const now = new Date();
  const sessionResult = await readCodexRateLimitsFromSessions(codexHome, now);
  if (timingSink) {
    timingSink("sessions", Date.now() - sessionsStart);
  }

  if (sessionResult !== null) {
    if (timingSink) {
      timingSink("total", Date.now() - totalStart);
    }
    return sessionResult;
  }

  const apiResult = await fetchCodexRateLimitsFromApi(codexHome, timeoutSeconds * 1000, timingSink);
  if (timingSink) {
    timingSink("total", Date.now() - totalStart);
  }
  return apiResult;
}

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
