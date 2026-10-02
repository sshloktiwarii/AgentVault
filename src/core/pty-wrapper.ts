import * as pty from 'node-pty';
import * as chokidar from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';
import { ShadowGit } from './shadow-git';
import { OverlayCAS } from './overlay-cas';
import { RewindLedger } from './ledger';
import { SessionRecord, StepRecord, DiffEntry } from '../types';
import { logger } from '../utils/logger';

export interface AgentRunnerOptions {
  projectRoot?: string;
  command: string;
  args?: string[];
  quietPeriodMs?: number;
}

export class AgentRunner {
  private projectRoot: string;
  private shadowGit: ShadowGit;
  private overlayCas: OverlayCAS;
  private ledger: RewindLedger;

  private sessionId: string;
  private stepIndex: number = 0;
  private lastCommitHash: string = '';
  private lastManifestHash: string | null = null;
  private isSnapshotting: boolean = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private filesChanged: Set<string> = new Set<string>();
  private quietPeriodMs: number;
  private watcher: chokidar.FSWatcher | null = null;

  constructor(options: AgentRunnerOptions) {
    this.projectRoot = path.resolve(options.projectRoot || process.cwd());
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    this.quietPeriodMs = options.quietPeriodMs ?? 250;

    this.shadowGit = new ShadowGit(this.sessionId, this.projectRoot);
    this.overlayCas = new OverlayCAS(this.projectRoot);
    this.ledger = new RewindLedger(this.projectRoot);

    this.ensureSpawnHelperPermissions();
  }

  private ensureSpawnHelperPermissions(): void {
    try {
      const ptyDir = path.dirname(require.resolve('node-pty'));
      const prebuildsDir = path.join(ptyDir, '..', 'prebuilds');
      if (fs.existsSync(prebuildsDir)) {
        const archDirs = fs.readdirSync(prebuildsDir);
        for (const arch of archDirs) {
          const helperPath = path.join(prebuildsDir, arch, 'spawn-helper');
          if (fs.existsSync(helperPath)) {
            try {
              fs.chmodSync(helperPath, 0o755);
            } catch {
              // Ignore
            }
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  private formatStepId(index: number): string {
    return `step_${String(index).padStart(4, '0')}`;
  }

  public triggerSnapshot(commandExecuted?: string, exitCode?: number): StepRecord | null {
    if (this.isSnapshotting) {
      return null;
    }

    this.isSnapshotting = true;
    try {
      const stepId = this.formatStepId(this.stepIndex);
      const parentCommit = this.lastCommitHash || this.shadowGit.getCurrentHead();

      // Step A-E: Shadow Git snapshot
      const commitHash = this.shadowGit.createSnapshot(stepId, parentCommit);
      const treeHash = this.shadowGit.getTreeHashForCommit(commitHash);

      // Overlay CAS snapshot
      const manifestHash = this.overlayCas.generateManifest(stepId);

      // Section [11.0] Empty Agent Session: If filesChanged is 0 and not step 0, avoid redundant snapshots
      if (this.stepIndex > 0 && commitHash === this.lastCommitHash && manifestHash === this.lastManifestHash) {
        return null;
      }

      // Compute diffs against previous step
      const gitDiffs = this.shadowGit.computeDiff(this.lastCommitHash || null, commitHash);
      const overlayDiffs = this.overlayCas.computeOverlayDiff(this.lastManifestHash, manifestHash);
      const totalDiffs: DiffEntry[] = [...gitDiffs, ...overlayDiffs];

      const stepRecord: StepRecord = {
        stepId,
        sessionId: this.sessionId,
        stepIndex: this.stepIndex,
        createdAt: Date.now(),
        gitTreeHash: treeHash,
        gitCommitHash: commitHash,
        overlayManifestHash: manifestHash,
        commandExecuted: commandExecuted || null,
        exitCode: exitCode !== undefined ? exitCode : null,
        filesChangedCount: totalDiffs.length,
      };

      this.ledger.logStep(stepRecord, totalDiffs);

      this.lastCommitHash = commitHash;
      this.lastManifestHash = manifestHash;
      this.stepIndex++;
      this.filesChanged.clear();

      return stepRecord;
    } catch (err) {
      logger.error('AgentRunner', 'Snapshot creation failed', err);
      return null;
    } finally {
      this.isSnapshotting = false;
    }
  }

  private startFileWatcher(): void {
    const ignoredPatterns = [
      /(^|[\/\\])\.git([\/\\]|$)/,
      /(^|[\/\\])node_modules([\/\\]|$)/,
      /(^|[\/\\])\.next([\/\\]|$)/,
      /(^|[\/\\])dist([\/\\]|$)/,
      /(^|[\/\\])build([\/\\]|$)/,
      /(^|[\/\\])target([\/\\]|$)/,
      /(^|[\/\\])coverage([\/\\]|$)/,
      '/tmp/**',
    ];

    this.watcher = chokidar.watch(this.projectRoot, {
      ignored: ignoredPatterns,
      ignoreInitial: true,
      persistent: true,
    });

    const onFileMutation = (filePath: string): void => {
      this.filesChanged.add(filePath);

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }

      this.debounceTimer = setTimeout(() => {
        this.triggerSnapshot('fs_quiescence');
      }, this.quietPeriodMs);
    };

    this.watcher.on('add', onFileMutation);
    this.watcher.on('change', onFileMutation);
    this.watcher.on('unlink', onFileMutation);
  }

  public async spawn(targetCommand: string): Promise<number> {
    const baseHead = this.shadowGit.getCurrentHead();
    const activeBranch = this.shadowGit.getCurrentBranch();

    const session: SessionRecord = {
      sessionId: this.sessionId,
      startedAt: Date.now(),
      commandInvoked: targetCommand,
      baseHeadCommit: baseHead,
      activeBranch,
      status: 'ACTIVE',
    };
    this.ledger.startSession(session);

    // Baseline snapshot
    this.triggerSnapshot('session_start: baseline');
    this.startFileWatcher();

    const shell = process.env.SHELL || '/bin/bash';
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    const ptyProcess = pty.spawn(shell, ['-c', targetCommand], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.projectRoot,
      env: {
        ...process.env,
        AGENT_REWIND_SESSION_ID: this.sessionId,
      },
    });

    const isStdinTTY = process.stdin.isTTY;
    if (isStdinTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onStdin = (data: Buffer): void => {
      ptyProcess.write(data.toString('utf8'));
    };
    process.stdin.on('data', onStdin);

    ptyProcess.onData((data: string) => {
      process.stdout.write(data);
    });

    const onResize = (): void => {
      if (process.stdout.columns && process.stdout.rows) {
        ptyProcess.resize(process.stdout.columns, process.stdout.rows);
      }
    };
    process.stdout.on('resize', onResize);

    // Section [11.0] Trap process exits & segfaults
    const handleCrash = (): void => {
      this.ledger.updateSessionStatus(this.sessionId, 'CRASHED');
    };
    process.on('SIGTERM', handleCrash);
    process.on('SIGINT', handleCrash);

    return new Promise<number>((resolve) => {
      ptyProcess.onExit((event: { exitCode: number; signal?: number }) => {
        process.removeListener('SIGTERM', handleCrash);
        process.removeListener('SIGINT', handleCrash);

        process.stdin.removeListener('data', onStdin);
        process.stdout.removeListener('resize', onResize);

        if (isStdinTTY && process.stdin.setRawMode) {
          process.stdin.setRawMode(false);
        }
        process.stdin.pause();

        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
        }

        if (this.watcher) {
          this.watcher.close().catch(() => {});
          this.watcher = null;
        }

        const isSuccess = event.exitCode === 0;
        this.ledger.updateSessionStatus(this.sessionId, isSuccess ? 'CLOSED' : 'CRASHED');

        // Flush any pending mutations
        this.triggerSnapshot('session_exit: final flush', event.exitCode);
        this.shadowGit.garbageCollectIndex();

        resolve(event.exitCode);
      });
    });
  }
}
