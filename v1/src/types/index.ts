export interface SessionRecord {
  sessionId: string;
  startedAt: number;
  commandInvoked: string;
  baseHeadCommit: string;
  activeBranch: string;
  status: 'ACTIVE' | 'CLOSED' | 'CRASHED';
}

export interface StepRecord {
  stepId: string;
  sessionId: string;
  stepIndex: number;
  createdAt: number;
  gitTreeHash: string;
  gitCommitHash: string;
  overlayManifestHash: string | null;
  commandExecuted: string | null;
  exitCode: number | null;
  filesChangedCount: number;
}

export interface OverlayFile {
  relativePath: string;
  sha256: string;
  permissions: string;
  sizeBytes: number;
}

export interface OverlayManifest {
  stepId: string;
  timestamp: number;
  files: OverlayFile[];
}

export interface DiffEntry {
  filePath: string;
  changeType: 'ADDED' | 'MODIFIED' | 'DELETED';
  isOverlay: boolean;
}

export interface RollbackResult {
  success: boolean;
  targetStepId: string;
  filesRestored: number;
  error?: string;
  conflicts?: string[];
  compensationStepId?: string;
}
