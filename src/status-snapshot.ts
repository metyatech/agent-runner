import fs from "node:fs";
import path from "node:path";
import {
  loadActivityState,
  pruneDeadActivityRecords,
  resolveActivityStatePath,
  type ActivityRecord
} from "./activity-state.js";
import { loadReviewQueue, resolveReviewQueuePath, type ReviewQueueEntry } from "./review-queue.js";
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

export type ReviewFollowupSnapshot = ReviewQueueEntry & {
  enqueuedAtLocal: string | null;
  waitMinutes: number;
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
  reviewFollowups: ReviewFollowupSnapshot[];
  latestTaskRun: FileSnapshot | null;
  latestIdle: FileSnapshot | null;
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

function listRecentFiles(dir: string, limit: number, exclude?: RegExp): FileSnapshot[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (!exclude || !exclude.test(entry.name)))
    .map((entry) => {
      const fullPath = path.join(dir, entry.name);
      const stat = fs.statSync(fullPath);
      const updatedAt = new Date(stat.mtimeMs).toISOString();
      return { path: fullPath, updatedAt, updatedAtLocal: formatLocal(updatedAt) };
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return entries.slice(0, limit);
}

function snapshotFile(filePath: string): FileSnapshot | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const stat = fs.statSync(filePath);
  const updatedAt = new Date(stat.mtimeMs).toISOString();
  return { path: filePath, updatedAt, updatedAtLocal: formatLocal(updatedAt) };
}

function readPointerTarget(pointerPath: string): string | null {
  if (!fs.existsSync(pointerPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(pointerPath, "utf8").trim();
    if (!raw) {
      return null;
    }
    return raw.split(/\r?\n/)[0] ?? null;
  } catch {
    return null;
  }
}

function snapshotFromPointer(pointerPath: string): FileSnapshot | null {
  const target = readPointerTarget(pointerPath);
  if (!target) {
    return null;
  }
  return snapshotFile(target);
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
      engine: "codex" as const,
      repo: record.repo,
      startedAt: record.startedAt,
      pid: record.pid,
      logPath: record.logPath,
      issueId: record.issueId,
      issueNumber: record.issueNumber
    }));
  return records.concat(additions);
}

function toReviewFollowupSnapshot(entry: ReviewQueueEntry, nowMs: number): ReviewFollowupSnapshot {
  const enqueuedMs = safeParseDate(entry.enqueuedAt);
  const waitMs = enqueuedMs === null ? 0 : Math.max(0, nowMs - enqueuedMs);
  const waitMinutes = Math.round((waitMs / 60000) * 10) / 10;
  return {
    ...entry,
    enqueuedAtLocal: formatLocal(entry.enqueuedAt),
    waitMinutes
  };
}

export function buildStatusSnapshot(workdirRoot: string): StatusSnapshot {
  const now = new Date();
  const nowMs = now.getTime();
  const statePath = resolveActivityStatePath(workdirRoot);
  let activityUpdatedAt: string | null = null;
  let records: ActivityRecord[] = [];

  if (fs.existsSync(statePath)) {
    try {
      pruneDeadActivityRecords(statePath, isProcessAlive, ["idle"]);
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
  const latestTaskRun = snapshotFromPointer(path.join(logsDir, "latest-task-run.path"));
  const latestIdle = snapshotFromPointer(path.join(logsDir, "latest-idle.path"));
  const reviewFollowups = loadReviewQueue(resolveReviewQueuePath(workdirRoot)).map((entry) =>
    toReviewFollowupSnapshot(entry, nowMs)
  );

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
    reviewFollowups,
    latestTaskRun,
    latestIdle,
    logs: listRecentFiles(logsDir, 5, /\.path$|^agent-runner-run-.*\.(out|err)\.log$/i),
    reports: listRecentFiles(reportsDir, 5)
  };
}
