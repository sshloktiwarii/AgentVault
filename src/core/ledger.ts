import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { SessionRecord, StepRecord, DiffEntry } from '../types';

export class RewindLedger {
  private db: Database.Database;
  private dbPath: string;

  constructor(projectRoot: string = process.cwd()) {
    const rewindDir = path.join(projectRoot, '.git', 'rewind');
    if (!fs.existsSync(rewindDir)) {
      fs.mkdirSync(rewindDir, { recursive: true });
    }

    this.dbPath = path.join(rewindDir, 'metadata.db');
    this.db = new Database(this.dbPath);

    // Section [5.1] Pragmas
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('cache_size = -20000');
    this.db.pragma('busy_timeout = 5000');

    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          started_at INTEGER NOT NULL,
          command_invoked TEXT NOT NULL,
          base_head_commit TEXT NOT NULL,
          active_branch TEXT NOT NULL,
          status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS steps (
          step_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          step_index INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          git_tree_hash TEXT NOT NULL,
          git_commit_hash TEXT NOT NULL,
          overlay_manifest_hash TEXT,
          command_executed TEXT,
          exit_code INTEGER,
          files_changed_count INTEGER NOT NULL,
          FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS step_file_diffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          step_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          change_type TEXT,
          is_overlay INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY(step_id) REFERENCES steps(step_id)
      );

      CREATE INDEX IF NOT EXISTS idx_steps_session ON steps(session_id, step_index);
    `);

    // Defensive schema migration: ensure status column exists in sessions
    try {
      const sessionCols = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      if (!sessionCols.some(col => col.name === 'status')) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'ACTIVE'");
      }
    } catch {
      // Ignore if table was just created or already migrated
    }
  }

  public startSession(session: SessionRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (session_id, started_at, command_invoked, base_head_commit, active_branch, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.sessionId,
      session.startedAt,
      session.commandInvoked,
      session.baseHeadCommit,
      session.activeBranch,
      session.status
    );
  }

  public updateSessionStatus(sessionId: string, status: SessionRecord['status']): void {
    const stmt = this.db.prepare('UPDATE sessions SET status = ? WHERE session_id = ?');
    stmt.run(status, sessionId);
  }

  public logStep(step: StepRecord, diffs: DiffEntry[] = []): void {
    const insertStep = this.db.prepare(`
      INSERT OR REPLACE INTO steps (
        step_id, session_id, step_index, created_at, git_tree_hash,
        git_commit_hash, overlay_manifest_hash, command_executed, exit_code, files_changed_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertDiff = this.db.prepare(`
      INSERT INTO step_file_diffs (step_id, file_path, change_type, is_overlay)
      VALUES (?, ?, ?, ?)
    `);

    // Transactional atomicity: step + diffs inserted together
    const tx = this.db.transaction(() => {
      insertStep.run(
        step.stepId,
        step.sessionId,
        step.stepIndex,
        step.createdAt,
        step.gitTreeHash,
        step.gitCommitHash,
        step.overlayManifestHash,
        step.commandExecuted,
        step.exitCode,
        step.filesChangedCount
      );

      for (const diff of diffs) {
        insertDiff.run(step.stepId, diff.filePath, diff.changeType, diff.isOverlay ? 1 : 0);
      }
    });

    tx();
  }

  public getLatestStep(sessionId: string): StepRecord | null {
    const row = this.db.prepare(`
      SELECT step_id as stepId, session_id as sessionId, step_index as stepIndex,
             created_at as createdAt, git_tree_hash as gitTreeHash, git_commit_hash as gitCommitHash,
             overlay_manifest_hash as overlayManifestHash, command_executed as commandExecuted,
             exit_code as exitCode, files_changed_count as filesChangedCount
      FROM steps
      WHERE session_id = ?
      ORDER BY step_index DESC
      LIMIT 1
    `).get(sessionId) as StepRecord | undefined;

    return row || null;
  }

  public getStepHistory(sessionId: string, limit: number = 50): StepRecord[] {
    const rows = this.db.prepare(`
      SELECT step_id as stepId, session_id as sessionId, step_index as stepIndex,
             created_at as createdAt, git_tree_hash as gitTreeHash, git_commit_hash as gitCommitHash,
             overlay_manifest_hash as overlayManifestHash, command_executed as commandExecuted,
             exit_code as exitCode, files_changed_count as filesChangedCount
      FROM steps
      WHERE session_id = ?
      ORDER BY step_index ASC
      LIMIT ?
    `).all(sessionId, limit) as StepRecord[];

    return rows;
  }

  public getStep(stepId: string): StepRecord | null {
    const row = this.db.prepare(`
      SELECT step_id as stepId, session_id as sessionId, step_index as stepIndex,
             created_at as createdAt, git_tree_hash as gitTreeHash, git_commit_hash as gitCommitHash,
             overlay_manifest_hash as overlayManifestHash, command_executed as commandExecuted,
             exit_code as exitCode, files_changed_count as filesChangedCount
      FROM steps
      WHERE step_id = ?
    `).get(stepId) as StepRecord | undefined;

    return row || null;
  }

  public getStepByIndex(sessionId: string, index: number): StepRecord | null {
    const row = this.db.prepare(`
      SELECT step_id as stepId, session_id as sessionId, step_index as stepIndex,
             created_at as createdAt, git_tree_hash as gitTreeHash, git_commit_hash as gitCommitHash,
             overlay_manifest_hash as overlayManifestHash, command_executed as commandExecuted,
             exit_code as exitCode, files_changed_count as filesChangedCount
      FROM steps
      WHERE session_id = ? AND step_index = ?
    `).get(sessionId, index) as StepRecord | undefined;

    return row || null;
  }

  public getStepDiffs(stepId: string): DiffEntry[] {
    const rows = this.db.prepare(`
      SELECT file_path as filePath, change_type as changeType, is_overlay as isOverlay
      FROM step_file_diffs
      WHERE step_id = ?
      ORDER BY id ASC
    `).all(stepId) as Array<{ filePath: string; changeType: 'ADDED' | 'MODIFIED' | 'DELETED'; isOverlay: number }>;

    return rows.map(r => ({
      filePath: r.filePath,
      changeType: r.changeType,
      isOverlay: Boolean(r.isOverlay),
    }));
  }

  public getLatestSession(): SessionRecord | null {
    const row = this.db.prepare(`
      SELECT session_id as sessionId, started_at as startedAt, command_invoked as commandInvoked,
             base_head_commit as baseHeadCommit, active_branch as activeBranch, status
      FROM sessions
      ORDER BY started_at DESC
      LIMIT 1
    `).get() as SessionRecord | undefined;

    return row || null;
  }

  public getSession(sessionId: string): SessionRecord | null {
    const row = this.db.prepare(`
      SELECT session_id as sessionId, started_at as startedAt, command_invoked as commandInvoked,
             base_head_commit as baseHeadCommit, active_branch as activeBranch, status
      FROM sessions
      WHERE session_id = ?
    `).get(sessionId) as SessionRecord | undefined;

    return row || null;
  }

  public listSessions(limit: number = 20): SessionRecord[] {
    const rows = this.db.prepare(`
      SELECT session_id as sessionId, started_at as startedAt, command_invoked as commandInvoked,
             base_head_commit as baseHeadCommit, active_branch as activeBranch, status
      FROM sessions
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit) as SessionRecord[];

    return rows;
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore
    }
  }
}
