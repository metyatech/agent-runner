import fs from "node:fs";
import path from "node:path";
import type { RepoInfo } from "./github.js";

export type ReviewQueueReason = "review_comment" | "review" | "approval";

export type ReviewQueueEntry = {
  issueId: number;
  prNumber: number;
  repo: RepoInfo;
  url: string;
  reason: ReviewQueueReason;
  requiresEngine: boolean;
  enqueuedAt: string;
};

type ReviewQueueState = {
  queued: ReviewQueueEntry[];
  updatedAt: string;
};

const DEFAULT_QUEUE_FILENAME = "review-queue.json";
const DEFAULT_LOCK_FILENAME = "review-queue.lock";
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
const DEFAULT_LOCK_RETRY_MS = 50;
const MAX_QUEUE_LENGTH = 10_000;

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveQueueDir(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state");
}

export function resolveReviewQueuePath(workdirRoot: string): string {
  return path.join(resolveQueueDir(workdirRoot), DEFAULT_QUEUE_FILENAME);
}

function resolveLockPath(queuePath: string): string {
  return path.join(path.dirname(queuePath), DEFAULT_LOCK_FILENAME);
}

function readQueueState(queuePath: string): ReviewQueueState {
  if (!fs.existsSync(queuePath)) {
    return { queued: [], updatedAt: new Date().toISOString() };
  }
  const raw = fs.readFileSync(queuePath, "utf8");
  const parsed = JSON.parse(raw) as ReviewQueueState;
  if (!parsed || !Array.isArray(parsed.queued)) {
    throw new Error(`Invalid review queue at ${queuePath}`);
  }
  return parsed;
}

function writeQueueState(queuePath: string, queued: ReviewQueueEntry[]): void {
  const payload: ReviewQueueState = {
    queued,
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(payload, null, 2));
}

async function withQueueLock<T>(queuePath: string, action: () => T | Promise<T>): Promise<T> {
  const lockPath = resolveLockPath(queuePath);
  const start = Date.now();

  while (true) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const payload = { pid: process.pid, startedAt: new Date().toISOString() };
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
      fs.closeSync(fd);
      break;
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        const code = (error as { code?: string }).code;
        if (code !== "EEXIST") {
          throw error;
        }
      } else {
        throw error;
      }

      try {
        const existing = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
        if (!isProcessAlive(existing.pid)) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      }

      if (Date.now() - start >= DEFAULT_LOCK_TIMEOUT_MS) {
        throw new Error("Timed out waiting for review queue lock.");
      }
      await new Promise((resolve) => setTimeout(resolve, DEFAULT_LOCK_RETRY_MS));
    }
  }

  try {
    return await action();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

export function loadReviewQueue(queuePath: string): ReviewQueueEntry[] {
  return readQueueState(queuePath).queued;
}

export async function enqueueReviewTask(
  queuePath: string,
  entry: Omit<ReviewQueueEntry, "enqueuedAt">
): Promise<boolean> {
  return withQueueLock(queuePath, () => {
    const state = readQueueState(queuePath);
    if (state.queued.some((existing) => existing.issueId === entry.issueId)) {
      return false;
    }
    const next: ReviewQueueEntry[] = [
      ...state.queued,
      {
        ...entry,
        enqueuedAt: new Date().toISOString()
      }
    ];
    const trimmed =
      next.length > MAX_QUEUE_LENGTH ? next.slice(next.length - MAX_QUEUE_LENGTH) : next;
    writeQueueState(queuePath, trimmed);
    return true;
  });
}

export async function removeReviewTasks(queuePath: string, issueIds: number[]): Promise<void> {
  if (issueIds.length === 0) {
    return;
  }
  const uniqueIds = new Set(issueIds);
  await withQueueLock(queuePath, () => {
    const state = readQueueState(queuePath);
    const next = state.queued.filter((entry) => !uniqueIds.has(entry.issueId));
    writeQueueState(queuePath, next);
  });
}

export async function takeReviewTasks(
  queuePath: string,
  maxEntries: number
): Promise<ReviewQueueEntry[]> {
  const limit = Math.max(0, Math.floor(maxEntries));
  if (limit <= 0) {
    return [];
  }
  return withQueueLock(queuePath, () => {
    const state = readQueueState(queuePath);
    const taken = state.queued.slice(0, limit);
    if (taken.length === 0) {
      return [];
    }
    const remaining = state.queued.slice(taken.length);
    writeQueueState(queuePath, remaining);
    return taken;
  });
}

export async function takeReviewTasksWhere(
  queuePath: string,
  maxEntries: number,
  predicate: (entry: ReviewQueueEntry) => boolean
): Promise<ReviewQueueEntry[]> {
  const limit = Math.max(0, Math.floor(maxEntries));
  if (limit <= 0) {
    return [];
  }
  return withQueueLock(queuePath, () => {
    const state = readQueueState(queuePath);
    const taken: ReviewQueueEntry[] = [];
    const remaining: ReviewQueueEntry[] = [];
    for (const entry of state.queued) {
      if (taken.length < limit && predicate(entry)) {
        taken.push(entry);
      } else {
        remaining.push(entry);
      }
    }
    if (taken.length === 0) {
      return [];
    }
    writeQueueState(queuePath, remaining);
    return taken;
  });
}
