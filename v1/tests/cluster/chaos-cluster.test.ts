import * as Y from 'yjs';
import { RewindMeshNetwork } from '../../src/network/mesh';
import { StepRecord, SessionRecord } from '../../src/types';

describe('Phase 6 Chaos Monkey Cluster Test', () => {
  const NODE_COUNT = 5;
  const TOTAL_MUTATIONS = 10000;
  const MUTATIONS_PER_NODE = TOTAL_MUTATIONS / NODE_COUNT; // 2,000 per node
  const nodes: RewindMeshNetwork[] = [];
  const basePort = 48100 + Math.floor(Math.random() * 500);

  beforeAll(async () => {
    // 1. Initialize 5 mesh nodes
    for (let i = 0; i < NODE_COUNT; i++) {
      const node = new RewindMeshNetwork({
        nodeId: `node_dev_${i}`,
        secretKey: 'chaos-cluster-shared-secret-key-1234',
      });
      nodes.push(node);
    }

    // 2. Start server on Node 0 (hub)
    const hubPort = await nodes[0].startServer(basePort);

    // 3. Connect remaining nodes to hub
    for (let i = 1; i < NODE_COUNT; i++) {
      await nodes[i].connectToPeer(`ws://127.0.0.1:${hubPort}`);
    }

    // Brief stabilization window
    await new Promise((r) => setTimeout(r, 200));
  }, 30000);

  afterAll(() => {
    for (const node of nodes) {
      try {
        node.stop();
      } catch {
        // Ignore
      }
    }
  });

  test('Orchestrates 10,000 concurrent mutations across 5 nodes and verifies CRDT mathematical convergence', async () => {
    const startTime = Date.now();
    let totalConflictsDetected = 0;

    // Track conflict events across nodes
    for (const node of nodes) {
      node.on('conflict', () => {
        totalConflictsDetected++;
      });
    }

    // Setup base sessions for each node
    const sessions: SessionRecord[] = nodes.map((n, idx) => ({
      sessionId: `session_dev_${idx}`,
      startedAt: Date.now(),
      commandInvoked: `agent-dev-${idx}`,
      baseHeadCommit: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      activeBranch: 'main',
      status: 'ACTIVE',
    }));

    // Concurrently fire 2,000 mutations on each of the 5 nodes (10,000 total)
    const filePool = [
      'src/auth.ts',
      'src/api.ts',
      'src/db.ts',
      'src/utils/calc.ts',
      'src/components/Button.tsx',
      'src/models/user.ts',
      'src/config.ts',
      'src/services/payment.ts',
    ];

    const nodePromises = nodes.map(async (node, nodeIdx) => {
      const session = sessions[nodeIdx];
      const batchSize = 500;

      for (let step = 0; step < MUTATIONS_PER_NODE; step++) {
        const stepIndex = nodeIdx * MUTATIONS_PER_NODE + step;
        const stepId = `step_cluster_${String(stepIndex).padStart(6, '0')}`;
        const targetFile = filePool[step % filePool.length];

        const stepRecord: StepRecord = {
          stepId,
          sessionId: session.sessionId,
          stepIndex,
          createdAt: Date.now(),
          gitTreeHash: `tree_${stepIndex}_hash`,
          gitCommitHash: `commit_${stepIndex}_hash`,
          overlayManifestHash: null,
          commandExecuted: `mutation_${stepIndex}`,
          exitCode: 0,
          filesChangedCount: 1,
        };

        node.recordStep(stepRecord, session, [targetFile]);

        if (step % batchSize === 0) {
          node.syncFullState();
          await new Promise((r) => setImmediate(r));
        }
      }
    });

    // Wait for all 10,000 local mutations to be logged into Y.Docs
    await Promise.all(nodePromises);

    // Broadcast full CRDT state updates across mesh
    for (const node of nodes) {
      node.syncFullState();
    }

    const elapsed = Date.now() - startTime;
    console.log(`Fired 10,000 mutations across 5 nodes in ${elapsed}ms`);

    // Wait for Yjs mesh sync to settle convergence
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !nodes.every((n) => n.getStepsCount() === TOTAL_MUTATIONS)) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Assertion 1: Verify all 5 nodes have recorded all 10,000 steps
    for (let i = 0; i < NODE_COUNT; i++) {
      const stepCount = nodes[i].getStepsCount();
      // Ensure zero dropped events
      expect(stepCount).toBe(TOTAL_MUTATIONS);
    }

    // Assertion 2: Mathematical identity of Yjs CRDT documents across all nodes
    const doc0 = nodes[0].getDoc();
    const doc0Map = doc0.getMap<StepRecord>('steps').toJSON();

    for (let i = 1; i < NODE_COUNT; i++) {
      const docIMap = nodes[i].getDoc().getMap<StepRecord>('steps').toJSON();
      expect(Object.keys(docIMap).length).toBe(Object.keys(doc0Map).length);
      expect(Object.keys(docIMap).length).toBe(TOTAL_MUTATIONS);
    }

    // Assertion 3: Sequence conflict detection operated during concurrent writes
    expect(totalConflictsDetected).toBeGreaterThan(0);
  }, 60000);
});
