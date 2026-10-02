#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { AgentRunner } from './core/pty-wrapper';
import { RewindLedger } from './core/ledger';
import { RollbackEngine } from './core/rollback';
import { telemetry } from './utils/telemetry';

const program = new Command();

program
  .name('rewind')
  .description('Rewind: Zero-configuration flight recorder & transaction-rollback hypervisor for CLI coding agents')
  .version('1.0.0');

// 1. `run [agent-command...]`
program
  .command('run')
  .description('Run an AI agent inside the Rewind flight recorder')
  .argument('<command...>', 'The target agent command to execute')
  .option('--enable-metrics', 'Enable Prometheus metrics exporter on 127.0.0.1:49999')
  .action(async (cmdArgs: string[], options: { enableMetrics?: boolean }) => {
    const fullCommand = cmdArgs.join(' ');
    console.log(`\x1b[36m●\x1b[0m \x1b[1mRewind active:\x1b[0m wrapping \x1b[33m${fullCommand}\x1b[0m`);
    console.log(`\x1b[2m  Staging isolated via GIT_INDEX_FILE. Untracked .env & configs tracked via CAS.\x1b[0m\n`);

    const runner = new AgentRunner({
      command: fullCommand,
    });

    if (options.enableMetrics) {
      telemetry.startPrometheusServer(49999, runner.getSessionId());
    }

    const exitCode = await runner.spawn(fullCommand);
    telemetry.stopPrometheusServer();
    console.log(`\n\x1b[36m●\x1b[0m \x1b[1mFlight session closed:\x1b[0m ${runner.getSessionId()} (exit code: ${exitCode})`);
    process.exit(exitCode);
  });

// Shortcuts: rewind claude ... or rewind aider ...
program
  .command('claude')
  .description('Shortcut for: rewind run claude [args...]')
  .allowUnknownOption()
  .argument('[args...]', 'Arguments passed to claude')
  .action(async (args: string[]) => {
    const fullCommand = `claude ${args.join(' ')}`.trim();
    const runner = new AgentRunner({ command: fullCommand });
    const code = await runner.spawn(fullCommand);
    process.exit(code);
  });

program
  .command('aider')
  .description('Shortcut for: rewind run aider [args...]')
  .allowUnknownOption()
  .argument('[args...]', 'Arguments passed to aider')
  .action(async (args: string[]) => {
    const fullCommand = `aider ${args.join(' ')}`.trim();
    const runner = new AgentRunner({ command: fullCommand });
    const code = await runner.spawn(fullCommand);
    process.exit(code);
  });

// 2. `undo [steps]`
program
  .command('undo')
  .description('Revert working tree state by N steps')
  .argument('[steps]', 'Number of steps to revert', '1')
  .option('-f, --force', 'Force rollback even if uncommitted human edits exist')
  .action((stepsStr: string, options: { force?: boolean }) => {
    const stepsCount = parseInt(stepsStr, 10) || 1;
    console.log(`\x1b[36m●\x1b[0m Executing rollback: reverting \x1b[1m${stepsCount}\x1b[0m step(s)...`);

    const engine = new RollbackEngine();
    const result = engine.undo(stepsCount, options.force);

    if (!result.success) {
      console.error(`\n\x1b[31m\x1b[1mRollback Aborted:\x1b[0m ${result.error}`);
      if (result.conflicts && result.conflicts.length > 0) {
        console.error(`Conflicting files:\n${result.conflicts.map(c => `  - ${c}`).join('\n')}`);
      }
      process.exit(1);
    }

    console.log(`\n\x1b[32m\x1b[1m✓ Rollback successful!\x1b[0m`);
    console.log(`  Restored to Step: \x1b[36m${result.targetStepId}\x1b[0m`);
    if (result.compensationStepId) {
      console.log(`  Compensation Step Registered: \x1b[33m${result.compensationStepId}\x1b[0m (History preserved)`);
    }
    console.log(`  Files restored/reconciled: ${result.filesRestored}`);
  });

// 3. `ui`
program
  .command('ui')
  .description('Launch interactive terminal UI scrubber')
  .action(async () => {
    const ledger = new RewindLedger();
    const session = ledger.getLatestSession();
    if (!session) {
      console.log('\x1b[33mNo recorded sessions found.\x1b[0m');
      return;
    }

    const steps = ledger.getStepHistory(session.sessionId, 100);
    const { render } = await import('ink');
    const React = await import('react');
    const { App } = await import('./ui/app.js');

    render(
      React.createElement(App, {
        session,
        steps,
        onRollbackComplete: (targetStepId: string) => {
          console.log(`\x1b[32m✓ Restored repository to checkpoint ${targetStepId}\x1b[0m`);
        },
      })
    );
  });

// 4. `status`
program
  .command('status')
  .description('Display flight recorder status, active session, and storage')
  .action(() => {
    const ledger = new RewindLedger();
    const session = ledger.getLatestSession();
    const casDir = path.join(process.cwd(), '.git', 'rewind', 'overlay', 'blobs');

    let totalBlobsSize = 0;
    if (fs.existsSync(casDir)) {
      const calculateSize = (dir: string): void => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) calculateSize(full);
          else if (entry.isFile()) totalBlobsSize += fs.statSync(full).size;
        }
      };
      try {
        calculateSize(casDir);
      } catch {
        // Ignore
      }
    }

    const formatBytes = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    };

    console.log(`\x1b[1mREWIND FLIGHT STATUS:\x1b[0m`);
    console.log(`\x1b[2m${'─'.repeat(50)}\x1b[0m`);
    console.log(`  Active Session:     ${session ? `\x1b[36m${session.sessionId}\x1b[0m [${session.status}]` : '\x1b[2mNone\x1b[0m'}`);
    console.log(`  Active Git Branch:  ${session ? session.activeBranch : 'main'}`);
    console.log(`  Overlay CAS Storage:${formatBytes(totalBlobsSize)}`);
    console.log(`\x1b[2m${'─'.repeat(50)}\x1b[0m`);
  });

// 5. `mesh` (Phase 6 CRDT Distributed Mesh)
const meshCmd = program.command('mesh').description('Manage distributed P2P Yjs CRDT synchronization mesh');

meshCmd
  .command('start')
  .description('Start a P2P CRDT synchronization mesh node')
  .option('-p, --port <number>', 'WebSocket listen port', '9001')
  .option('-k, --key <string>', 'AES-256-GCM mesh secret key', 'default-mesh-encryption-key-32b!')
  .option('--peer <urls...>', 'Initial peer WebSocket URLs to connect to')
  .action(async (options: { port: string; key: string; peer?: string[] }) => {
    const { RewindMeshNetwork } = await import('./network/mesh.js');
    const port = parseInt(options.port, 10) || 9001;
    const mesh = new RewindMeshNetwork({
      nodeId: `node-${Date.now().toString(36)}`,
      port,
      secretKey: options.key,
    });

    await mesh.startServer(port);
    if (options.peer && options.peer.length > 0) {
      for (const peerUrl of options.peer) {
        try {
          await mesh.connectToPeer(peerUrl);
          console.log(`\x1b[32m  Connected to peer: ${peerUrl}\x1b[0m`);
        } catch (err) {
          console.warn(`\x1b[33m  Warning: failed to connect to peer ${peerUrl}: ${err}\x1b[0m`);
        }
      }
    }

    console.log(`\x1b[32m✓ Rewind P2P Mesh Node active on ws://127.0.0.1:${port}\x1b[0m`);
    console.log(`  Local Peer ID: \x1b[36m${mesh.getNodeId()}\x1b[0m`);
    console.log(`  Encryption:    AES-256-GCM (Zero-Trust)`);
    console.log(`  Yjs CRDT:      Synchronized`);
    console.log(`\x1b[2mPress Ctrl+C to disconnect.\x1b[0m`);

    process.on('SIGINT', () => {
      console.log('\nStopping mesh node...');
      mesh.stop();
      process.exit(0);
    });
  });

meshCmd
  .command('status')
  .description('Display status of local eBPF hypervisor and P2P mesh capabilities')
  .action(async () => {
    const { KernelInterceptor } = await import('./kernel/interceptor.js');
    const interceptor = new KernelInterceptor();
    const isSupported = interceptor.isKernelSupported();

    console.log(`\x1b[1mREWIND HYPERVISOR & MESH STATUS:\x1b[0m`);
    console.log(`\x1b[2m${'─'.repeat(50)}\x1b[0m`);
    console.log(`  OS Platform:        ${process.platform} (${process.arch})`);
    console.log(`  eBPF Tracepoints:   ${isSupported ? '\x1b[32mActive (Native RingBuffer)\x1b[0m' : '\x1b[33mFallback Mode (Sentinel fs.watch)\x1b[0m'}`);
    console.log(`  FUSE Virtual Mount: /tmp/rewind-sandbox/ (CoW Active)`);
    console.log(`  Zero-Trust Mesh:    AES-256-GCM + Yjs Vector Clock`);
    console.log(`\x1b[2m${'─'.repeat(50)}\x1b[0m`);
  });

export { rewindUndo } from './core/rollback';
export { program, AgentRunner, RollbackEngine, RewindLedger };
export { RewindMeshNetwork } from './network/mesh';
export { KernelInterceptor } from './kernel/interceptor';
export { FUSESandbox } from './core/fuse-sandbox';
export { ReconciliationExplainer } from './ai/explainer';

if (typeof require !== 'undefined' && require.main === module) {
  program.parse(process.argv);
}

