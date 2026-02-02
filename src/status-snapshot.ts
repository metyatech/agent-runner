import fs from "node:fs";
import path from "node:path";
import {
  loadActivityState,
  resolveActivityStatePath,
  type ActivityRecord
} from "./activity-state.js";
import { isProcessAlive, loadRunnerState, resolveRunnerStatePath } from "./runner-state.js";
import { isStopRequested } from "./stop-flag.js";

export type ActivitySnapshot = ActivityRecord & {
  alive: boolean;
  ageMinutes: number;
  startedAtLocal: string | null;
};

export type FileSnapshot = {
  path: string;
  updatedAt: string;
  updatedAtLocal: string | null;
};

export type StatusSnapshot = {
  generatedAt: string;
  generatedAtLocal: string;
  workdirRoot: string;
  busy: boolean;
  stopRequested: boolean;
  running: ActivitySnapshot[];
  stale: ActivitySnapshot[];
  activityUpdatedAt: string | null;
  activityUpdatedAtLocal: string | null;
  logs: FileSnapshot[];
  reports: FileSnapshot[];
};

function safeParseDate(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatLocal(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, { timeZoneName: "short" });
}

function toSnapshot(record: ActivityRecord, nowMs: number): ActivitySnapshot {
  const startedMs = safeParseDate(record.startedAt);
  const ageMs = startedMs === null ? 0 : Math.max(0, nowMs - startedMs);
  const ageMinutes = Math.round((ageMs / 60000) * 10) / 10;
  return {
    ...record,
    alive: isProcessAlive(record.pid),
    ageMinutes,
    startedAtLocal: formatLocal(record.startedAt)
  };
}

function listRecentFiles(dir: string, limit: number): FileSnapshot[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const fullPath = path.join(dir, entry.name);
      const stat = fs.statSync(fullPath);
      const updatedAt = new Date(stat.mtimeMs).toISOString();
      return { path: fullPath, updatedAt, updatedAtLocal: formatLocal(updatedAt) };
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return entries.slice(0, limit);
}

function mergeRunnerState(
  records: ActivityRecord[],
  workdirRoot: string
): ActivityRecord[] {
  const statePath = resolveRunnerStatePath(workdirRoot);
  if (!fs.existsSync(statePath)) {
    return records;
  }
  const state = loadRunnerState(statePath);
  const existingIssueIds = new Set(
    records
      .filter((record) => record.issueId !== undefined)
      .map((record) => record.issueId)
  );
  const additions = state.running
    .filter((record) => !existingIssueIds.has(record.issueId))
    .map((record) => ({
      id: `issue:${record.issueId}`,
      kind: "issue" as const,
      repo: record.repo,
      startedAt: record.startedAt,
      pid: record.pid,
      logPath: record.logPath,
      issueId: record.issueId,
      issueNumber: record.issueNumber
    }));
  return records.concat(additions);
}

export function buildStatusSnapshot(workdirRoot: string): StatusSnapshot {
  const now = new Date();
  const nowMs = now.getTime();
  const statePath = resolveActivityStatePath(workdirRoot);
  let activityUpdatedAt: string | null = null;
  let records: ActivityRecord[] = [];

  if (fs.existsSync(statePath)) {
    try {
      const state = loadActivityState(statePath);
      activityUpdatedAt = state.updatedAt;
      records = state.running.slice();
    } catch {
      records = [];
      activityUpdatedAt = null;
    }
  }

  records = mergeRunnerState(records, workdirRoot);
  const snapshots = records.map((record) => toSnapshot(record, nowMs));
  const running = snapshots.filter((record) => record.alive);
  const stale = snapshots.filter((record) => !record.alive);

  const logsDir = path.resolve(workdirRoot, "agent-runner", "logs");
  const reportsDir = path.resolve(workdirRoot, "agent-runner", "reports");

  const generatedAt = now.toISOString();
  return {
    generatedAt,
    generatedAtLocal: formatLocal(generatedAt) ?? generatedAt,
    workdirRoot,
    busy: running.length > 0,
    stopRequested: isStopRequested(workdirRoot),
    running,
    stale,
    activityUpdatedAt,
    activityUpdatedAtLocal: formatLocal(activityUpdatedAt),
    logs: listRecentFiles(logsDir, 5),
    reports: listRecentFiles(reportsDir, 5)
  };
}
