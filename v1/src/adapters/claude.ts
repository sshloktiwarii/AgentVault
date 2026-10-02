import { AgentAdapter } from './base';

export class ClaudeCodeAdapter implements AgentAdapter {
  public readonly agentName = 'claude-code';

  public detectAgent(processEnv: NodeJS.ProcessEnv): boolean {
    return Boolean(
      processEnv.CLAUDE_CODE_SESSION_ID ||
      processEnv.CLAUDE_CODE_ENTRYPOINT ||
      processEnv.CLAUDE_PROJECT_DIR
    );
  }

  public getDebounceQuietPeriodMs(): number {
    // Claude Code writes in chunked streams; expand debounce to 1500ms
    return 1500;
  }

  public extractErrorContext(stderr: string): string {
    return `[ClaudeCode] Error: ${stderr.trim().substring(0, 300)}`;
  }
}
