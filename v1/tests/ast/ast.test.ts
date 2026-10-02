import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ASTVerifier, ASTConflictError } from '../../src/core/ast-diff';
import { ShadowGit } from '../../src/core/shadow-git';
import { OverlayCAS } from '../../src/core/overlay-cas';
import { RewindLedger } from '../../src/core/ledger';
import { RollbackEngine } from '../../src/core/rollback';
import { StepRecord } from '../../src/types';

describe('AST Safety Tier & ASTVerifier Tests', () => {
  const projectRoot = path.join('/tmp', `rewind-ast-suite-${Date.now()}`);
  const testSessionId = `ast_session_${Date.now()}`;
  const validFile = path.join(projectRoot, 'ast_valid_test.ts');
  const brokenFile = path.join(projectRoot, 'ast_broken_test.ts');

  beforeAll(() => {
    fs.mkdirSync(projectRoot, { recursive: true });
    execSync('git init', { cwd: projectRoot, stdio: 'pipe' });
    execSync('git config user.name "AST Test"', { cwd: projectRoot, stdio: 'pipe' });
    execSync('git config user.email "ast@test.local"', { cwd: projectRoot, stdio: 'pipe' });

    fs.writeFileSync(
      path.join(projectRoot, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS', strict: true } }, null, 2),
      'utf8'
    );

    // Initial commit so HEAD exists
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# AST Test Suite\n', 'utf8');
    execSync('git add . && git commit -m "initial commit"', { cwd: projectRoot, stdio: 'pipe' });
  });

  afterEach(() => {
    if (fs.existsSync(validFile)) fs.unlinkSync(validFile);
    if (fs.existsSync(brokenFile)) fs.unlinkSync(brokenFile);
  });

  afterAll(() => {
    try {
      execSync(`git update-ref -d refs/rewind/${testSessionId}/step_ast_000`, { cwd: projectRoot, stdio: 'pipe' });
      execSync(`git update-ref -d refs/rewind/${testSessionId}/step_ast_001`, { cwd: projectRoot, stdio: 'pipe' });
      execSync(`git update-ref -d refs/rewind/${testSessionId}/step_ast_002`, { cwd: projectRoot, stdio: 'pipe' });
    } catch {
      // Ignore
    }
    if (fs.existsSync(projectRoot)) {
      try {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  test('ASTVerifier detects TS1005 syntax errors and validates clean code', () => {
    const verifier = new ASTVerifier(projectRoot);

    // 1. Valid TypeScript
    fs.writeFileSync(
      validFile,
      'export const validConstant: number = 42;\nexport function add(a: number, b: number): number { return a + b; }\n'
    );
    const isCleanValid = verifier.verifyRestoredState(['ast_valid_test.ts']);
    expect(isCleanValid).toBe(true);

    // 2. Syntax error (TS1005: ';' expected / invalid token)
    fs.writeFileSync(brokenFile, 'export const brokenVar = ;\n');
    const isBrokenValid = verifier.verifyRestoredState(['ast_broken_test.ts']);
    expect(isBrokenValid).toBe(false);
  });

  test('RollbackEngine aborts rollback and performs counter-rollback when AST verification fails', () => {
    const shadowGit = new ShadowGit(testSessionId, projectRoot);
    const overlayCas = new OverlayCAS(projectRoot);
    const ledger = new RewindLedger(projectRoot);
    const rollbackEngine = new RollbackEngine(testSessionId, projectRoot, shadowGit, overlayCas, ledger);

    const baseHead = shadowGit.getCurrentHead();
    ledger.startSession({
      sessionId: testSessionId,
      startedAt: Date.now(),
      commandInvoked: 'test-ast-agent',
      baseHeadCommit: baseHead,
      activeBranch: shadowGit.getCurrentBranch(),
      status: 'ACTIVE',
    });

    // Step 0: Baseline state
    fs.writeFileSync(brokenFile, 'export const message: string = "baseline valid state";\n');
    const commit0 = shadowGit.createSnapshot('step_ast_000', baseHead);
    const tree0 = shadowGit.getTreeHashForCommit(commit0);
    const step0: StepRecord = {
      stepId: 'step_ast_000',
      sessionId: testSessionId,
      stepIndex: 0,
      createdAt: Date.now(),
      gitTreeHash: tree0,
      gitCommitHash: commit0,
      overlayManifestHash: null,
      commandExecuted: 'initial baseline',
      exitCode: 0,
      filesChangedCount: 1,
    };
    ledger.logStep(step0, [{ filePath: 'ast_broken_test.ts', changeType: 'ADDED', isOverlay: false }]);

    // Step 1: Agent writes a file with a catastrophic TS1005 syntax error
    fs.writeFileSync(brokenFile, 'export function corruptedSyntax( { return ;;; \n');
    const commit1 = shadowGit.createSnapshot('step_ast_001', commit0);
    const tree1 = shadowGit.getTreeHashForCommit(commit1);
    const step1: StepRecord = {
      stepId: 'step_ast_001',
      sessionId: testSessionId,
      stepIndex: 1,
      createdAt: Date.now() + 10,
      gitTreeHash: tree1,
      gitCommitHash: commit1,
      overlayManifestHash: null,
      commandExecuted: 'agent introduces syntax error',
      exitCode: 0,
      filesChangedCount: 1,
    };
    ledger.logStep(step1, [{ filePath: 'ast_broken_test.ts', changeType: 'MODIFIED', isOverlay: false }]);

    // Step 2: Agent fixes file to valid state
    const validContent = 'export function workingCode(): string { return "fixed and sound"; }\n';
    fs.writeFileSync(brokenFile, validContent);
    const commit2 = shadowGit.createSnapshot('step_ast_002', commit1);
    const tree2 = shadowGit.getTreeHashForCommit(commit2);
    const step2: StepRecord = {
      stepId: 'step_ast_002',
      sessionId: testSessionId,
      stepIndex: 2,
      createdAt: Date.now() + 20,
      gitTreeHash: tree2,
      gitCommitHash: commit2,
      overlayManifestHash: null,
      commandExecuted: 'agent fixes file',
      exitCode: 0,
      filesChangedCount: 1,
    };
    ledger.logStep(step2, [{ filePath: 'ast_broken_test.ts', changeType: 'MODIFIED', isOverlay: false }]);

    // Now, attempting to rollback to step_ast_001 (which has broken syntax) MUST fail with ASTConflictError
    expect(() => {
      rollbackEngine.restoreToStep(testSessionId, 'step_ast_001', false);
    }).toThrow(ASTConflictError);

    // Verify counter-rollback occurred: working directory file must be reverted back to step_ast_002 valid content!
    const restoredContent = fs.readFileSync(brokenFile, 'utf8');
    expect(restoredContent).toBe(validContent);

    ledger.close();
  });
});
