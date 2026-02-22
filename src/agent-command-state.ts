import fs from "node:fs";
import path from "node:path";

type AgentCommandState = {
  processedCommentIds: number[];
  updatedAt: string | null;
};

const DEFAULT_FILENAME = "agent-command-state.json";
const DEFAULT_LOCK_FILENAME = "agent-command-state.lock";
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

export function resolveAgentCommandStatePath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", DEFAULT_FILENAME);
}

function resolveLockPath(statePath: string): string {
  return path.join(path.dirname(statePath), DEFAULT_LOCK_FILENAME);
}

function readState(statePath: string): AgentCommandState {
  if (!fs.existsSync(statePath)) {
    return { processedCommentIds: [], updatedAt: null };
  }
  const raw = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<AgentCommandState>;
  const ids = Array.isArray(parsed.processedCommentIds)
    ? parsed.processedCommentIds.filter(
        (value): value is number => typeof value === "number" && value > 0
      )
    : [];
  return {
    processedCommentIds: ids,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
  };
}

function writeState(statePath: string, ids: number[]): void {
  const payload: AgentCommandState = {
    processedCommentIds: ids,
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
        throw new Error("Timed out waiting for agent command state lock.");
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

export async function hasProcessedAgentCommandComment(
  statePath: string,
  commentId: number
): Promise<boolean> {
  if (!commentId || commentId <= 0) {
    return false;
  }
  return withLock(statePath, () => {
    const state = readState(statePath);
    return state.processedCommentIds.includes(commentId);
  });
}

export async function markAgentCommandCommentProcessed(
  statePath: string,
  commentId: number
): Promise<void> {
  if (!commentId || commentId <= 0) {
    return;
  }
  await withLock(statePath, () => {
    const state = readState(statePath);
    if (state.processedCommentIds.includes(commentId)) {
      return;
    }
    const next = [...state.processedCommentIds, commentId];
    const trimmed = next.length > 10_000 ? next.slice(next.length - 10_000) : next;
    writeState(statePath, trimmed);
  });
}
