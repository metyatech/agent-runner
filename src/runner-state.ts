import fs from "node:fs";
import path from "node:path";
import type { IssueInfo, RepoInfo } from "./github.js";

export type RunningIssueRecord = {
  issueId: number;
  issueNumber: number;
  repo: RepoInfo;
  startedAt: string;
  pid: number;
  logPath: string;
};

export type RunnerState = {
  running: RunningIssueRecord[];
};

export function resolveRunnerStatePath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "running.json");
}

export function loadRunnerState(statePath: string): RunnerState {
  if (!fs.existsSync(statePath)) {
    return { running: [] };
  }
  const raw = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as RunnerState;
  if (!parsed || !Array.isArray(parsed.running)) {
    throw new Error(`Invalid runner state at ${statePath}`);
  }
  return parsed;
}

export function saveRunnerState(statePath: string, state: RunnerState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function recordRunningIssue(statePath: string, record: RunningIssueRecord): void {
  const state = loadRunnerState(statePath);
  const filtered = state.running.filter((entry) => entry.issueId !== record.issueId);
  filtered.push(record);
  saveRunnerState(statePath, { running: filtered });
}

export function removeRunningIssue(statePath: string, issueId: number): void {
  const state = loadRunnerState(statePath);
  const filtered = state.running.filter((entry) => entry.issueId !== issueId);
  saveRunnerState(statePath, { running: filtered });
}

export function findRunningRecord(state: RunnerState, issue: IssueInfo): RunningIssueRecord | null {
  return state.running.find((entry) => entry.issueId === issue.id) ?? null;
}

export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        return true;
      }
    }
    return false;
  }
}

export function evaluateRunningIssues(
  issues: IssueInfo[],
  state: RunnerState,
  aliveCheck: (pid: number) => boolean
): {
  missingRecord: IssueInfo[];
  deadProcess: Array<{ issue: IssueInfo; record: RunningIssueRecord }>;
} {
  const missingRecord: IssueInfo[] = [];
  const deadProcess: Array<{ issue: IssueInfo; record: RunningIssueRecord }> = [];

  for (const issue of issues) {
    const record = findRunningRecord(state, issue);
    if (!record) {
      missingRecord.push(issue);
      continue;
    }
    if (!aliveCheck(record.pid)) {
      deadProcess.push({ issue, record });
    }
  }

  return { missingRecord, deadProcess };
}
