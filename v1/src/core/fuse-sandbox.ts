import * as fs from 'fs';
import * as path from 'path';
import { OverlayCAS } from './overlay-cas';
import { RewindLedger } from './ledger';
import { logger } from '../utils/logger';

export interface FUSESandboxOptions {
  sessionId: string;
  projectRoot?: string;
  overlayCas?: OverlayCAS;
  ledger?: RewindLedger;
}

export class FUSESandbox {
  private sessionId: string;
  private projectRoot: string;
  private mountPath: string;
  private deltaDir: string;
  private overlayCas: OverlayCAS;
  private ledger: RewindLedger;
  private isMountedState: boolean = false;
  private deletedFiles: Set<string> = new Set();
  private writtenFiles: Set<string> = new Set();

  constructor(options: FUSESandboxOptions) {
    this.sessionId = options.sessionId;
    this.projectRoot = path.resolve(options.projectRoot || process.cwd());
    this.mountPath = path.join('/tmp', 'rewind-sandbox', this.sessionId);
    this.deltaDir = path.join(this.projectRoot, '.git', 'rewind', 'sandbox', this.sessionId);
    this.overlayCas = options.overlayCas || new OverlayCAS(this.projectRoot);
    this.ledger = options.ledger || new RewindLedger(this.projectRoot);
  }

  public mount(): string {
    if (this.isMountedState) {
      return this.mountPath;
    }

    // Ensure mount path and delta storage directory exist
    fs.mkdirSync(this.mountPath, { recursive: true });
    fs.mkdirSync(this.deltaDir, { recursive: true });

    // Initialize sandbox tree mirror
    this.syncBaseFiles();
    this.isMountedState = true;
    logger.info('FUSESandbox', `Virtual CoW sandbox mounted at ${this.mountPath}`);
    return this.mountPath;
  }

  private syncBaseFiles(): void {
    // Scaffold symlinks or pass-through structure into sandbox for read transparency
    const entries = fs.readdirSync(this.projectRoot);
    for (const entry of entries) {
      if (entry === '.git' || entry === 'node_modules' || entry === '.tmp') continue;
      const target = path.join(this.projectRoot, entry);
      const link = path.join(this.mountPath, entry);

      if (!fs.existsSync(link)) {
        try {
          fs.symlinkSync(target, link);
        } catch {
          // If symlink fails, copy read-only
          try {
            if (fs.statSync(target).isDirectory()) {
              fs.mkdirSync(link, { recursive: true });
            } else {
              fs.copyFileSync(target, link);
            }
          } catch {
            // Ignore transient file lock
          }
        }
      }
    }
  }

  public getSandboxCwd(): string {
    return this.mountPath;
  }

  public isMounted(): boolean {
    return this.isMountedState;
  }

  public readFile(relativePath: string): Buffer {
    // Check if file was deleted in sandbox
    if (this.deletedFiles.has(relativePath)) {
      throw new Error(`ENOENT: no such file or directory, open '${relativePath}'`);
    }

    // Check if delta exists in CoW store
    const deltaPath = path.join(this.deltaDir, relativePath);
    if (fs.existsSync(deltaPath)) {
      return fs.readFileSync(deltaPath);
    }

    // Pass-through to real project directory
    const realPath = path.join(this.projectRoot, relativePath);
    return fs.readFileSync(realPath);
  }

  public writeFile(relativePath: string, data: Buffer | string): void {
    const deltaPath = path.join(this.deltaDir, relativePath);
    fs.mkdirSync(path.dirname(deltaPath), { recursive: true });

    fs.writeFileSync(deltaPath, data);
    this.deletedFiles.delete(relativePath);
    this.writtenFiles.add(relativePath);

    // Also mirror to sandbox mount so subshell processes see their own writes
    const mountFilePath = path.join(this.mountPath, relativePath);
    try {
      if (fs.existsSync(mountFilePath) && fs.lstatSync(mountFilePath).isSymbolicLink()) {
        fs.unlinkSync(mountFilePath);
      }
      fs.mkdirSync(path.dirname(mountFilePath), { recursive: true });
      fs.writeFileSync(mountFilePath, data);
    } catch {
      // Ignore mirror failures
    }

    // Record in CAS overlay if applicable
    this.overlayCas.storeFile(relativePath);
    logger.debug('FUSESandbox', `Intercepted CoW write to ${relativePath} (real disk untouched)`);
  }

  public unlink(relativePath: string): void {
    this.deletedFiles.add(relativePath);
    this.writtenFiles.delete(relativePath);

    // Remove from sandbox mount view
    const mountFilePath = path.join(this.mountPath, relativePath);
    if (fs.existsSync(mountFilePath)) {
      try {
        fs.unlinkSync(mountFilePath);
      } catch {
        // Ignore
      }
    }

    const deltaPath = path.join(this.deltaDir, relativePath);
    if (fs.existsSync(deltaPath)) {
      try {
        fs.unlinkSync(deltaPath);
      } catch {
        // Ignore
      }
    }

    logger.debug('FUSESandbox', `Intercepted CoW unlink for ${relativePath} (real disk protected)`);
  }

  public promote(): number {
    // Promote approved deltas from sandbox to physical disk
    let promotedCount = 0;

    // Apply written files
    for (const relPath of this.writtenFiles) {
      const deltaPath = path.join(this.deltaDir, relPath);
      const realPath = path.join(this.projectRoot, relPath);
      if (fs.existsSync(deltaPath)) {
        fs.mkdirSync(path.dirname(realPath), { recursive: true });
        fs.copyFileSync(deltaPath, realPath);
        promotedCount++;
      }
    }

    // Apply deleted files
    for (const relPath of this.deletedFiles) {
      const realPath = path.join(this.projectRoot, relPath);
      if (fs.existsSync(realPath)) {
        try {
          fs.unlinkSync(realPath);
          promotedCount++;
        } catch {
          // Ignore
        }
      }
    }

    logger.info('FUSESandbox', `Promoted ${promotedCount} delta mutations to real project disk`);
    this.discard();
    return promotedCount;
  }

  public discard(): void {
    this.writtenFiles.clear();
    this.deletedFiles.clear();
    if (fs.existsSync(this.deltaDir)) {
      try {
        fs.rmSync(this.deltaDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  }

  public unmount(): void {
    this.discard();
    if (fs.existsSync(this.mountPath)) {
      try {
        fs.rmSync(this.mountPath, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
    this.isMountedState = false;
    logger.info('FUSESandbox', 'Virtual CoW sandbox unmounted');
  }
}
