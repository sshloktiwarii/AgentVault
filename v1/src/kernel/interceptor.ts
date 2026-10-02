import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

export interface SyscallEvent {
  pid: number;
  eventType: 'OPENAT' | 'WRITE';
  fd: number;
  bytesWritten: number;
  timestampNs: number;
  comm: string;
  filename: string;
}

export type InterceptorMode = 'EBPF' | 'FALLBACK_SENTINEL';

export interface NativeBpfAddon {
  checkKernelSupport: () => boolean;
  initInterceptor: (callback: (event: SyscallEvent) => void) => boolean;
  addTrackedPid: (pid: number) => boolean;
  stopInterceptor: () => boolean;
}

export class KernelInterceptor extends EventEmitter {
  private mode: InterceptorMode = 'FALLBACK_SENTINEL';
  private nativeAddon: NativeBpfAddon | null = null;
  private isRunning: boolean = false;
  private trackedPids: Set<number> = new Set();
  private watcher: fs.FSWatcher | null = null;
  private watchDir: string;

  constructor(watchDir: string = process.cwd()) {
    super();
    this.watchDir = path.resolve(watchDir);
    this.probeKernelCapabilities();
  }

  private probeKernelCapabilities(): void {
    const isLinux = os.platform() === 'linux';

    if (!isLinux) {
      this.mode = 'FALLBACK_SENTINEL';
      logger.info(
        'KernelInterceptor',
        `Host OS is ${os.platform()} (non-Linux). Activating Graceful Degradation to Phase 5 Watcher Sentinel.`
      );
      return;
    }

    // Attempt to load native eBPF addon if compiled on Linux
    const possiblePaths = [
      path.join(__dirname, '../../build/Release/rewind_bpf.node'),
      path.join(__dirname, '../build/Release/rewind_bpf.node'),
      path.join(process.cwd(), 'build/Release/rewind_bpf.node'),
    ];

    for (const addonPath of possiblePaths) {
      if (fs.existsSync(addonPath)) {
        try {
          const addon = require(addonPath) as NativeBpfAddon;
          if (addon.checkKernelSupport()) {
            this.nativeAddon = addon;
            this.mode = 'EBPF';
            logger.info('KernelInterceptor', 'eBPF Kernel Hypervisor active via libbpf.');
            return;
          }
        } catch (err) {
          logger.warn('KernelInterceptor', `Failed to initialize eBPF module from ${addonPath}: ${err}`);
        }
      }
    }

    this.mode = 'FALLBACK_SENTINEL';
    logger.info(
      'KernelInterceptor',
      'eBPF native module not available or missing kernel headers. Graceful fallback active.'
    );
  }

  public getMode(): InterceptorMode {
    return this.mode;
  }

  public isGracefulFallback(): boolean {
    return this.mode === 'FALLBACK_SENTINEL';
  }

  public isKernelSupported(): boolean {
    return this.mode === 'EBPF';
  }

  public async start(targetPid?: number): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    if (targetPid) {
      this.trackedPids.add(targetPid);
    }

    if (this.mode === 'EBPF' && this.nativeAddon) {
      try {
        this.nativeAddon.initInterceptor((event: SyscallEvent) => {
          this.emit('mutation', event);
        });

        if (targetPid) {
          this.nativeAddon.addTrackedPid(targetPid);
        }
        return;
      } catch (err) {
        logger.warn('KernelInterceptor', `eBPF runtime activation failed: ${err}. Falling back to Sentinel.`);
        this.mode = 'FALLBACK_SENTINEL';
      }
    }

    // Fallback: Phase 5 Sentinel via native high-speed fs.watch
    try {
      this.watcher = fs.watch(this.watchDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const norm = filename.toString();
        if (
          norm.startsWith('.git') ||
          norm.includes('node_modules') ||
          norm.startsWith('dist') ||
          norm.startsWith('.tmp') ||
          norm.startsWith('/tmp')
        ) {
          return;
        }

        const syntheticEvent: SyscallEvent = {
          pid: targetPid || process.pid,
          eventType: eventType === 'rename' ? 'OPENAT' : 'WRITE',
          fd: 3,
          bytesWritten: 1,
          timestampNs: Number(process.hrtime.bigint()),
          comm: 'agent-sentinel',
          filename: norm,
        };

        this.emit('mutation', syntheticEvent);
      });
    } catch {
      this.watcher = fs.watch(this.watchDir, (eventType, filename) => {
        if (!filename) return;
        const syntheticEvent: SyscallEvent = {
          pid: targetPid || process.pid,
          eventType: eventType === 'rename' ? 'OPENAT' : 'WRITE',
          fd: 3,
          bytesWritten: 1,
          timestampNs: Number(process.hrtime.bigint()),
          comm: 'agent-sentinel',
          filename: filename.toString(),
        };
        this.emit('mutation', syntheticEvent);
      });
    }
  }

  public trackPid(pid: number): void {
    this.trackedPids.add(pid);
    if (this.mode === 'EBPF' && this.nativeAddon) {
      this.nativeAddon.addTrackedPid(pid);
    }
  }

  public async stop(): Promise<void> {
    this.isRunning = false;

    if (this.mode === 'EBPF' && this.nativeAddon) {
      try {
        this.nativeAddon.stopInterceptor();
      } catch {
        // Ignore
      }
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    this.trackedPids.clear();
    this.removeAllListeners();
  }
}
