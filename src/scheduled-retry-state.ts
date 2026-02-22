import type { IssueInfo, RepoInfo } from "./github.js";
import { resolveStateDbPath, upsertRepo, withStateDb } from "./state-db.js";

export type ScheduledRetryRecord = {
  issueId: number;
  issueNumber: number;
  repo: RepoInfo;
  runAfter: string;
  reason: "codex_quota";
  sessionId: string | null;
  updatedAt: string;
};

type ScheduledRetryState = {
  retries: ScheduledRetryRecord[];
};

export function resolveScheduledRetryStatePath(workdirRoot: string): string {
  return resolveStateDbPath(workdirRoot);
}

function loadState(statePath: string): ScheduledRetryState {
  return withStateDb(statePath, (db) => {
    const rows = db
      .prepare(
        `
        SELECT
          s.issue_id AS issueId,
          s.issue_number AS issueNumber,
          r.owner,
          r.repo,
          s.run_after AS runAfter,
          s.reason,
          s.session_id AS sessionId,
          s.updated_at AS updatedAt
        FROM scheduled_retries s
        JOIN repos r ON r.id = s.repo_id
      `
      )
      .all() as Array<{
      issueId: number;
      issueNumber: number;
      owner: string;
      repo: string;
      runAfter: string;
      reason: "codex_quota";
      sessionId: string | null;
      updatedAt: string;
    }>;

    return {
      retries: rows.map((row) => ({
        issueId: row.issueId,
        issueNumber: row.issueNumber,
        repo: { owner: row.owner, repo: row.repo },
        runAfter: row.runAfter,
        reason: row.reason,
        sessionId: row.sessionId,
        updatedAt: row.updatedAt
      }))
    };
  });
}

export function scheduleRetry(
  statePath: string,
  issue: IssueInfo,
  runAfter: string,
  sessionId: string | null
): void {
  withStateDb(statePath, (db) => {
    const repoId = upsertRepo(db, issue.repo);
    db.prepare(
      `
      INSERT INTO scheduled_retries (
        issue_id, repo_id, issue_number, run_after, reason, session_id, updated_at
      ) VALUES (?, ?, ?, ?, 'codex_quota', ?, ?)
      ON CONFLICT(issue_id) DO UPDATE SET
        repo_id = excluded.repo_id,
        issue_number = excluded.issue_number,
        run_after = excluded.run_after,
        reason = excluded.reason,
        session_id = excluded.session_id,
        updated_at = excluded.updated_at
    `
    ).run(issue.id, repoId, issue.number, runAfter, sessionId, new Date().toISOString());
  });
}

export function clearRetry(statePath: string, issueId: number): void {
  withStateDb(statePath, (db) => {
    db.prepare("DELETE FROM scheduled_retries WHERE issue_id = ?").run(issueId);
  });
}

export function takeDueRetries(statePath: string, now: Date): ScheduledRetryRecord[] {
  return withStateDb(statePath, (db) => {
    const rows = db
      .prepare(
        `
        SELECT
          s.issue_id AS issueId,
          s.issue_number AS issueNumber,
          r.owner,
          r.repo,
          s.run_after AS runAfter,
          s.reason,
          s.session_id AS sessionId,
          s.updated_at AS updatedAt
        FROM scheduled_retries s
        JOIN repos r ON r.id = s.repo_id
      `
      )
      .all() as Array<{
      issueId: number;
      issueNumber: number;
      owner: string;
      repo: string;
      runAfter: string;
      reason: "codex_quota";
      sessionId: string | null;
      updatedAt: string;
    }>;

    if (rows.length === 0) {
      return [];
    }

    const nowMs = now.getTime();
    const due = rows.filter((entry) => {
      const scheduled = Date.parse(entry.runAfter);
      return !Number.isNaN(scheduled) && scheduled <= nowMs;
    });
    if (due.length === 0) {
      return [];
    }

    const remove = db.prepare("DELETE FROM scheduled_retries WHERE issue_id = ?");
    for (const entry of due) {
      remove.run(entry.issueId);
    }

    return due.map((row) => ({
      issueId: row.issueId,
      issueNumber: row.issueNumber,
      repo: { owner: row.owner, repo: row.repo },
      runAfter: row.runAfter,
      reason: row.reason,
      sessionId: row.sessionId,
      updatedAt: row.updatedAt
    }));
  });
}
