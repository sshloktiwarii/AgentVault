import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { scaffoldMockProject, simulateRogueAgent } from './mutator';
import { hashDirectory } from '../../src/utils/hash';
import { DaemonServer } from '../../src/daemon/server';
import { DaemonClient } from '../../src/daemon/client';
import { IPCMessageType } from '../../src/types/ipc';
import { rewindUndo } from '../../src/core/rollback';

describe('The 100-Step Chaos Fuzz Test Harness', () => {
  const targetDir = path.join('/tmp', `rewind-fuzz-suite-${Date.now()}`);
  const sessionId = `fuzz_session_${Date.now()}`;
  let server: DaemonServer;
  let client: DaemonClient;
  let initialHead: string;
  let initialStatus: string;
  let HASH_INITIAL: string;

  beforeAll(async () => {
    // 1. Scaffold mock project in an isolated /tmp directory
    fs.mkdirSync(targetDir, { recursive: true });
    execSync('git init', { cwd: targetDir, stdio: 'pipe' });
    execSync('git config user.name "Rewind Fuzz Bot"', { cwd: targetDir, stdio: 'pipe' });
    execSync('git config user.email "fuzz@rewind.local"', { cwd: targetDir, stdio: 'pipe' });

    scaffoldMockProject(targetDir, 500);

    // Initial commit
    execSync('git add . && git commit -m "baseline: 500-file project scaffold"', {
      cwd: targetDir,
      stdio: 'pipe',
    });

    initialHead = execSync('git rev-parse HEAD', { cwd: targetDir, encoding: 'utf8' }).trim();
    initialStatus = execSync('git status --porcelain', { cwd: targetDir, encoding: 'utf8' }).trim();

    // 2. Capture the exact cryptographic hash of the entire working directory
    HASH_INITIAL = hashDirectory(targetDir, ['.git', 'node_modules']);
    expect(HASH_INITIAL).toBeTruthy();

    // 3. Start background DaemonServer and connect DaemonClient over local UNIX socket
    server = new DaemonServer(sessionId, targetDir);
    await server.start();

    client = new DaemonClient(sessionId);
    await client.connect();

    // Baseline snapshot: step_0000
    await client.sendAndWait(IPCMessageType.FORCE_SNAPSHOT, {});
  }, 30000);

  afterAll(() => {
    try {
      client?.disconnect();
      server?.shutdown();
    } catch {
      // Ignore
    }
    if (fs.existsSync(targetDir)) {
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  test('Orchestrates 100-Step Rogue Agent Chaos Loop and executes 100-step rollback with cryptographic equality', async () => {
    // Run 100 chaos mutations, triggering a snapshot after each step
    let snapshotCount = 0;
    await simulateRogueAgent(targetDir, 100, async () => {
      await client.sendAndWait(IPCMessageType.FORCE_SNAPSHOT, {});
      snapshotCount++;
    });

    expect(snapshotCount).toBe(100);

    // Assert that HASH_INITIAL !== HASH_CURRENT
    const HASH_CURRENT = hashDirectory(targetDir, ['.git', 'node_modules']);
    expect(HASH_CURRENT).not.toEqual(HASH_INITIAL);

    // Trigger rewind undo 100 via the CLI programmatic API
    const undoResult = rewindUndo(100, true, targetDir, sessionId);
    expect(undoResult.success).toBe(true);

    // Capture the new directory hash as HASH_RESTORED
    const HASH_RESTORED = hashDirectory(targetDir, ['.git', 'node_modules']);

    // The Ultimate Assertion: exact cryptographic equality
    expect(HASH_RESTORED).toEqual(HASH_INITIAL);

    // Crucial: Run git status. Assert that git staging area and HEAD are completely unchanged
    const finalHead = execSync('git rev-parse HEAD', { cwd: targetDir, encoding: 'utf8' }).trim();
    expect(finalHead).toEqual(initialHead);

    const finalStatus = execSync('git status --porcelain', { cwd: targetDir, encoding: 'utf8' }).trim();
    expect(finalStatus).toEqual(initialStatus);
  }, 120000);
});
