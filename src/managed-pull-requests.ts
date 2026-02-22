import fs from "node:fs";
import path from "node:path";
import type { RepoInfo } from "./github.js";

type ManagedPullRequestState = {
  managedPullRequests: string[];
  updatedAt: string | null;
};

const DEFAULT_FILENAME = "managed-pull-requests.json";
const DEFAULT_LOCK_FILENAME = "managed-pull-requests.lock";
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
const DEFAULT_LOCK_RETRY_MS = 50;
const MAX_ENTRIES = 20_000;

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

export function resolveManagedPullRequestsStatePath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", DEFAULT_FILENAME);
}

function resolveLockPath(statePath: string): string {
  return path.join(path.dirname(statePath), DEFAULT_LOCK_FILENAME);
}

function buildKey(repo: RepoInfo, prNumber: number): string {
  return `${repo.owner}/${repo.repo}#${prNumber}`;
}

function parseKey(key: string): { repo: RepoInfo; prNumber: number; key: string } | null {
  const trimmed = key.trim();
  if (!trimmed) return null;
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(trimmed);
  if (!match) return null;
  const prNumber = Number.parseInt(match[3]!, 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0) return null;
  return {
    repo: { owner: match[1]!, repo: match[2]! },
    prNumber,
    key: trimmed
  };
}

function readState(statePath: string): ManagedPullRequestState {
  if (!fs.existsSync(statePath)) {
    return { managedPullRequests: [], updatedAt: null };
  }
  const raw = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<ManagedPullRequestState>;
  const entries = Array.isArray(parsed.managedPullRequests)
    ? parsed.managedPullRequests.filter(
        (value): value is string => typeof value === "string" && value.length > 0
      )
    : [];
  return {
    managedPullRequests: entries,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
  };
}

function writeState(statePath: string, keys: string[]): void {
  const payload: ManagedPullRequestState = {
    managedPullRequests: keys,
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(payload, null, 2));
}

async function withLock<T>(statePath: string, action: () => T | Promise<T>): Promise<T> {
  const lockPath = resolveLockPath(statePath);
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
        throw new Error("Timed out waiting for managed pull request state lock.");
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

export async function isManagedPullRequest(
  statePath: string,
  repo: RepoInfo,
  prNumber: number
): Promise<boolean> {
  if (!prNumber || prNumber <= 0) {
    return false;
  }
  const key = buildKey(repo, prNumber);
  return withLock(statePath, () => {
    const state = readState(statePath);
    return state.managedPullRequests.includes(key);
  });
}

export async function markManagedPullRequest(
  statePath: string,
  repo: RepoInfo,
  prNumber: number
): Promise<void> {
  if (!prNumber || prNumber <= 0) {
    return;
  }
  const key = buildKey(repo, prNumber);
  await withLock(statePath, () => {
    const state = readState(statePath);
    if (state.managedPullRequests.includes(key)) {
      return;
    }
    const next = [...state.managedPullRequests, key];
    const trimmed = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    writeState(statePath, trimmed);
  });
}

export async function listManagedPullRequests(
  statePath: string,
  options?: { limit?: number }
): Promise<Array<{ repo: RepoInfo; prNumber: number; key: string }>> {
  const limit = options?.limit ?? null;
  return withLock(statePath, () => {
    const state = readState(statePath);
    const parsed = state.managedPullRequests
      .map((value) => parseKey(value))
      .filter((value): value is { repo: RepoInfo; prNumber: number; key: string } =>
        Boolean(value)
      );
    if (!limit || limit <= 0 || parsed.length <= limit) {
      return parsed;
    }
    return parsed.slice(parsed.length - limit);
  });
}
