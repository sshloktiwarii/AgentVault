import { RewindLedger } from '../core/ledger';
import { StepRecord, SessionRecord, DiffEntry } from '../types';

export interface UIState {
  session: SessionRecord | null;
  steps: StepRecord[];
  cursorIndex: number;
  currentDiffs: DiffEntry[];
}

export class TUIStore {
  private ledger: RewindLedger;

  constructor(projectRoot: string = process.cwd()) {
    this.ledger = new RewindLedger(projectRoot);
  }

  public getInitialState(): UIState {
    const session = this.ledger.getLatestSession();
    if (!session) {
      return {
        session: null,
        steps: [],
        cursorIndex: 0,
        currentDiffs: [],
      };
    }

    const steps = this.ledger.getStepHistory(session.sessionId, 100);
    const initialDiffs = steps.length > 0 ? this.ledger.getStepDiffs(steps[0].stepId) : [];

    return {
      session,
      steps,
      cursorIndex: 0,
      currentDiffs: initialDiffs,
    };
  }

  public getDiffsForStep(stepId: string): DiffEntry[] {
    return this.ledger.getStepDiffs(stepId);
  }
}
