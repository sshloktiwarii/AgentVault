import { StepRecord, SessionRecord } from './index';

export interface EncryptedPayload {
  iv: string;
  authTag: string;
  ciphertext: string;
}

export type MeshMessageType =
  | 'CRDT_UPDATE'
  | 'STEP_BROADCAST'
  | 'CONFLICT_RESOLUTION'
  | 'HEARTBEAT';

export interface MeshEnvelope {
  senderId: string;
  sequenceNumber: number;
  vectorClock: Record<string, number>;
  timestamp: number;
  type: MeshMessageType;
  encryptedPayload: EncryptedPayload;
}

export interface MeshStepPayload {
  step: StepRecord;
  session: SessionRecord;
  changedFiles: string[];
}

export interface ConflictEvent {
  filePath: string;
  winningSessionId: string;
  winningSequence: number;
  losingSessionId: string;
  losingSequence: number;
  action: 'ROLLBACK_AND_REPROMPT';
}
