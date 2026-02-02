const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_API_VERSION = "2025-05-01";

export type CopilotUsage = {
  percentRemaining: number;
  resetAt: Date;
  entitlement: number;
  overageUsed: number;
  overageEnabled: boolean;
  source: "user" | "header";
  raw: unknown;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizePercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function normalizeApiBaseUrl(value: string | undefined): string {
  const base = value?.trim() || DEFAULT_API_BASE_URL;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

export function parseCopilotUserInfo(
  data: unknown,
  now: Date = new Date()
): CopilotUsage | null {
  if (!isRecord(data)) {
    return null;
  }

  const quotaSnapshots = data.quota_snapshots;
  if (!isRecord(quotaSnapshots)) {
    return null;
  }

  const premium = quotaSnapshots.premium_interactions;
  if (!isRecord(premium)) {
    return null;
  }

  const entitlement = toNumber(premium.entitlement);
  const percentRemaining = toNumber(premium.percent_remaining);
  const resetText = typeof data.quota_reset_date === "string" ? data.quota_reset_date : null;

  if (entitlement === null || percentRemaining === null || !resetText) {
    return null;
  }

  const resetAt = new Date(resetText);
  if (Number.isNaN(resetAt.getTime())) {
    return null;
  }

  const overageUsed = toNumber(premium.overage_count) ?? 0;
  const overageEnabled = premium.overage_permitted === true;

  return {
    percentRemaining: normalizePercent(percentRemaining),
    resetAt,
    entitlement,
    overageUsed,
    overageEnabled,
    source: "user",
    raw: data
  };
}

export function parseCopilotQuotaHeader(
  headerValue: string,
  now: Date = new Date()
): CopilotUsage | null {
  const trimmed = headerValue.trim();
  if (!trimmed) {
    return null;
  }

  const params = new URLSearchParams(trimmed);
  const entitlement = toNumber(params.get("ent"));
  const percentRemaining = toNumber(params.get("rem"));

  if (entitlement === null || percentRemaining === null) {
    return null;
  }

  const resetText = params.get("rst");
  const resetAt = resetText ? new Date(resetText) : new Date(now.getTime());
  if (resetText && Number.isNaN(resetAt.getTime())) {
    return null;
  }
  if (!resetText) {
    resetAt.setMonth(resetAt.getMonth() + 1);
  }

  const overageUsed = toNumber(params.get("ov")) ?? 0;
  const overageEnabled = params.get("ovPerm") === "true";

  return {
    percentRemaining: normalizePercent(percentRemaining),
    resetAt,
    entitlement,
    overageUsed,
    overageEnabled,
    source: "header",
    raw: headerValue
  };
}

export async function fetchCopilotUsage(
  token: string,
  gate: CopilotUsageGateConfig,
  now: Date = new Date()
): Promise<CopilotUsage | null> {
  const baseUrl = normalizeApiBaseUrl(gate.apiBaseUrl);
  const url = `${baseUrl}/copilot_internal/user`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), gate.timeoutSeconds * 1000);
  const apiVersion = gate.apiVersion?.trim() || DEFAULT_API_VERSION;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": apiVersion,
        "User-Agent": "agent-runner"
      },
      signal: controller.signal
    });

    const headerValue =
      response.headers.get("x-quota-snapshot-premium_interactions") ||
      response.headers.get("x-quota-snapshot-premium_models");
    const headerUsage = headerValue ? parseCopilotQuotaHeader(headerValue, now) : null;

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Copilot user info request failed (${response.status} ${response.statusText}).`
      );
    }

    let parsed: unknown = null;
    if (bodyText.trim()) {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = null;
      }
    }

    const usage = parseCopilotUserInfo(parsed, now);
    return usage ?? headerUsage;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Copilot user info request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function evaluateCopilotUsageGate(
  usage: CopilotUsage,
  gate: CopilotUsageGateConfig,
  now: Date = new Date()
): CopilotUsageGateDecision {
  let minutesToReset = Math.round((usage.resetAt.getTime() - now.getTime()) / 60000);
  if (!Number.isFinite(minutesToReset)) {
    minutesToReset = 0;
  }
  if (minutesToReset < 0) {
    minutesToReset = 0;
  }

  const schedule = gate.monthlySchedule;
  if (minutesToReset > schedule.startMinutes) {
    return {
      allow: false,
      reason: `Monthly reset not close enough: ${minutesToReset}m to reset (threshold ${schedule.startMinutes}m).`,
      percentRemaining: usage.percentRemaining,
      minutesToReset,
      resetAt: usage.resetAt
    };
  }

  const span = schedule.startMinutes <= 0 ? 1 : schedule.startMinutes;
  const ratio = Math.min(Math.max(minutesToReset / span, 0), 1);
  const required =
    schedule.minRemainingPercentAtEnd +
    (schedule.minRemainingPercentAtStart - schedule.minRemainingPercentAtEnd) * ratio;

  if (usage.percentRemaining < required) {
    return {
      allow: false,
      reason: `Monthly remaining too low: ${usage.percentRemaining}% left (threshold ${required.toFixed(
        1
      )}%).`,
      percentRemaining: usage.percentRemaining,
      minutesToReset,
      resetAt: usage.resetAt
    };
  }

  return {
    allow: true,
    reason: `Monthly reset within ${schedule.startMinutes}m with ${usage.percentRemaining}% remaining.`,
    percentRemaining: usage.percentRemaining,
    minutesToReset,
    resetAt: usage.resetAt
  };
}
