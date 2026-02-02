import fs from "node:fs";
import path from "node:path";
import type { RepoInfo } from "./github.js";

export type IdleHistoryEntry = {
  lastRunAt: string;
  lastTask: string;
};

export type IdleHistory = {
  repos: Record<string, IdleHistoryEntry>;
  taskCursor: number;
};

const defaultHistory: IdleHistory = {
  repos: {},
  taskCursor: 0
};

export function resolveIdleHistoryPath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "idle-history.json");
}

export function loadIdleHistory(historyPath: string): IdleHistory {
  if (!fs.existsSync(historyPath)) {
    return { ...defaultHistory };
  }
  const raw = fs.readFileSync(historyPath, "utf8");
  const parsed = JSON.parse(raw) as IdleHistory;

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid idle history at ${historyPath}`);
  }
  if (!parsed.repos || typeof parsed.repos !== "object") {
    throw new Error(`Invalid idle history at ${historyPath}`);
  }
  if (typeof parsed.taskCursor !== "number" || Number.isNaN(parsed.taskCursor)) {
    throw new Error(`Invalid idle history at ${historyPath}`);
  }

  return parsed;
}

export function saveIdleHistory(historyPath: string, history: IdleHistory): void {
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

export function selectIdleRepos(
  repos: RepoInfo[],
  history: IdleHistory,
  maxRuns: number,
  cooldownMinutes: number,
  now: Date = new Date()
): RepoInfo[] {
  if (maxRuns <= 0) {
    return [];
  }

  const cooldownMs = cooldownMinutes * 60 * 1000;
  const nowMs = now.getTime();

  const scored = repos.map((repo) => {
    const key = `${repo.owner}/${repo.repo}`;
    const entry = history.repos[key];
    const parsed = entry?.lastRunAt ? Date.parse(entry.lastRunAt) : Number.NaN;
    const lastRunAt = Number.isFinite(parsed) ? parsed : 0;
    const eligible = entry ? nowMs - lastRunAt >= cooldownMs : true;
    return { repo, lastRunAt, eligible };
  });

  return scored
    .filter((item) => item.eligible)
    .sort((a, b) => a.lastRunAt - b.lastRunAt)
    .slice(0, maxRuns)
    .map((item) => item.repo);
}

export function chooseIdleTask(tasks: string[], history: IdleHistory): { task: string; nextCursor: number } {
  if (tasks.length === 0) {
    throw new Error("Idle tasks list is empty.");
  }
  const index = history.taskCursor % tasks.length;
  const task = tasks[index];
  return { task, nextCursor: history.taskCursor + 1 };
}

export function recordIdleRun(
  history: IdleHistory,
  repo: RepoInfo,
  task: string,
  startedAt: string
): void {
  const key = `${repo.owner}/${repo.repo}`;
  history.repos[key] = { lastRunAt: startedAt, lastTask: task };
}
