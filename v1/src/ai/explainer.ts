import { DiffEntry } from '../types';
import { logger } from '../utils/logger';

export interface ExplainerOptions {
  llmEndpoint?: string;
  modelName?: string;
  timeoutMs?: number;
}

export interface ReconciliationReport {
  promptIssued: string;
  reconciliationStrategy: string;
  filesReconciled: string[];
  injectedAt: number;
}

export class ReconciliationExplainer {
  private llmEndpoint: string;
  private modelName: string;
  private timeoutMs: number;

  constructor(options: ExplainerOptions = {}) {
    this.llmEndpoint = options.llmEndpoint || process.env.REWIND_LLM_ENDPOINT || 'http://localhost:11434/api/generate';
    this.modelName = options.modelName || process.env.REWIND_LLM_MODEL || 'llama3';
    this.timeoutMs = options.timeoutMs || 5000;
  }

  public async generateCorrection(
    stepsUndoneCount: number,
    diffs: DiffEntry[]
  ): Promise<ReconciliationReport> {
    const fileSummary = diffs.map((d) => `  - [${d.changeType}] ${d.filePath}`).join('\n') || '  - (no file diffs recorded)';

    const prompt = `You are an AI coding agent. The human just forcefully rolled back your last ${stepsUndoneCount} actions because they broke the codebase. Analyze this git diff of what was removed, acknowledge your mistake, and output a new strategy.

REVERTED MUTATIONS:
${fileSummary}

Provide:
1. Mistake acknowledgment.
2. Codebase state re-orientation.
3. Next corrective step.`;

    let strategy = '';

    // Attempt local LLM endpoint (Ollama) if available
    let timer: NodeJS.Timeout | null = null;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(this.llmEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelName,
          prompt,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (res.ok) {
        const json = (await res.json()) as { response?: string };
        strategy = json.response || '';
      }
    } catch {
      // Local LLM offline or unreachable -> use deterministic synthesis engine
      logger.info('ReconciliationExplainer', 'Local LLM unavailable. Employing deterministic reconciliation synthesis.');
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!strategy) {
      strategy = this.synthesizeDeterministicStrategy(stepsUndoneCount, diffs);
    }

    const filesReconciled = diffs.map((d) => d.filePath);

    return {
      promptIssued: prompt,
      reconciliationStrategy: strategy,
      filesReconciled,
      injectedAt: Date.now(),
    };
  }

  private synthesizeDeterministicStrategy(stepsUndoneCount: number, diffs: DiffEntry[]): string {
    const fileList = diffs.map((d) => `${d.filePath} (${d.changeType})`).join(', ');

    return `\n\x1b[33m\x1b[1m[REWIND AUTO-RECONCILIATION INJECTION]\x1b[0m
\x1b[2mCRITICAL NOTICE: The developer forcefully executed a transaction rollback of your last ${stepsUndoneCount} step(s).\x1b[0m
\x1b[36mReverted Working Tree Changes:\x1b[0m ${fileList || 'None'}

\x1b[1mContext Window Realignment:\x1b[0m
1. The changes you previously made to these files have been completely expunged from the disk.
2. Do not attempt to import, reference, or assume the existence of any functions or files removed in those steps.
3. Stop and analyze the existing verified repository baseline before continuing.
\x1b[32mPlease output your revised, non-destructive implementation strategy now.\x1b[0m\n`;
  }

  public injectContextIntoPTY(
    ptyWrite: (input: string) => void,
    report: ReconciliationReport
  ): void {
    const banner = `\n${report.reconciliationStrategy}\n`;
    ptyWrite(banner);
    logger.info('ReconciliationExplainer', `Injected reconciliation strategy into PTY stream (${report.filesReconciled.length} files)`);
  }
}
