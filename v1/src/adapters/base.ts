export interface AgentAdapter {
  agentName: string;
  detectAgent(processEnv: NodeJS.ProcessEnv): boolean;
  onSubshellCommandStart?(command: string): void;
  onSubshellCommandEnd?(exitCode: number): void;
  extractErrorContext?(stderr: string): string;
  getDebounceQuietPeriodMs?(): number;
}
