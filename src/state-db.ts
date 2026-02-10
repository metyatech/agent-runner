import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { RepoInfo } from "./github.js";

const SCHEMA_VERSION = 1;
type DatabaseSync = Database.Database;

function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      UNIQUE(owner, repo)
    );

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('issue', 'idle')),
      engine TEXT,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE RESTRICT,
      started_at TEXT NOT NULL,
      pid INTEGER NOT NULL,
      log_path TEXT NOT NULL,
      issue_id INTEGER UNIQUE,
      issue_number INTEGER,
      task TEXT,
      CHECK(
        (kind = 'issue' AND issue_id IS NOT NULL AND issue_number IS NOT NULL) OR
        (kind = 'idle' AND issue_id IS NULL AND issue_number IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_activities_pid ON activities(pid);
    CREATE INDEX IF NOT EXISTS idx_activities_kind ON activities(kind);

    CREATE TABLE IF NOT EXISTS issue_sessions (
      issue_id INTEGER PRIMARY KEY,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE RESTRICT,
      issue_number INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_retries (
      issue_id INTEGER PRIMARY KEY,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE RESTRICT,
      issue_number INTEGER NOT NULL,
      run_after TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason = 'codex_quota'),
      session_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_retries_run_after ON scheduled_retries(run_after);
  `);

  const current = db.prepare("SELECT value FROM state_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (!current || Number.parseInt(current.value, 10) !== SCHEMA_VERSION) {
    db.prepare(`
      INSERT INTO state_meta (key, value) VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(SCHEMA_VERSION));
  }
}

export function resolveStateDbPath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "state.sqlite");
}

export function withStateDb<T>(dbPath: string, action: (db: DatabaseSync) => T): T {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    runMigrations(db);
    return action(db);
  } finally {
    db.close();
  }
}

export function upsertRepo(db: DatabaseSync, repo: RepoInfo): number {
  db.prepare(`
    INSERT INTO repos (owner, repo) VALUES (?, ?)
    ON CONFLICT(owner, repo) DO NOTHING
  `).run(repo.owner, repo.repo);
  const row = db
    .prepare("SELECT id FROM repos WHERE owner = ? AND repo = ?")
    .get(repo.owner, repo.repo) as { id: number } | undefined;
  if (!row) {
    throw new Error(`Failed to resolve repo id for ${repo.owner}/${repo.repo}`);
  }
  return row.id;
}

export function setStateMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`
    INSERT INTO state_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function getStateMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM state_meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
