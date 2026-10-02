import * as net from 'net';
import { randomUUID as uuidv4 } from 'crypto';
import { IPCMessage, IPCMessageType } from '../types/ipc';

export class DaemonClient {
  private socketPath: string;
  private socket: net.Socket | null = null;
  private pendingRequests: Map<string, { resolve: (msg: IPCMessage) => void; reject: (err: Error) => void }> = new Map();
  private buffer: string = '';

  constructor(sessionId: string) {
    this.socketPath = `/tmp/rewind-ipc-${sessionId}.sock`;
  }

  public async connect(maxRetries: number = 5, maxDelayMs: number = 1000): Promise<void> {
    let delay = 100;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(this.socketPath);

          socket.once('connect', () => {
            this.socket = socket;
            this.setupSocketListeners();
            resolve();
          });

          socket.once('error', (err) => {
            reject(err);
          });
        });

        return;
      } catch (err) {
        if (attempt === maxRetries) {
          throw new Error(`Failed to connect to daemon socket at ${this.socketPath} after ${maxRetries} attempts: ${err}`);
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, maxDelayMs);
      }
    }
  }

  private setupSocketListeners(): void {
    if (!this.socket) return;

    this.socket.on('data', (data) => {
      this.buffer += data.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line) as IPCMessage;
            const pending = this.pendingRequests.get(message.messageId);
            if (pending) {
              this.pendingRequests.delete(message.messageId);
              pending.resolve(message);
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    });

    this.socket.on('close', () => {
      for (const [, pending] of this.pendingRequests.entries()) {
        pending.reject(new Error('Daemon connection closed prematurely.'));
      }
      this.pendingRequests.clear();
      this.socket = null;
    });
  }

  public sendAndWait<TResponse = unknown>(
    type: IPCMessageType,
    payload: unknown = {}
  ): Promise<IPCMessage<TResponse>> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('Not connected to daemon socket.'));
    }

    const messageId = uuidv4();
    const message: IPCMessage = {
      messageId,
      type,
      timestamp: Date.now(),
      payload,
    };

    return new Promise<IPCMessage<TResponse>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(messageId);
        reject(new Error(`IPC request ${type} timed out after 10000ms.`));
      }, 10000);

      this.pendingRequests.set(messageId, {
        resolve: (msg) => {
          clearTimeout(timeout);
          resolve(msg as IPCMessage<TResponse>);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.socket?.write(JSON.stringify(message) + '\n');
    });
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
  }
}
