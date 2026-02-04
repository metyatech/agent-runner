import fs from "node:fs";
import path from "node:path";
import type { AgentRunnerConfig } from "./config.js";

export type ReportMaintenanceDecision = {
  enabled: boolean;
  maxAgeDays: number;
  keepLatest: number;
  maxTotalBytes: number | null;
};

export type PruneReportsResult = {
  dir: string;
  scanned: number;
  deleted: number;
  deletedBytes: number;
  skipped: number;
  kept: number;
  dryRun: boolean;
};

type ReportFileInfo = {
  name: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
};

export function resolveReportsDir(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "reports");
}

export function resolveReportMaintenance(config: AgentRunnerConfig): ReportMaintenanceDecision {
  const raw = config.reportMaintenance;
  const enabled = raw ? raw.enabled !== false : true;

  const maxAgeDays =
    typeof raw?.maxAgeDays === "number" && Number.isFinite(raw.maxAgeDays) && raw.maxAgeDays >= 0
      ? Math.floor(raw.maxAgeDays)
      : 90;

  const keepLatest =
    typeof raw?.keepLatest === "number" && Number.isFinite(raw.keepLatest) && raw.keepLatest >= 0
      ? Math.floor(raw.keepLatest)
      : 500;

  const maxTotalMB =
    typeof raw?.maxTotalMB === "number" && Number.isFinite(raw.maxTotalMB) && raw.maxTotalMB >= 0
      ? raw.maxTotalMB
      : 256;
  const maxTotalBytes = maxTotalMB === 0 ? null : Math.floor(maxTotalMB * 1024 * 1024);

  return {
    enabled,
    maxAgeDays,
    keepLatest,
    maxTotalBytes
  };
}

function listReportFiles(dir: string): ReportFileInfo[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: ReportFileInfo[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;

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

function deleteFiles(files: ReportFileInfo[], dryRun: boolean): Omit<PruneReportsResult, "dir" | "scanned" | "dryRun"> {
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
  sortedNewestFirst: ReportFileInfo[],
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
  sortedNewestFirst: ReportFileInfo[],
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

export function pruneReports(options: {
  dir: string;
  decision: ReportMaintenanceDecision;
  dryRun: boolean;
  now?: Date;
}): PruneReportsResult {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const files = listReportFiles(options.dir);
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

  for (const filePath of selectByMaxAge(sorted, options.decision.maxAgeDays, options.decision.keepLatest, nowMs)) {
    selected.add(filePath);
  }

  if (options.decision.maxTotalBytes !== null) {
    selectByTotalSize(sorted, options.decision.keepLatest, options.decision.maxTotalBytes, selected);
  }

  const toDelete = sorted.filter((file) => selected.has(file.fullPath));
  const deletedResult = deleteFiles(toDelete, options.dryRun);
  const deletedPaths = new Set(toDelete.map((file) => file.fullPath));
  const kept = sorted.filter((file) => !deletedPaths.has(file.fullPath)).length;

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

