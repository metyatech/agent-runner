import fs from "node:fs";
import type { RepoInfo } from "./github.js";
import { isProcessAlive } from "./runner-state.js";
import { getStateMeta, resolveStateDbPath, setStateMeta, upsertRepo, withStateDb } from "./state-db.js";

export type ActivityKind = "issue" | "idle";

export type ActivityRecord = {
  id: string;
  kind: ActivityKind;
  engine?: "codex" | "copilot" | "gemini-pro" | "gemini-flash" | "amazon-q" | "claude";
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
  return resolveStateDbPath(workdirRoot);
}

export function loadActivityState(statePath: string): ActivityState {
  if (!fs.existsSync(statePath)) {
    return { running: [], updatedAt: new Date(0).toISOString() };
  }
  return withStateDb(statePath, (db) => {
    const rows = db
      .prepare(`
        SELECT
          a.id,
          a.kind,
          a.engine,
          r.owner,
          r.repo,
          a.started_at AS startedAt,
          a.pid,
          a.log_path AS logPath,
          a.issue_id AS issueId,
          a.issue_number AS issueNumber,
          a.task
        FROM activities a
        JOIN repos r ON r.id = a.repo_id
      `)
      .all() as Array<{
      id: string;
      kind: ActivityKind;
      engine: ActivityRecord["engine"] | null;
      owner: string;
      repo: string;
      startedAt: string;
      pid: number;
      logPath: string;
      issueId: number | null;
      issueNumber: number | null;
      task: string | null;
    }>;

    const running: ActivityRecord[] = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      engine: row.engine ?? undefined,
      repo: { owner: row.owner, repo: row.repo },
      startedAt: row.startedAt,
      pid: row.pid,
      logPath: row.logPath,
      issueId: row.issueId ?? undefined,
      issueNumber: row.issueNumber ?? undefined,
      task: row.task ?? undefined
    }));

    const updatedAt = getStateMeta(db, "activities_updated_at") ?? new Date(0).toISOString();
    return { running, updatedAt };
  });
}

export function saveActivityState(statePath: string, state: ActivityState): void {
  withStateDb(statePath, (db) => {
    db.exec("DELETE FROM activities");
    const insert = db.prepare(`
      INSERT INTO activities (
        id, kind, engine, repo_id, started_at, pid, log_path, issue_id, issue_number, task
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const record of state.running) {
      const repoId = upsertRepo(db, record.repo);
      if (record.issueId !== undefined) {
        db.prepare("DELETE FROM activities WHERE issue_id = ? AND id <> ?").run(record.issueId, record.id);
      }
      insert.run(
        record.id,
        record.kind,
        record.engine ?? null,
        repoId,
        record.startedAt,
        record.pid,
        record.logPath,
        record.issueId ?? null,
        record.issueNumber ?? null,
        record.task ?? null
      );
    }

    setStateMeta(db, "activities_updated_at", state.updatedAt);
  });
}

export function recordActivity(statePath: string, record: ActivityRecord): void {
  withStateDb(statePath, (db) => {
    const repoId = upsertRepo(db, record.repo);
    if (record.issueId !== undefined) {
      db.prepare("DELETE FROM activities WHERE issue_id = ? AND id <> ?").run(record.issueId, record.id);
    }
    db.prepare(`
      INSERT INTO activities (
        id, kind, engine, repo_id, started_at, pid, log_path, issue_id, issue_number, task
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        engine = excluded.engine,
        repo_id = excluded.repo_id,
        started_at = excluded.started_at,
        pid = excluded.pid,
        log_path = excluded.log_path,
        issue_id = excluded.issue_id,
        issue_number = excluded.issue_number,
        task = excluded.task
    `).run(
      record.id,
      record.kind,
      record.engine ?? null,
      repoId,
      record.startedAt,
      record.pid,
      record.logPath,
      record.issueId ?? null,
      record.issueNumber ?? null,
      record.task ?? null
    );
    setStateMeta(db, "activities_updated_at", new Date().toISOString());
  });
}

export function removeActivity(statePath: string, id: string): void {
  withStateDb(statePath, (db) => {
    db.prepare("DELETE FROM activities WHERE id = ?").run(id);
    setStateMeta(db, "activities_updated_at", new Date().toISOString());
  });
}

export function pruneDeadActivityRecords(
  statePath: string,
  aliveCheck: (pid: number) => boolean = isProcessAlive,
  kinds: ActivityKind[] = ["idle"]
): number {
  if (!fs.existsSync(statePath)) {
    return 0;
  }
  return withStateDb(statePath, (db) => {
    const rows = db
      .prepare("SELECT id, kind, pid FROM activities")
      .all() as Array<{ id: string; kind: ActivityKind; pid: number }>;
    const removable = rows.filter((row) => kinds.includes(row.kind) && !aliveCheck(row.pid));
    if (removable.length === 0) {
      return 0;
    }
    const remove = db.prepare("DELETE FROM activities WHERE id = ?");
    for (const row of removable) {
      remove.run(row.id);
    }
    setStateMeta(db, "activities_updated_at", new Date().toISOString());
    return removable.length;
  });
}
