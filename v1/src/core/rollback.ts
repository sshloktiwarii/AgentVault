import * as path from 'path';
import { ShadowGit } from './shadow-git';
import { OverlayCAS } from './overlay-cas';
import { RewindLedger } from './ledger';
import { SafetyEngine, SafetyConflictError } from './safety';
import { ASTVerifier, ASTConflictError } from './ast-diff';
import { RollbackResult, StepRecord, DiffEntry } from '../types';

export class RollbackEngine {
  private shadowGit: ShadowGit;
  private overlayCas: OverlayCAS;
  private ledger: RewindLedger;
  private safetyEngine: SafetyEngine;
  private astVerifier: ASTVerifier;

  constructor(
    sessionId?: string,
    projectRoot: string = process.cwd(),
    shadowGit?: ShadowGit,
    overlayCas?: OverlayCAS,
    ledger?: RewindLedger
  ) {
    const root = path.resolve(projectRoot);
    this.ledger = ledger ?? new RewindLedger(root);
    const activeSessionId = sessionId || this.ledger.getLatestSession()?.sessionId || 'default';
    this.shadowGit = shadowGit ?? new ShadowGit(activeSessionId, root);
    this.overlayCas = overlayCas ?? new OverlayCAS(root);
    this.safetyEngine = new SafetyEngine(root);
    this.astVerifier = new ASTVerifier(root);
  }

  public undo(
    stepsToRevert: number = 1,
    force: boolean = false,
    sessionId?: string
  ): RollbackResult {
    const activeSession = sessionId
      ? this.ledger.getSession(sessionId)
      : this.ledger.getLatestSession();

    if (!activeSession) {
      return {
        success: false,
        targetStepId: '',
        filesRestored: 0,
        error: 'No active or recorded session found to undo.',
      };
    }

    const currentStep = this.ledger.getLatestStep(activeSession.sessionId);
    if (!currentStep) {
      return {
        success: false,
        targetStepId: '',
        filesRestored: 0,
        error: `No recorded steps found for session ${activeSession.sessionId}.`,
      };
    }

    const targetIndex = Math.max(0, currentStep.stepIndex - stepsToRevert);
    const targetStep = this.ledger.getStepByIndex(activeSession.sessionId, targetIndex);

    if (!targetStep) {
      return {
        success: false,
        targetStepId: '',
        filesRestored: 0,
        error: `Cannot rewind ${stepsToRevert} steps: target step index ${targetIndex} does not exist.`,
      };
    }

    return this.restoreToStep(activeSession.sessionId, targetStep.stepId, force);
  }

  public restoreToStep(
    sessionId: string,
    targetStepId: string,
    force: boolean = false
  ): RollbackResult {
    const targetStep = this.ledger.getStep(targetStepId);
    if (!targetStep) {
      return {
        success: false,
        targetStepId,
        filesRestored: 0,
        error: `Target step ${targetStepId} not found in metadata ledger.`,
      };
    }

    const currentStep = this.ledger.getLatestStep(sessionId);
    if (!currentStep) {
      return {
        success: false,
        targetStepId,
        filesRestored: 0,
        error: `Cannot determine current step for session ${sessionId}.`,
      };
    }

    if (currentStep.stepId === targetStep.stepId) {
      return {
        success: true,
        targetStepId,
        filesRestored: 0,
        error: 'Working tree is already at the target step state.',
      };
    }

    // 1. Verification Phase: Safety Dirty Check
    if (!force) {
      const isSafe = this.safetyEngine.isWorkingTreeSafe(currentStep.gitCommitHash);
      if (!isSafe) {
        const conflicts = this.safetyEngine.getConflictingFiles(currentStep.gitCommitHash);
        throw new SafetyConflictError(
          'Working directory contains uncommitted human edits. Aborting rollback. Use --force to override.',
          conflicts
        );
      }
    }

    // 2. Git Restoration Phase: apply target tree directly without moving HEAD
    const diffs = this.shadowGit.computeDiff(currentStep.gitCommitHash, targetStep.gitCommitHash);
    const changedFiles = diffs.map(d => d.filePath);

    try {
      this.shadowGit.restoreTree(targetStep.gitTreeHash, currentStep.gitTreeHash);
      this.shadowGit.resetIndex();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        targetStepId,
        filesRestored: 0,
        error: `Git tree restoration failed: ${msg}`,
      };
    }

    // 3. Overlay CAS Restoration Phase
    const overlayRestored = this.overlayCas.restoreManifest(targetStep.overlayManifestHash);
    const totalChanged = Array.from(new Set([...changedFiles, ...overlayRestored]));

    // 4. Phase 5 AST Verification Tier
    if (!force) {
      const isAstValid = this.astVerifier.verifyRestoredState(totalChanged);
      if (!isAstValid) {
        // Counter-rollback to restore user back to pre-undo state
        try {
          this.shadowGit.restoreTree(currentStep.gitTreeHash, targetStep.gitTreeHash);
          this.overlayCas.restoreManifest(currentStep.overlayManifestHash);
        } catch {
          // Ignore secondary restore error
        }

        throw new ASTConflictError(
          'Rollback aborted. Restoring to this step would break TypeScript compilation.'
        );
      }
    }

    // 5. Ledger Compensation Phase
    const compensationIndex = currentStep.stepIndex + 1;
    const compensationStepId = `step_${String(compensationIndex).padStart(4, '0')}`;

    // Take snapshot of new state to create compensation commit
    const compensationCommit = this.shadowGit.createSnapshot(
      compensationStepId,
      currentStep.gitCommitHash
    );

    const compensationManifest = this.overlayCas.generateManifest(compensationStepId);
    const compensationTree = this.shadowGit.getTreeHashForCommit(compensationCommit);

    const compensationStep: StepRecord = {
      stepId: compensationStepId,
      sessionId,
      stepIndex: compensationIndex,
      createdAt: Date.now(),
      gitTreeHash: compensationTree,
      gitCommitHash: compensationCommit,
      overlayManifestHash: compensationManifest,
      commandExecuted: `REWIND UNDO -> ${targetStepId}`,
      exitCode: 0,
      filesChangedCount: totalChanged.length,
    };

    const compDiffs: DiffEntry[] = diffs.map(d => ({
      filePath: d.filePath,
      changeType: d.changeType === 'ADDED' ? 'DELETED' : d.changeType === 'DELETED' ? 'ADDED' : 'MODIFIED',
      isOverlay: false,
    }));

    this.ledger.logStep(compensationStep, compDiffs);

    return {
      success: true,
      targetStepId,
      filesRestored: totalChanged.length,
      compensationStepId,
    };
  }
}

export function rewindUndo(
  steps: number = 1,
  force: boolean = true,
  projectRoot: string = process.cwd(),
  sessionId?: string
): RollbackResult {
  const engine = new RollbackEngine(sessionId, projectRoot);
  return engine.undo(steps, force, sessionId);
}
