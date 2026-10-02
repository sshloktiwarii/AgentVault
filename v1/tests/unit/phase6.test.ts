import * as fs from 'fs';
import * as path from 'path';
import { KernelInterceptor } from '../../src/kernel/interceptor';
import { FUSESandbox } from '../../src/core/fuse-sandbox';
import { ReconciliationExplainer } from '../../src/ai/explainer';
import { DiffEntry } from '../../src/types';

describe('Phase 6 Kernel Hypervisor, FUSE Sandbox & AI Reconciliation Unit Tests', () => {
  const projectRoot = path.join('/tmp', `rewind-p6-unit-${Date.now()}`);
  const testSessionId = `session_p6_unit_${Date.now()}`;

  beforeAll(() => {
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'sample.txt'), 'original content\n', 'utf8');
  });

  afterAll(() => {
    if (fs.existsSync(projectRoot)) {
      try {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  test('KernelInterceptor activates Graceful Degradation on host OS without panics', async () => {
    const interceptor = new KernelInterceptor(projectRoot);
    expect(interceptor.getMode()).toBe('FALLBACK_SENTINEL');
    expect(interceptor.isGracefulFallback()).toBe(true);

    const receivedEvents: string[] = [];
    interceptor.on('mutation', (event) => {
      receivedEvents.push(event.filename);
    });

    await interceptor.start(process.pid);
    expect(interceptor.getMode()).toBe('FALLBACK_SENTINEL');

    // Trigger file change to verify sentinel event emission
    const probeFile = path.join(projectRoot, 'sentinel_probe.txt');
    fs.writeFileSync(probeFile, 'probe content', 'utf8');

    await new Promise((r) => setTimeout(r, 200));

    expect(receivedEvents.length).toBeGreaterThanOrEqual(1);

    if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile);
    await interceptor.stop();
  });

  test('FUSESandbox protects physical disk with Copy-on-Write and supports promotion', () => {
    const sandbox = new FUSESandbox({
      sessionId: testSessionId,
      projectRoot,
    });

    const mountPath = sandbox.mount();
    expect(sandbox.isMounted()).toBe(true);
    expect(fs.existsSync(mountPath)).toBe(true);

    // 1. Read pass-through from real project directory
    const readInitial = sandbox.readFile('sample.txt').toString('utf8');
    expect(readInitial).toBe('original content\n');

    // 2. Perform destructive edit in sandbox
    sandbox.writeFile('sample.txt', 'MUTATED BY ROGUE AGENT');

    // Sandbox sees mutated version
    const readSandbox = sandbox.readFile('sample.txt').toString('utf8');
    expect(readSandbox).toBe('MUTATED BY ROGUE AGENT');

    // Real physical disk MUST remain completely untouched!
    const realDiskContent = fs.readFileSync(path.join(projectRoot, 'sample.txt'), 'utf8');
    expect(realDiskContent).toBe('original content\n');

    // 3. User approves and promotes delta to real disk
    const promoted = sandbox.promote();
    expect(promoted).toBeGreaterThanOrEqual(1);

    const postPromoteRealContent = fs.readFileSync(path.join(projectRoot, 'sample.txt'), 'utf8');
    expect(postPromoteRealContent).toBe('MUTATED BY ROGUE AGENT');

    sandbox.unmount();
    expect(sandbox.isMounted()).toBe(false);
  });

  test('ReconciliationExplainer formats rollback diffs and generates context realignment', async () => {
    const explainer = new ReconciliationExplainer({ timeoutMs: 100 });

    const diffs: DiffEntry[] = [
      { filePath: 'src/corrupted.ts', changeType: 'DELETED', isOverlay: false },
      { filePath: '.env', changeType: 'MODIFIED', isOverlay: true },
      { filePath: 'src/bad_feature.ts', changeType: 'ADDED', isOverlay: false },
    ];

    const report = await explainer.generateCorrection(3, diffs);
    expect(report.promptIssued).toContain('rolled back your last 3 actions');
    expect(report.filesReconciled).toEqual(['src/corrupted.ts', '.env', 'src/bad_feature.ts']);
    expect(report.reconciliationStrategy).toContain('REWIND AUTO-RECONCILIATION INJECTION');
    expect(report.reconciliationStrategy).toContain('Context Window Realignment');

    // Test PTY injection
    let injectedBuffer = '';
    explainer.injectContextIntoPTY((chunk) => {
      injectedBuffer += chunk;
    }, report);

    expect(injectedBuffer).toContain('REWIND AUTO-RECONCILIATION INJECTION');
  });
});
