import fs from "node:fs";
import path from "node:path";

export type LockHandle = {
  path: string;
};

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

export function releaseLock(lock: LockHandle): void {
  if (fs.existsSync(lock.path)) {
    fs.unlinkSync(lock.path);
  }
}
