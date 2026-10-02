import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as Y from 'yjs';
import { WebSocketServer, WebSocket } from 'ws';
import {
  EncryptedPayload,
  MeshEnvelope,
  MeshMessageType,
  MeshStepPayload,
  ConflictEvent,
} from '../types/network';
import { StepRecord, SessionRecord } from '../types';
import { logger } from '../utils/logger';

export interface MeshOptions {
  nodeId: string;
  secretKey?: string;
  port?: number;
}

export class RewindMeshNetwork extends EventEmitter {
  private nodeId: string;
  private secretKey: Buffer;
  private doc: Y.Doc;
  private stepsMap: Y.Map<StepRecord>;
  private sessionsMap: Y.Map<SessionRecord>;
  private fileOwnersMap: Y.Map<string>; // filePath -> "sessionId:sequence"
  private vectorClocks: Map<string, number> = new Map();
  private sequenceNumber: number = 0;
  private wss: WebSocketServer | null = null;
  private peers: Set<WebSocket> = new Set();
  private isRunning: boolean = false;

  constructor(options: MeshOptions) {
    super();
    this.nodeId = options.nodeId;
    const keySource = options.secretKey || 'rewind-default-cluster-zero-trust-key';
    this.secretKey = crypto.createHash('sha256').update(keySource).digest();

    this.doc = new Y.Doc();
    this.stepsMap = this.doc.getMap<StepRecord>('steps');
    this.sessionsMap = this.doc.getMap<SessionRecord>('sessions');
    this.fileOwnersMap = this.doc.getMap<string>('fileOwners');

    // Subscribe to internal Y.Doc updates to automatically batch & broadcast to peers
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') {
        this.queueCrdtUpdate(update);
      }
    });
  }

  private pendingUpdates: Uint8Array[] = [];
  private flushTimer: NodeJS.Immediate | null = null;

  private queueCrdtUpdate(update: Uint8Array): void {
    this.pendingUpdates.push(update);
    if (!this.flushTimer) {
      this.flushTimer = setImmediate(() => {
        this.flushPendingUpdates();
      });
    }
  }

  public flushPendingUpdates(): void {
    if (this.flushTimer) {
      clearImmediate(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingUpdates.length === 0) return;
    const merged = Y.mergeUpdates(this.pendingUpdates);
    this.pendingUpdates = [];
    this.broadcastCrdtUpdate(merged);
  }

  public syncFullState(): void {
    this.flushPendingUpdates();
    const update = Y.encodeStateAsUpdate(this.doc);
    if (update.length > 0) {
      this.broadcastCrdtUpdate(update);
    }
  }

  public getNodeId(): string {
    return this.nodeId;
  }

  public getDoc(): Y.Doc {
    return this.doc;
  }

  // --- AES-256-GCM Zero-Trust Encryption ---

  public encryptPayload(data: string | Uint8Array): EncryptedPayload {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.secretKey, iv);

    const bufferData = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const encrypted = Buffer.concat([cipher.update(bufferData), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      ciphertext: encrypted.toString('hex'),
    };
  }

  public decryptPayload(payload: EncryptedPayload): Buffer {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.secretKey,
      Buffer.from(payload.iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));

    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'hex')),
      decipher.final(),
    ]);
  }

  // --- CRDT & Conflict Resolution Engine ---

  public recordStep(
    step: StepRecord,
    session: SessionRecord,
    changedFiles: string[] = []
  ): ConflictEvent | null {
    this.sequenceNumber++;
    this.vectorClocks.set(this.nodeId, this.sequenceNumber);

    let detectedConflict: ConflictEvent | null = null;

    this.doc.transact(() => {
      this.sessionsMap.set(session.sessionId, session);
      this.stepsMap.set(step.stepId, step);

      // Section [4.2] Vector-Clock & Sequence Conflict Resolution
      for (const filePath of changedFiles) {
        const currentOwner = this.fileOwnersMap.get(filePath);

        if (currentOwner) {
          const [ownerSessionId, ownerSeqStr] = currentOwner.split(':');
          const ownerSeq = parseInt(ownerSeqStr, 10) || 0;

          if (ownerSessionId !== session.sessionId) {
            // Concurrent mutation detected
            if (this.sequenceNumber > ownerSeq) {
              // Current session wins
              detectedConflict = {
                filePath,
                winningSessionId: session.sessionId,
                winningSequence: this.sequenceNumber,
                losingSessionId: ownerSessionId,
                losingSequence: ownerSeq,
                action: 'ROLLBACK_AND_REPROMPT',
              };
              this.fileOwnersMap.set(filePath, `${session.sessionId}:${this.sequenceNumber}`);
            } else {
              // Remote owner wins; current session loses
              detectedConflict = {
                filePath,
                winningSessionId: ownerSessionId,
                winningSequence: ownerSeq,
                losingSessionId: session.sessionId,
                losingSequence: this.sequenceNumber,
                action: 'ROLLBACK_AND_REPROMPT',
              };
            }
          }
        } else {
          this.fileOwnersMap.set(filePath, `${session.sessionId}:${this.sequenceNumber}`);
        }
      }
    });

    if (detectedConflict) {
      this.emit('conflict', detectedConflict);
    }

    if (this.listenerCount('remote_step') > 0) {
      const stepPayload: MeshStepPayload = { step, session, changedFiles };
      this.broadcastMessage('STEP_BROADCAST', JSON.stringify(stepPayload));
    }

    return detectedConflict;
  }

  private broadcastCrdtUpdate(update: Uint8Array): void {
    const base64Update = Buffer.from(update).toString('base64');
    this.broadcastMessage('CRDT_UPDATE', base64Update);
  }

  private broadcastMessage(type: MeshMessageType, rawData: string): void {
    const encrypted = this.encryptPayload(rawData);
    const envelope: MeshEnvelope = {
      senderId: this.nodeId,
      sequenceNumber: this.sequenceNumber,
      vectorClock: Object.fromEntries(this.vectorClocks.entries()),
      timestamp: Date.now(),
      type,
      encryptedPayload: encrypted,
    };

    const wireString = JSON.stringify(envelope);

    for (const peer of this.peers) {
      if (peer.readyState === WebSocket.OPEN) {
        try {
          peer.send(wireString);
        } catch {
          // Ignore transient peer write failure
        }
      }
    }
  }

  public handleIncomingWireMessage(wireData: string, fromSocket?: WebSocket): void {
    try {
      const envelope = JSON.parse(wireData) as MeshEnvelope;
      if (envelope.senderId === this.nodeId) return;

      const decryptedBuffer = this.decryptPayload(envelope.encryptedPayload);

      // Update vector clock
      const remoteSeq = envelope.sequenceNumber;
      const currentKnown = this.vectorClocks.get(envelope.senderId) || 0;
      this.vectorClocks.set(envelope.senderId, Math.max(currentKnown, remoteSeq));

      if (envelope.type === 'CRDT_UPDATE') {
        const updateBytes = Buffer.from(decryptedBuffer.toString('utf8'), 'base64');
        Y.applyUpdate(this.doc, updateBytes, 'remote');
        this.emit('crdt_synced', { senderId: envelope.senderId });

        // Relay to other mesh peers (gossip propagation)
        if (this.peers.size > 1) {
          for (const peer of this.peers) {
            if (peer !== fromSocket && peer.readyState === WebSocket.OPEN) {
              try {
                peer.send(wireData);
              } catch {
                // Ignore
              }
            }
          }
        }
      } else if (envelope.type === 'STEP_BROADCAST') {
        const payload = JSON.parse(decryptedBuffer.toString('utf8')) as MeshStepPayload;
        this.emit('remote_step', payload);
      }
    } catch (err) {
      logger.warn('RewindMeshNetwork', `Failed to decrypt/apply wire message: ${err}`);
    }
  }

  // --- Network Listeners & Peer Connections ---

  public async startServer(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ port }, () => {
          const actualPort = (this.wss?.address() as { port: number })?.port || port;
          this.isRunning = true;
          logger.info('RewindMeshNetwork', `Mesh node ${this.nodeId} listening on port ${actualPort}`);

          this.wss?.on('connection', (ws: WebSocket) => {
            this.peers.add(ws);

            // Send initial document sync state to new peer
            const initialUpdate = Y.encodeStateAsUpdate(this.doc);
            const encrypted = this.encryptPayload(Buffer.from(initialUpdate).toString('base64'));
            const handshakeEnvelope: MeshEnvelope = {
              senderId: this.nodeId,
              sequenceNumber: this.sequenceNumber,
              vectorClock: Object.fromEntries(this.vectorClocks.entries()),
              timestamp: Date.now(),
              type: 'CRDT_UPDATE',
              encryptedPayload: encrypted,
            };
            ws.send(JSON.stringify(handshakeEnvelope));

            ws.on('message', (msg: string | Buffer) => {
              this.handleIncomingWireMessage(msg.toString(), ws);
            });

            ws.on('close', () => {
              this.peers.delete(ws);
            });

            ws.on('error', () => {
              this.peers.delete(ws);
            });
          });

          resolve(actualPort);
        });

        this.wss.on('error', (err) => {
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  public async connectToPeer(targetUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(targetUrl);

      ws.on('open', () => {
        this.peers.add(ws);
        // Send state vector
        const stateVector = Y.encodeStateVector(this.doc);
        const update = Y.encodeStateAsUpdate(this.doc, stateVector);
        if (update.length > 0) {
          const encrypted = this.encryptPayload(Buffer.from(update).toString('base64'));
          const envelope: MeshEnvelope = {
            senderId: this.nodeId,
            sequenceNumber: this.sequenceNumber,
            vectorClock: Object.fromEntries(this.vectorClocks.entries()),
            timestamp: Date.now(),
            type: 'CRDT_UPDATE',
            encryptedPayload: encrypted,
          };
          ws.send(JSON.stringify(envelope));
        }
        resolve();
      });

      ws.on('message', (msg: string | Buffer) => {
        this.handleIncomingWireMessage(msg.toString(), ws);
      });

      ws.on('close', () => {
        this.peers.delete(ws);
      });

      ws.on('error', (err) => {
        this.peers.delete(ws);
        reject(err);
      });
    });
  }

  public getPeerCount(): number {
    return this.peers.size;
  }

  public getStepsCount(): number {
    return this.stepsMap.size;
  }

  public getVectorClock(): Record<string, number> {
    return Object.fromEntries(this.vectorClocks.entries());
  }

  public stop(): void {
    this.isRunning = false;
    for (const peer of this.peers) {
      try {
        peer.terminate();
      } catch {
        // Ignore
      }
    }
    this.peers.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.doc.destroy();
    this.removeAllListeners();
  }
}
