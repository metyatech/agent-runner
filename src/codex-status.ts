import { spawn } from "node:child_process";
import { resolveCodexCommand } from "./codex-command.js";

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

export type UsageGateConfig = {
  enabled: boolean;
  command: string;
  args: string[];
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

const windowRegex =
  /^\s*(5h|Weekly)\s+limit:\s*\[[^\]]*]\s*([0-9]+(?:\.[0-9]+)?)%\s*left\s*\(resets\s*(.+)\)\s*$/i;
const creditsRegex = /^\s*Credits:\s*([0-9]+)\s*credits?\s*$/i;

const monthMap: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11
};

function parseResetText(text: string, now: Date): Date | null {
  const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
  if (!timeMatch) {
    return null;
  }

  const hour = Number.parseInt(timeMatch[1], 10);
  const minute = Number.parseInt(timeMatch[2], 10);

  const onIndex = text.toLowerCase().indexOf(" on ");
  if (onIndex === -1) {
    const candidate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hour,
      minute,
      0,
      0
    );
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  const datePart = text.slice(onIndex + 4).replace(/[,]/g, "").trim();
  if (!datePart) {
    return null;
  }

  const tokens = datePart.split(/\s+/).filter(Boolean);
  let day: number | null = null;
  let month: number | null = null;
  let year: number | null = null;

  for (const token of tokens) {
    const yearMatch = token.match(/^\d{4}$/);
    if (yearMatch) {
      year = Number.parseInt(token, 10);
    }
  }

  const normalizedTokens = tokens.filter((token) => !/^\d{4}$/.test(token));
  if (normalizedTokens.length >= 2) {
    const first = normalizedTokens[0].toLowerCase();
    const second = normalizedTokens[1].toLowerCase();
    if (/^\d+$/.test(first)) {
      day = Number.parseInt(first, 10);
      month = monthMap[second.slice(0, 3)];
    } else if (/^\d+$/.test(second)) {
      month = monthMap[first.slice(0, 3)];
      day = Number.parseInt(second, 10);
    }
  }

  if (day === null || month === null) {
    return null;
  }

  const resolvedYear = year ?? now.getFullYear();
  const candidate = new Date(resolvedYear, month, day, hour, minute, 0, 0);

  if (!year && candidate.getTime() < now.getTime()) {
    candidate.setFullYear(candidate.getFullYear() + 1);
  }

  return candidate;
}

function normalizeWindowKey(label: string): UsageWindowKey | null {
  const lower = label.toLowerCase();
  if (lower.startsWith("5h")) {
    return "fiveHour";
  }
  if (lower.startsWith("weekly")) {
    return "weekly";
  }
  return null;
}

export function parseCodexStatus(output: string, now: Date = new Date()): CodexStatus | null {
  const cleaned = output.replace(/\u001b\[[0-9;]*m/g, "");
  const lines = cleaned.split(/\r?\n/);
  const windows: UsageWindow[] = [];
  let credits: number | null = null;

  for (const line of lines) {
    const trimmed = line.replace(/^[\s│|]+/, "").replace(/[\s│|]+$/, "");
    const windowMatch = trimmed.match(windowRegex);
    if (windowMatch) {
      const label = windowMatch[1];
      const key = normalizeWindowKey(label);
      if (!key) {
        continue;
      }
      const percentLeft = Number.parseFloat(windowMatch[2]);
      const resetText = windowMatch[3].trim();
      const resetAt = parseResetText(resetText, now);
      if (!Number.isFinite(percentLeft) || !resetAt) {
        continue;
      }
      windows.push({ key, label, percentLeft, resetAt, resetText });
      continue;
    }

    const creditsMatch = trimmed.match(creditsRegex);
    if (creditsMatch) {
      credits = Number.parseInt(creditsMatch[1], 10);
    }
  }

  if (windows.length === 0) {
    return null;
  }

  return { windows, credits, raw: cleaned };
}

export async function fetchCodexStatusOutput(
  command: string,
  args: string[],
  timeoutSeconds: number,
  cwd: string
): Promise<string> {
  const resolved = resolveCodexCommand(command, process.env.PATH);
  const finalArgs = [...resolved.prefixArgs, ...args];

  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, finalArgs, {
      cwd,
      env: process.env,
      shell: false
    });

    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Codex status timeout."));
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", () => {
      clearTimeout(timer);
      resolve(output);
    });

    try {
      child.stdin.write("/status\n/exit\n");
      child.stdin.end();
    } catch {
      // ignore stdin errors; output may already include status
    }
  });
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

  let weeklyMinutesToReset = Math.round(
    (weekly.resetAt.getTime() - now.getTime()) / 60000
  );
  if (!Number.isFinite(weeklyMinutesToReset)) {
    weeklyMinutesToReset = 0;
  }
  if (weeklyMinutesToReset < 0) {
    weeklyMinutesToReset = 0;
  }
  const weeklySchedule = gate.weeklySchedule;
  const fiveHourRemainingThreshold = gate.minRemainingPercent.fiveHour;

  if (weeklyMinutesToReset > weeklySchedule.startMinutes) {
    return {
      allow: false,
      reason: `Weekly window not close enough: ${weeklyMinutesToReset}m to reset (threshold ${weeklySchedule.startMinutes}m).`
    };
  }

  const span = weeklySchedule.startMinutes <= 0 ? 1 : weeklySchedule.startMinutes;
  const ratio = Math.min(Math.max(weeklyMinutesToReset / span, 0), 1);
  const weeklyRequired =
    weeklySchedule.minRemainingPercentAtEnd +
    (weeklySchedule.minRemainingPercentAtStart - weeklySchedule.minRemainingPercentAtEnd) *
      ratio;

  if (weekly.percentLeft < weeklyRequired) {
    return {
      allow: false,
      reason: `Weekly remaining too low: ${weekly.percentLeft}% left (threshold ${weeklyRequired.toFixed(
        1
      )}%).`
    };
  }

  if (fiveHour.percentLeft < fiveHourRemainingThreshold) {
    return {
      allow: false,
      reason: `5h remaining too low: ${fiveHour.percentLeft}% left (threshold ${fiveHourRemainingThreshold}%).`
    };
  }

  return {
    allow: true,
    reason: `Weekly window within ${weeklySchedule.startMinutes}m with ${weekly.percentLeft}% left and 5h has ${fiveHour.percentLeft}% remaining.`,
    window: weekly,
    minutesToReset: weeklyMinutesToReset
  };
}
