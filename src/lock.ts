import fs from "node:fs";
import path from "node:path";

export type LockHandle = {
  path: string;
};

export type AcquireLockRetryOptions = {
  timeoutMs?: number;
  retryMs?: number;
};

const DEFAULT_RETRY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_MS = 100;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(lockPath: string): LockHandle {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });

  try {
    const payload = {
      pid: process.pid,
      startedAt: new Date().toISOString()
    };
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
    fs.closeSync(fd);
    return { path: lockPath };
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    if (!fs.existsSync(lockPath)) {
      throw error;
    }

    const existing = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: number;
    };
    if (existing.pid && isProcessAlive(existing.pid)) {
      throw new Error(`Runner already active (pid ${existing.pid}).`);
    }

    fs.unlinkSync(lockPath);
    return acquireLock(lockPath);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function tryAcquireLock(lockPath: string): LockHandle | null {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });

  while (true) {
    try {
      const payload = {
        pid: process.pid,
        startedAt: new Date().toISOString()
      };
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
      fs.closeSync(fd);
      return { path: lockPath };
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        const code = (error as { code?: string }).code;
        if (code !== "EEXIST") {
          throw error;
        }
      } else {
        throw error;
      }

      if (!fs.existsSync(lockPath)) {
        continue;
      }

      try {
        const existing = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
        if (!existing.pid || !isProcessAlive(existing.pid)) {
          fs.unlinkSync(lockPath);
          continue;
        }
        return null;
      } catch {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      }
    }
  }
}

export async function acquireLockWithRetry(
  lockPath: string,
  options: AcquireLockRetryOptions = {}
): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const start = Date.now();

  while (true) {
    const lock = tryAcquireLock(lockPath);
    if (lock) {
      return lock;
    }
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Timed out waiting for lock: ${lockPath}`);
    }
    await sleep(retryMs);
  }
}

export function releaseLock(lock: LockHandle): void {
  if (fs.existsSync(lock.path)) {
    fs.unlinkSync(lock.path);
  }
}
