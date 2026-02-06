import type { IssueInfo, RepoInfo } from "./github.js";
import { resolveStateDbPath, upsertRepo, withStateDb } from "./state-db.js";

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
  return resolveStateDbPath(workdirRoot);
}

export function loadRunnerState(statePath: string): RunnerState {
  return withStateDb(statePath, (db) => {
    const rows = db
      .prepare(`
        SELECT
          a.issue_id AS issueId,
          a.issue_number AS issueNumber,
          r.owner,
          r.repo,
          a.started_at AS startedAt,
          a.pid,
          a.log_path AS logPath
        FROM activities a
        JOIN repos r ON r.id = a.repo_id
        WHERE a.kind = 'issue'
      `)
      .all() as Array<{
      issueId: number;
      issueNumber: number;
      owner: string;
      repo: string;
      startedAt: string;
      pid: number;
      logPath: string;
    }>;

    return {
      running: rows.map((row) => ({
        issueId: row.issueId,
        issueNumber: row.issueNumber,
        repo: { owner: row.owner, repo: row.repo },
        startedAt: row.startedAt,
        pid: row.pid,
        logPath: row.logPath
      }))
    };
  });
}

export function saveRunnerState(statePath: string, state: RunnerState): void {
  withStateDb(statePath, (db) => {
    db.prepare("DELETE FROM activities WHERE kind = 'issue'").run();
    const insert = db.prepare(`
      INSERT INTO activities (
        id, kind, engine, repo_id, started_at, pid, log_path, issue_id, issue_number, task
      ) VALUES (?, 'issue', 'codex', ?, ?, ?, ?, ?, ?, NULL)
    `);
    for (const record of state.running) {
      const repoId = upsertRepo(db, record.repo);
      insert.run(`issue:${record.issueId}`, repoId, record.startedAt, record.pid, record.logPath, record.issueId, record.issueNumber);
    }
  });
}

export function recordRunningIssue(statePath: string, record: RunningIssueRecord): void {
  withStateDb(statePath, (db) => {
    const repoId = upsertRepo(db, record.repo);
    db.prepare("DELETE FROM activities WHERE issue_id = ? AND id <> ?").run(record.issueId, `issue:${record.issueId}`);
    db.prepare(`
      INSERT INTO activities (
        id, kind, engine, repo_id, started_at, pid, log_path, issue_id, issue_number, task
      ) VALUES (?, 'issue', 'codex', ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(issue_id) DO UPDATE SET
        id = excluded.id,
        repo_id = excluded.repo_id,
        started_at = excluded.started_at,
        pid = excluded.pid,
        log_path = excluded.log_path,
        issue_number = excluded.issue_number
    `).run(
      `issue:${record.issueId}`,
      repoId,
      record.startedAt,
      record.pid,
      record.logPath,
      record.issueId,
      record.issueNumber
    );
  });
}

export function removeRunningIssue(statePath: string, issueId: number): void {
  withStateDb(statePath, (db) => {
    db.prepare("DELETE FROM activities WHERE issue_id = ?").run(issueId);
  });
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
