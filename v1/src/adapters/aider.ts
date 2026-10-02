import { AgentAdapter } from './base';

export class AiderAdapter implements AgentAdapter {
  public readonly agentName = 'aider';

  public detectAgent(processEnv: NodeJS.ProcessEnv): boolean {
    return Boolean(
      processEnv.AIDER_SESSION ||
      processEnv.AIDER_ANALYTICS ||
      processEnv.AIDER_ENV
    );
  }

  public getDebounceQuietPeriodMs(): number {
    return 250;
  }

  public extractErrorContext(stderr: string): string {
    return `[Aider] Error: ${stderr.trim().substring(0, 300)}`;
  }
}
