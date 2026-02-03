import fs from "node:fs";
import path from "node:path";
import type { RepoInfo } from "./github.js";

export type ActivityKind = "issue" | "idle";

export type ActivityRecord = {
  id: string;
  kind: ActivityKind;
  engine?: "codex" | "copilot" | "gemini-pro" | "gemini-flash" | "amazon-q";
  repo: RepoInfo;
  startedAt: string;
  pid: number;
  logPath: string;
  issueId?: number;
  issueNumber?: number;
  task?: string;
};

export type ActivityState = {
  running: ActivityRecord[];
  updatedAt: string;
};

export function resolveActivityStatePath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "activity.json");
}

export function loadActivityState(statePath: string): ActivityState {
  if (!fs.existsSync(statePath)) {
    return { running: [], updatedAt: new Date(0).toISOString() };
  }
  const raw = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as ActivityState;
  if (!parsed || !Array.isArray(parsed.running)) {
    throw new Error(`Invalid activity state at ${statePath}`);
  }
  return parsed;
}

export function saveActivityState(statePath: string, state: ActivityState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function recordActivity(statePath: string, record: ActivityRecord): void {
  const state = loadActivityState(statePath);
  const filtered = state.running.filter((entry) => entry.id !== record.id);
  filtered.push(record);
  saveActivityState(statePath, {
    running: filtered,
    updatedAt: new Date().toISOString()
  });
}

export function removeActivity(statePath: string, id: string): void {
  const state = loadActivityState(statePath);
  const filtered = state.running.filter((entry) => entry.id !== id);
  saveActivityState(statePath, {
    running: filtered,
    updatedAt: new Date().toISOString()
  });
}
