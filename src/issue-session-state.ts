import type { IssueInfo } from "./github.js";
import { resolveStateDbPath, upsertRepo, withStateDb } from "./state-db.js";

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
  return resolveStateDbPath(workdirRoot);
}

function loadState(statePath: string): IssueSessionState {
  return withStateDb(statePath, (db) => {
    const rows = db
      .prepare(`
        SELECT
          s.issue_id AS issueId,
          s.issue_number AS issueNumber,
          r.owner,
          r.repo,
          s.session_id AS sessionId,
          s.updated_at AS updatedAt
        FROM issue_sessions s
        JOIN repos r ON r.id = s.repo_id
      `)
      .all() as Array<{
      issueId: number;
      issueNumber: number;
      owner: string;
      repo: string;
      sessionId: string;
      updatedAt: string;
    }>;

    return {
      sessions: rows.map((row) => ({
        issueId: row.issueId,
        issueNumber: row.issueNumber,
        repo: { owner: row.owner, repo: row.repo },
        sessionId: row.sessionId,
        updatedAt: row.updatedAt
      }))
    };
  });
}

function sameIssue(a: IssueSessionRecord, issue: Pick<IssueInfo, "id">): boolean {
  return a.issueId === issue.id;
}

export function setIssueSession(
  statePath: string,
  issue: IssueInfo,
  sessionId: string
): void {
  withStateDb(statePath, (db) => {
    const repoId = upsertRepo(db, issue.repo);
    db.prepare(`
      INSERT INTO issue_sessions (issue_id, repo_id, issue_number, session_id, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(issue_id) DO UPDATE SET
        repo_id = excluded.repo_id,
        issue_number = excluded.issue_number,
        session_id = excluded.session_id,
        updated_at = excluded.updated_at
    `).run(issue.id, repoId, issue.number, sessionId, new Date().toISOString());
  });
}

export function getIssueSession(statePath: string, issue: Pick<IssueInfo, "id">): string | null {
  const state = loadState(statePath);
  return state.sessions.find((entry) => sameIssue(entry, issue))?.sessionId ?? null;
}

export function clearIssueSession(statePath: string, issueId: number): void {
  withStateDb(statePath, (db) => {
    db.prepare("DELETE FROM issue_sessions WHERE issue_id = ?").run(issueId);
  });
}
