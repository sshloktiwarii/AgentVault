export enum IPCMessageType {
  DAEMON_HANDSHAKE = 'DAEMON_HANDSHAKE',
  FORCE_SNAPSHOT = 'FORCE_SNAPSHOT',
  SNAPSHOT_COMPLETE = 'SNAPSHOT_COMPLETE',
  ROLLBACK_REQUEST = 'ROLLBACK_REQUEST',
  ROLLBACK_RESULT = 'ROLLBACK_RESULT',
  DAEMON_SHUTDOWN = 'DAEMON_SHUTDOWN',
  HEARTBEAT = 'HEARTBEAT',
}

export interface IPCMessage<T = unknown> {
  messageId: string; // UUID v4
  type: IPCMessageType;
  timestamp: number;
  payload: T;
}

export interface RollbackRequestPayload {
  targetStepId: string;
  force: boolean;
}

export interface SnapshotCompletePayload {
  stepId: string;
  gitCommitHash: string;
  filesChanged: number;
}
