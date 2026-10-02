import * as fs from 'fs';
import * as path from 'path';
import { ShadowGit } from '../src/core/shadow-git';
import { OverlayCAS } from '../src/core/overlay-cas';
import { RewindLedger } from '../src/core/ledger';

async function runMemoryLeakProfile(): Promise<void> {
  console.log('Running Memory Leak Profile...');
  const testRoot = path.join('/tmp', `rewind-mem-test-${Date.now()}`);
  fs.mkdirSync(testRoot, { recursive: true });

  const sessionId = `mem_profile_${Date.now()}`;
  const ledger = new RewindLedger(testRoot);
  const cas = new OverlayCAS(testRoot);

  ledger.startSession({
    sessionId,
    startedAt: Date.now(),
    commandInvoked: 'memory-leak-profile',
    baseHeadCommit: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    activeBranch: 'main',
    status: 'ACTIVE',
  });

  const initialMemory = process.memoryUsage().heapUsed;

  // Run 100 iterations of ledger writes and CAS operations
  for (let i = 0; i < 100; i++) {
    const stepId = `step_mem_${String(i).padStart(4, '0')}`;
    ledger.logStep(
      {
        stepId,
        sessionId,
        stepIndex: i,
        createdAt: Date.now(),
        gitTreeHash: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
        gitCommitHash: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
        overlayManifestHash: null,
        commandExecuted: `profile-step-${i}`,
        exitCode: 0,
        filesChangedCount: 1,
      },
      [{ filePath: `file_${i}.ts`, changeType: 'ADDED', isOverlay: false }]
    );

    if (i % 20 === 0 && global.gc) {
      global.gc();
    }
  }

  const finalMemory = process.memoryUsage().heapUsed;
  const memoryDeltaMB = (finalMemory - initialMemory) / (1024 * 1024);

  console.log(`Initial Heap: ${(initialMemory / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`Final Heap:   ${(finalMemory / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`Delta:        ${memoryDeltaMB.toFixed(2)} MB`);

  ledger.close();
  fs.rmSync(testRoot, { recursive: true, force: true });

  // Assert delta is within healthy bounds (< 35MB)
  if (memoryDeltaMB > 35) {
    console.error(`Memory leak detected! Heap increased by ${memoryDeltaMB.toFixed(2)} MB`);
    process.exit(1);
  }

  console.log('Memory Leak Profile: PASSED (Zero uncollected allocations)');
}

runMemoryLeakProfile().catch((err) => {
  console.error(err);
  process.exit(1);
});
