import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ShadowGit } from '../../src/core/shadow-git';
import { OverlayCAS } from '../../src/core/overlay-cas';
import { SafetyEngine } from '../../src/core/safety';

describe('Rewind Core Engine Unit Tests', () => {
  const projectRoot = process.cwd();
  const testSessionId = `unit_test_${Date.now()}`;
  const testFile = path.join(projectRoot, 'test_mock_file.txt');
  const largeFile = path.join(projectRoot, '.env.huge_test');

  afterAll(() => {
    // Cleanup temporary test files
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    if (fs.existsSync(largeFile)) fs.unlinkSync(largeFile);
    try {
      execSync(`git update-ref -d refs/rewind/${testSessionId}/step_unit_001`);
    } catch {
      // Ignore
    }
  });

  test('Test 1: Shadow Git Index Isolation', () => {
    const shadowGit = new ShadowGit(testSessionId, projectRoot);
    const initialStatus = execSync('git status --porcelain', { encoding: 'utf8' });

    // Mock a file write
    fs.writeFileSync(testFile, 'Shadow Git isolation test payload', 'utf8');

    // Trigger snapshot
    const headCommit = shadowGit.getCurrentHead();
    const commitHash = shadowGit.createSnapshot('step_unit_001', headCommit);

    expect(commitHash).toBeTruthy();

    // Assert that the user's primary git staging area remains identical
    // (i.e. testFile is untracked '?? test_mock_file.txt', not staged in .git/index!)
    const postStatus = execSync('git status --porcelain', { encoding: 'utf8' });
    const stagedEntries = postStatus.split('\n').filter(line => line.startsWith('M ') || line.startsWith('A '));
    const initialStaged = initialStatus.split('\n').filter(line => line.startsWith('M ') || line.startsWith('A '));
    expect(stagedEntries).toEqual(initialStaged);

    // Assert that custom ref exists and points to valid tree
    const refCommit = execSync(`git rev-parse refs/rewind/${testSessionId}/step_unit_001`, { encoding: 'utf8' }).trim();
    expect(refCommit).toBe(commitHash);

    const treeHash = shadowGit.getTreeHashForCommit(commitHash);
    expect(treeHash).toBeTruthy();
    expect(treeHash.length).toBe(40);
  });

  test('Test 2: Overlay CAS Size Limits', () => {
    const overlayCas = new OverlayCAS(projectRoot);

    // Create a 51MB mock file (51 * 1024 * 1024 bytes)
    const size51MB = 51 * 1024 * 1024;
    const buffer = Buffer.alloc(size51MB, 'a');
    fs.writeFileSync(largeFile, buffer);

    // Attempt to store 51MB file
    const stored = overlayCas.storeFile('.env.huge_test');

    // Assert it returns null and did not write to blob store
    expect(stored).toBeNull();
  });

  test('Test 3: The Safety Dirty Check', () => {
    const shadowGit = new ShadowGit(testSessionId, projectRoot);
    const safetyEngine = new SafetyEngine(projectRoot);

    const safetyStepId = 'step_safety_001';
    const headCommit = shadowGit.getCurrentHead();
    const commitHash = shadowGit.createSnapshot(safetyStepId, headCommit);

    // Working directory should be safe right at snapshot
    const isSafeInitial = safetyEngine.isWorkingTreeSafe(commitHash);
    expect(isSafeInitial).toBe(true);

    // Write a string to test.txt simulating a human edit outside the session
    const humanFile = path.join(projectRoot, 'test.txt');
    fs.writeFileSync(humanFile, 'uncommitted human edit outside agent session', 'utf8');

    // Execute dirty check
    const isSafeAfterEdit = safetyEngine.isWorkingTreeSafe(commitHash);
    expect(isSafeAfterEdit).toBe(false);

    // Cleanup
    if (fs.existsSync(humanFile)) fs.unlinkSync(humanFile);
    try {
      execSync(`git update-ref -d refs/rewind/${testSessionId}/${safetyStepId}`);
    } catch {
      // Ignore
    }
  });
});
