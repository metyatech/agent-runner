import fs from "node:fs";
import path from "node:path";
import type { IssueInfo } from "./github.js";

export type IssueSessionRecord = {
  issueId: number;
  issueNumber: number;
  repo: {
    owner: string;
    repo: string;
  };
  sessionId: string;
  updatedAt: string;
};

type IssueSessionState = {
  sessions: IssueSessionRecord[];
};

export function resolveIssueSessionStatePath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "issue-sessions.json");
}

function loadState(statePath: string): IssueSessionState {
  if (!fs.existsSync(statePath)) {
    return { sessions: [] };
  }
  const raw = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as IssueSessionState;
  if (!parsed || !Array.isArray(parsed.sessions)) {
    throw new Error(`Invalid issue session state at ${statePath}`);
  }
  return parsed;
}

function saveState(statePath: string, state: IssueSessionState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function sameIssue(a: IssueSessionRecord, issue: Pick<IssueInfo, "id">): boolean {
  return a.issueId === issue.id;
}

export function setIssueSession(
  statePath: string,
  issue: IssueInfo,
  sessionId: string
): void {
  const state = loadState(statePath);
  const next = state.sessions.filter((entry) => !sameIssue(entry, issue));
  next.push({
    issueId: issue.id,
    issueNumber: issue.number,
    repo: issue.repo,
    sessionId,
    updatedAt: new Date().toISOString()
  });
  saveState(statePath, { sessions: next });
}

export function getIssueSession(statePath: string, issue: Pick<IssueInfo, "id">): string | null {
  const state = loadState(statePath);
  const match = state.sessions.find((entry) => sameIssue(entry, issue));
  return match?.sessionId ?? null;
}

export function clearIssueSession(statePath: string, issueId: number): void {
  const state = loadState(statePath);
  const next = state.sessions.filter((entry) => entry.issueId !== issueId);
  if (next.length === state.sessions.length) {
    return;
  }
  saveState(statePath, { sessions: next });
}
