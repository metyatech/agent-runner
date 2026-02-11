import fs from "node:fs";
import path from "node:path";
import type { RepoInfo, IssueInfo } from "./github.js";
import type { AgentRunnerConfig } from "./config.js";

export type WebhookQueueEntry = {
  issueId: number;
  issueNumber: number;
  repo: RepoInfo;
  url: string;
  title: string;
  enqueuedAt: string;
};

type WebhookQueueState = {
  queued: WebhookQueueEntry[];
  updatedAt: string;
};

const DEFAULT_QUEUE_FILENAME = "webhook-queue.json";
const DEFAULT_LOCK_FILENAME = "webhook-queue.lock";
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
const DEFAULT_LOCK_RETRY_MS = 50;

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

export function resolveWebhookQueuePath(workdirRoot: string, config?: AgentRunnerConfig["webhooks"]): string {
  const configured = config?.queueFile;
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(resolveQueueDir(workdirRoot), DEFAULT_QUEUE_FILENAME);
}

function resolveWebhookQueueLockPath(queuePath: string): string {
  return path.join(path.dirname(queuePath), DEFAULT_LOCK_FILENAME);
}

function readQueueState(queuePath: string): WebhookQueueState {
  if (!fs.existsSync(queuePath)) {
    return { queued: [], updatedAt: new Date().toISOString() };
  }
  const raw = fs.readFileSync(queuePath, "utf8");
  const parsed = JSON.parse(raw) as WebhookQueueState;
  if (!parsed || !Array.isArray(parsed.queued)) {
    throw new Error(`Invalid webhook queue at ${queuePath}`);
  }
  return parsed;
}

function writeQueueState(queuePath: string, queued: WebhookQueueEntry[]): void {
  const payload: WebhookQueueState = {
    queued,
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(payload, null, 2));
}

async function withQueueLock<T>(queuePath: string, action: () => T | Promise<T>): Promise<T> {
  const lockPath = resolveWebhookQueueLockPath(queuePath);
  const start = Date.now();

  while (true) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const payload = {
        pid: process.pid,
        startedAt: new Date().toISOString()
      };
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
        throw new Error("Timed out waiting for webhook queue lock.");
      }
      await new Promise(resolve => setTimeout(resolve, DEFAULT_LOCK_RETRY_MS));
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

export function loadWebhookQueue(queuePath: string): WebhookQueueEntry[] {
  return readQueueState(queuePath).queued;
}

export async function enqueueWebhookIssue(queuePath: string, issue: IssueInfo): Promise<boolean> {
  return withQueueLock(queuePath, () => {
    const state = readQueueState(queuePath);
    if (state.queued.some(entry => entry.issueId === issue.id)) {
      return false;
    }
    state.queued.push({
      issueId: issue.id,
      issueNumber: issue.number,
      repo: issue.repo,
      url: issue.url,
      title: issue.title,
      enqueuedAt: new Date().toISOString()
    });
    writeQueueState(queuePath, state.queued);
    return true;
  });
}

export async function removeWebhookIssues(queuePath: string, issueIds: number[]): Promise<void> {
  if (issueIds.length === 0) {
    return;
  }
  const uniqueIds = new Set(issueIds);
  await withQueueLock(queuePath, () => {
    const state = readQueueState(queuePath);
    const next = state.queued.filter(entry => !uniqueIds.has(entry.issueId));
    writeQueueState(queuePath, next);
  });
}

export async function replaceWebhookQueue(queuePath: string, queued: WebhookQueueEntry[]): Promise<void> {
  await withQueueLock(queuePath, () => {
    writeQueueState(queuePath, queued);
  });
}
