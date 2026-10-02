import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { SessionRecord, StepRecord, DiffEntry } from '../types';
import { RollbackEngine } from '../core/rollback';

interface AppProps {
  session: SessionRecord | null;
  steps: StepRecord[];
  onRollbackComplete?: (targetStepId: string) => void;
}

export const Header: React.FC<{ session: SessionRecord | null; totalSteps: number }> = ({ session, totalSteps }) => (
  <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} marginBottom={1}>
    <Text bold color="cyan">Rewind TUI Scrubber</Text>
    <Box>
      <Text dimColor>Session: </Text>
      <Text bold>{session ? session.sessionId : 'None'}</Text>
      <Text dimColor>  |  Branch: </Text>
      <Text color="yellow">{session ? session.activeBranch : 'unknown'}</Text>
      <Text dimColor>  |  Checkpoints: </Text>
      <Text color="green">{totalSteps}</Text>
    </Box>
  </Box>
);

export const StepList: React.FC<{ steps: StepRecord[]; cursorIndex: number }> = ({ steps, cursorIndex }) => (
  <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} width="50%">
    <Text bold underline>Checkpoints</Text>
    {steps.length === 0 ? (
      <Text dimColor>No steps recorded.</Text>
    ) : (
      steps.map((step, idx) => {
        const isSelected = idx === cursorIndex;
        const timeStr = new Date(step.createdAt).toLocaleTimeString();
        return (
          <Box key={step.stepId}>
            <Text color={isSelected ? 'green' : 'white'} bold={isSelected}>
              {isSelected ? '▶ ' : '  '}
              {step.stepId.padEnd(10)}
            </Text>
            <Text dimColor>[{timeStr}] </Text>
            <Text color="yellow">{step.gitTreeHash.substring(0, 7)} </Text>
            <Text color="cyan">({step.filesChangedCount} files)</Text>
          </Box>
        );
      })
    )}
  </Box>
);

export const DiffView: React.FC<{ diffs: DiffEntry[] }> = ({ diffs }) => (
  <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} width="50%" marginLeft={1}>
    <Text bold underline>Changed Files</Text>
    {diffs.length === 0 ? (
      <Text dimColor>No file modifications in this step.</Text>
    ) : (
      diffs.slice(0, 10).map((diff, idx) => {
        const color = diff.changeType === 'ADDED' ? 'green' : diff.changeType === 'DELETED' ? 'red' : 'yellow';
        return (
          <Box key={`${diff.filePath}-${idx}`}>
            <Text color={color} bold>{diff.changeType.padEnd(8)} </Text>
            <Text>{diff.filePath}</Text>
            {diff.isOverlay && <Text color="magenta"> [overlay]</Text>}
          </Box>
        );
      })
    )}
    {diffs.length > 10 && <Text dimColor>... and {diffs.length - 10} more files</Text>}
  </Box>
);

export const ActionFooter: React.FC = () => (
  <Box marginTop={1} paddingX={1} borderStyle="single" borderColor="blue">
    <Text bold color="cyan">[↑/↓]</Text>
    <Text> Navigate Steps   </Text>
    <Text bold color="green">[Enter]</Text>
    <Text> Restore to this step   </Text>
    <Text bold color="red">[Esc / q]</Text>
    <Text> Exit</Text>
  </Box>
);

export const App: React.FC<AppProps> = ({ session, steps, onRollbackComplete }) => {
  const { exit } = useApp();
  const [cursorIndex, setCursorIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      exit();
      return;
    }

    if (key.upArrow) {
      setCursorIndex(prev => Math.max(0, prev - 1));
    }

    if (key.downArrow) {
      setCursorIndex(prev => Math.min(steps.length - 1, prev + 1));
    }

    if (key.return) {
      if (steps.length === 0 || !session) return;
      const targetStep = steps[cursorIndex];

      try {
        const engine = new RollbackEngine(session.sessionId);
        const result = engine.restoreToStep(session.sessionId, targetStep.stepId, false);
        if (result.success) {
          setStatusMessage(`Successfully restored to ${targetStep.stepId}`);
          if (onRollbackComplete) {
            onRollbackComplete(targetStep.stepId);
          }
          exit();
        } else {
          setStatusMessage(`Rollback failed: ${result.error}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatusMessage(`Error: ${msg}`);
      }
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Header session={session} totalSteps={steps.length} />
      <Box flexDirection="row">
        <StepList steps={steps} cursorIndex={cursorIndex} />
        <DiffView diffs={[]} />
      </Box>
      {statusMessage && (
        <Box marginTop={1}>
          <Text bold color="yellow">{statusMessage}</Text>
        </Box>
      )}
      <ActionFooter />
    </Box>
  );
};
