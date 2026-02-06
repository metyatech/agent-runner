import fs from "node:fs";
import path from "node:path";
import type { IssueInfo, RepoInfo } from "./github.js";

export type ScheduledRetryRecord = {
  issueId: number;
  issueNumber: number;
  repo: RepoInfo;
  runAfter: string;
  reason: "codex_quota";
  sessionId: string | null;
  updatedAt: string;
};

type ScheduledRetryState = {
  retries: ScheduledRetryRecord[];
};

export function resolveScheduledRetryStatePath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "scheduled-retries.json");
}

function loadState(statePath: string): ScheduledRetryState {
  if (!fs.existsSync(statePath)) {
    return { retries: [] };
  }
  const raw = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as ScheduledRetryState;
  if (!parsed || !Array.isArray(parsed.retries)) {
    throw new Error(`Invalid scheduled retry state at ${statePath}`);
  }
  return parsed;
}

function saveState(statePath: string, state: ScheduledRetryState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function scheduleRetry(
  statePath: string,
  issue: IssueInfo,
  runAfter: string,
  sessionId: string | null
): void {
  const state = loadState(statePath);
  const next = state.retries.filter((entry) => entry.issueId !== issue.id);
  next.push({
    issueId: issue.id,
    issueNumber: issue.number,
    repo: issue.repo,
    runAfter,
    reason: "codex_quota",
    sessionId,
    updatedAt: new Date().toISOString()
  });
  saveState(statePath, { retries: next });
}

export function clearRetry(statePath: string, issueId: number): void {
  const state = loadState(statePath);
  const next = state.retries.filter((entry) => entry.issueId !== issueId);
  if (next.length === state.retries.length) {
    return;
  }
  saveState(statePath, { retries: next });
}

export function takeDueRetries(
  statePath: string,
  now: Date
): ScheduledRetryRecord[] {
  const state = loadState(statePath);
  if (state.retries.length === 0) {
    return [];
  }

  const nowMs = now.getTime();
  const due: ScheduledRetryRecord[] = [];
  const pending: ScheduledRetryRecord[] = [];

  for (const entry of state.retries) {
    const scheduled = Date.parse(entry.runAfter);
    if (!Number.isNaN(scheduled) && scheduled <= nowMs) {
      due.push(entry);
      continue;
    }
    pending.push(entry);
  }

  if (pending.length !== state.retries.length) {
    saveState(statePath, { retries: pending });
  }

  return due;
}
