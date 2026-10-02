import * as net from 'net';
import * as fs from 'fs';
import { randomUUID as uuidv4 } from 'crypto';
import { ShadowGit } from '../core/shadow-git';
import { OverlayCAS } from '../core/overlay-cas';
import { RewindLedger } from '../core/ledger';
import { RollbackEngine } from '../core/rollback';
import {
  IPCMessage,
  IPCMessageType,
  RollbackRequestPayload,
  SnapshotCompletePayload,
} from '../types/ipc';
import { logger } from '../utils/logger';

export class DaemonServer {
  private sessionId: string;
  private socketPath: string;
  private server: net.Server | null = null;
  private shadowGit: ShadowGit;
  private overlayCas: OverlayCAS;
  private ledger: RewindLedger;
  private rollbackEngine: RollbackEngine;

  private missedHeartbeats: number = 0;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private activeClient: net.Socket | null = null;
  private stepIndex: number = 0;
  private latestCommitHash: string | null = null;

  constructor(sessionId: string, projectRoot: string = process.cwd()) {
    this.sessionId = sessionId;
    this.socketPath = `/tmp/rewind-ipc-${sessionId}.sock`;
    this.shadowGit = new ShadowGit(sessionId, projectRoot);
    this.overlayCas = new OverlayCAS(projectRoot);
    this.ledger = new RewindLedger(projectRoot);
    this.rollbackEngine = new RollbackEngine(sessionId, projectRoot, this.shadowGit, this.overlayCas, this.ledger);
    this.latestCommitHash = this.shadowGit.getCurrentHead();
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Ensure session exists in ledger
      if (!this.ledger.getSession(this.sessionId)) {
        this.ledger.startSession({
          sessionId: this.sessionId,
          startedAt: Date.now(),
          commandInvoked: 'daemon',
          baseHeadCommit: this.shadowGit.getCurrentHead(),
          activeBranch: this.shadowGit.getCurrentBranch(),
          status: 'ACTIVE',
        });
      }

      // Clear stale socket if exists
      if (fs.existsSync(this.socketPath)) {
        try {
          fs.unlinkSync(this.socketPath);
        } catch (err) {
          logger.warn('DaemonServer', 'Failed to remove stale socket', err);
        }
      }

      this.server = net.createServer((client) => {
        this.activeClient = client;
        let buffer = '';

        client.on('data', (data) => {
          buffer += data.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.trim()) {
              try {
                const message = JSON.parse(line) as IPCMessage;
                this.handleMessage(client, message);
              } catch (err) {
                logger.error('DaemonServer', 'Failed to parse IPC message', err);
              }
            }
          }
        });

        client.on('close', () => {
          if (this.activeClient === client) {
            this.activeClient = null;
          }
        });

        client.on('error', (err) => {
          logger.warn('DaemonServer', 'Client socket error', err);
        });
      });

      this.server.on('error', (err) => {
        logger.error('DaemonServer', 'Socket server error', err);
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        logger.info('DaemonServer', `Daemon listening on ${this.socketPath}`);
        this.startHeartbeatEngine();
        resolve();
      });
    });
  }

  private sendMessage(client: net.Socket, message: IPCMessage): void {
    if (!client.destroyed) {
      client.write(JSON.stringify(message) + '\n');
    }
  }

  private handleMessage(client: net.Socket, message: IPCMessage): void {
    switch (message.type) {
      case IPCMessageType.HEARTBEAT:
        this.missedHeartbeats = 0;
        this.sendMessage(client, {
          messageId: message.messageId,
          type: IPCMessageType.HEARTBEAT,
          timestamp: Date.now(),
          payload: { status: 'PONG' },
        });
        break;

      case IPCMessageType.FORCE_SNAPSHOT: {
        const stepId = `step_${String(this.stepIndex).padStart(4, '0')}`;
        const parentCommit = this.latestCommitHash || this.shadowGit.getCurrentHead();
        const commitHash = this.shadowGit.createSnapshot(stepId, parentCommit);
        const manifestHash = this.overlayCas.generateManifest(stepId);
        const treeHash = this.shadowGit.getTreeHashForCommit(commitHash);
        const diffs = this.shadowGit.computeDiff(this.latestCommitHash, commitHash);

        this.ledger.logStep({
          stepId,
          sessionId: this.sessionId,
          stepIndex: this.stepIndex,
          createdAt: Date.now(),
          gitTreeHash: treeHash,
          gitCommitHash: commitHash,
          overlayManifestHash: manifestHash,
          commandExecuted: 'FORCE_SNAPSHOT',
          exitCode: 0,
          filesChangedCount: diffs.length,
        }, diffs);

        this.latestCommitHash = commitHash;
        this.stepIndex++;

        const response: IPCMessage<SnapshotCompletePayload> = {
          messageId: message.messageId,
          type: IPCMessageType.SNAPSHOT_COMPLETE,
          timestamp: Date.now(),
          payload: {
            stepId,
            gitCommitHash: commitHash,
            filesChanged: diffs.length,
          },
        };
        this.sendMessage(client, response);
        break;
      }

      case IPCMessageType.ROLLBACK_REQUEST: {
        const payload = message.payload as RollbackRequestPayload;
        try {
          const result = this.rollbackEngine.restoreToStep(this.sessionId, payload.targetStepId, payload.force);
          this.sendMessage(client, {
            messageId: message.messageId,
            type: IPCMessageType.ROLLBACK_RESULT,
            timestamp: Date.now(),
            payload: result,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.sendMessage(client, {
            messageId: message.messageId,
            type: IPCMessageType.ROLLBACK_RESULT,
            timestamp: Date.now(),
            payload: { success: false, error: msg, filesRestored: 0, targetStepId: payload.targetStepId },
          });
        }
        break;
      }

      case IPCMessageType.DAEMON_SHUTDOWN:
        this.shutdown();
        break;
    }
  }

  private startHeartbeatEngine(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.activeClient) {
        this.missedHeartbeats++;
        if (this.missedHeartbeats >= 3) {
          logger.warn('DaemonServer', 'Heartbeat timeout: CLI client disconnected. Auto-shutting down daemon.');
          this.shutdown();
          return;
        }

        this.sendMessage(this.activeClient, {
          messageId: uuidv4(),
          type: IPCMessageType.HEARTBEAT,
          timestamp: Date.now(),
          payload: { ping: true },
        });
      }
    }, 5000);
  }

  public shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    if (fs.existsSync(this.socketPath)) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // Ignore
      }
    }

    this.shadowGit.garbageCollectIndex();
    this.ledger.close();
  }
}
