import fs from "node:fs";
import path from "node:path";
import type { AgentRunnerConfig } from "./config.js";

export type LogMaintenanceDecision = {
  enabled: boolean;
  maxAgeDays: number;
  keepLatest: number;
  maxTotalBytes: number | null;
  taskRunKeepLatest: number;
  writeLatestPointers: boolean;
};

export type PruneLogsResult = {
  dir: string;
  scanned: number;
  deleted: number;
  deletedBytes: number;
  skipped: number;
  kept: number;
  dryRun: boolean;
};

type LogFileInfo = {
  name: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
};

export function resolveLogsDir(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "logs");
}

export function resolveLogMaintenance(config: AgentRunnerConfig): LogMaintenanceDecision {
  const raw = config.logMaintenance;
  const enabled = raw ? raw.enabled !== false : true;

  const maxAgeDays =
    typeof raw?.maxAgeDays === "number" && Number.isFinite(raw.maxAgeDays) && raw.maxAgeDays >= 0
      ? Math.floor(raw.maxAgeDays)
      : 30;

  const keepLatest =
    typeof raw?.keepLatest === "number" && Number.isFinite(raw.keepLatest) && raw.keepLatest >= 0
      ? Math.floor(raw.keepLatest)
      : 2000;

  const taskRunKeepLatest =
    typeof raw?.taskRunKeepLatest === "number" && Number.isFinite(raw.taskRunKeepLatest) && raw.taskRunKeepLatest >= 0
      ? Math.floor(raw.taskRunKeepLatest)
      : 200;

  const maxTotalMB =
    typeof raw?.maxTotalMB === "number" && Number.isFinite(raw.maxTotalMB) && raw.maxTotalMB >= 0
      ? raw.maxTotalMB
      : 1024;
  const maxTotalBytes = maxTotalMB === 0 ? null : Math.floor(maxTotalMB * 1024 * 1024);

  const writeLatestPointers = raw?.writeLatestPointers !== false;

  return {
    enabled,
    maxAgeDays,
    keepLatest,
    maxTotalBytes,
    taskRunKeepLatest,
    writeLatestPointers
  };
}

function listLogFiles(dir: string): LogFileInfo[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: LogFileInfo[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".log")) continue;

    const fullPath = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    files.push({
      name: entry.name,
      fullPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }

  return files;
}

function deleteFiles(files: LogFileInfo[], dryRun: boolean): Omit<PruneLogsResult, "dir" | "scanned" | "dryRun"> {
  let deleted = 0;
  let deletedBytes = 0;
  let skipped = 0;

  for (const file of files) {
    if (dryRun) {
      deleted += 1;
      deletedBytes += file.size;
      continue;
    }

    try {
      fs.unlinkSync(file.fullPath);
      deleted += 1;
      deletedBytes += file.size;
    } catch {
      skipped += 1;
    }
  }

  return {
    deleted,
    deletedBytes,
    skipped,
    kept: 0
  };
}

function selectByMaxAge(
  sortedNewestFirst: LogFileInfo[],
  maxAgeDays: number,
  keepLatest: number,
  nowMs: number
): Set<string> {
  if (maxAgeDays <= 0) return new Set();
  const cutoff = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
  const selected = new Set<string>();

  for (let index = keepLatest; index < sortedNewestFirst.length; index += 1) {
    const file = sortedNewestFirst[index];
    if (file.mtimeMs < cutoff) {
      selected.add(file.fullPath);
    }
  }

  return selected;
}

function selectByTotalSize(
  sortedNewestFirst: LogFileInfo[],
  keepLatest: number,
  maxTotalBytes: number,
  alreadySelected: Set<string>
): Set<string> {
  let total = 0;
  for (const file of sortedNewestFirst) {
    if (alreadySelected.has(file.fullPath)) continue;
    total += file.size;
  }

  if (total <= maxTotalBytes) return alreadySelected;

  for (let index = sortedNewestFirst.length - 1; index >= keepLatest; index -= 1) {
    const file = sortedNewestFirst[index];
    if (alreadySelected.has(file.fullPath)) continue;
    alreadySelected.add(file.fullPath);
    total -= file.size;
    if (total <= maxTotalBytes) break;
  }

  return alreadySelected;
}

function selectTaskRunOverflow(sortedNewestFirst: LogFileInfo[], keepLatest: number): Set<string> {
  const selected = new Set<string>();
  const taskRun = sortedNewestFirst.filter(file => file.name.startsWith("task-run-"));
  if (keepLatest <= 0) {
    for (const file of taskRun) selected.add(file.fullPath);
    return selected;
  }

  for (let index = keepLatest; index < taskRun.length; index += 1) {
    selected.add(taskRun[index].fullPath);
  }

  return selected;
}

export function pruneLogs(options: {
  dir: string;
  decision: LogMaintenanceDecision;
  dryRun: boolean;
  now?: Date;
}): PruneLogsResult {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const files = listLogFiles(options.dir);
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!options.decision.enabled) {
    return {
      dir: options.dir,
      scanned: sorted.length,
      deleted: 0,
      deletedBytes: 0,
      skipped: 0,
      kept: sorted.length,
      dryRun: options.dryRun
    };
  }

  const selected = new Set<string>();

  for (const filePath of selectTaskRunOverflow(sorted, options.decision.taskRunKeepLatest)) {
    selected.add(filePath);
  }

  for (const filePath of selectByMaxAge(sorted, options.decision.maxAgeDays, options.decision.keepLatest, nowMs)) {
    selected.add(filePath);
  }

  if (options.decision.maxTotalBytes !== null) {
    selectByTotalSize(sorted, options.decision.keepLatest, options.decision.maxTotalBytes, selected);
  }

  const toDelete = sorted.filter(file => selected.has(file.fullPath));
  const deletedResult = deleteFiles(toDelete, options.dryRun);
  const deletedPaths = new Set(toDelete.map(file => file.fullPath));
  const kept = sorted.filter(file => !deletedPaths.has(file.fullPath)).length;

  return {
    dir: options.dir,
    scanned: sorted.length,
    deleted: deletedResult.deleted,
    deletedBytes: deletedResult.deletedBytes,
    skipped: deletedResult.skipped,
    kept,
    dryRun: options.dryRun
  };
}

export function writeLatestPointer(logDir: string, name: string, logPath: string): void {
  const pointerPath = path.join(logDir, `latest-${name}.path`);
  try {
    fs.writeFileSync(pointerPath, `${logPath}\n`, "utf8");
  } catch {
    // best-effort
  }
}
