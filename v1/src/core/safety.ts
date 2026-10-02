import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export class SafetyConflictError extends Error {
  constructor(message: string, public readonly conflicts?: string[]) {
    super(message);
    this.name = 'SafetyConflictError';
  }
}

export class SafetyEngine {
  private projectRoot: string;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = path.resolve(projectRoot);
  }

  private createEphemeralIndex(): string {
    const tempName = `rewind-safety-${Date.now()}-${Math.random().toString(36).substring(2)}.tmp`;
    const tempPath = path.join('/tmp', tempName);
    try {
      fs.accessSync('/tmp', fs.constants.W_OK);
      return tempPath;
    } catch {
      return path.join(this.projectRoot, '.git', tempName);
    }
  }

  public isWorkingTreeSafe(latestAgentCommitHash: string): boolean {
    if (!latestAgentCommitHash || latestAgentCommitHash === '4b825dc642cb6eb9a060e54bf8d69288fbee4904') {
      return true;
    }

    const tempIdx = this.createEphemeralIndex();
    try {
      execSync('git read-tree --empty', {
        cwd: this.projectRoot,
        env: { ...process.env, GIT_INDEX_FILE: tempIdx },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      execSync('git add --all', {
        cwd: this.projectRoot,
        env: { ...process.env, GIT_INDEX_FILE: tempIdx },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      execSync(`git diff-index --quiet "${latestAgentCommitHash}"`, {
        cwd: this.projectRoot,
        env: { ...process.env, GIT_INDEX_FILE: tempIdx },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (err: unknown) {
      const execError = err as { status?: number; stderr?: Buffer | string; message?: string };
      if (execError.status === 1) {
        // Exit code 1 indicates differences exist (dirty working tree)
        return false;
      }
      // Fatal git error occurred
      const stderr = execError.stderr ? execError.stderr.toString() : execError.message || String(err);
      throw new Error(`SafetyEngine check failed: ${stderr}`);
    } finally {
      if (fs.existsSync(tempIdx)) {
        try {
          fs.unlinkSync(tempIdx);
        } catch {
          // Ignore unlink errors
        }
      }
    }
  }

  public getConflictingFiles(latestAgentCommitHash: string): string[] {
    const tempIdx = this.createEphemeralIndex();
    try {
      execSync('git read-tree --empty', {
        cwd: this.projectRoot,
        env: { ...process.env, GIT_INDEX_FILE: tempIdx },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      execSync('git add --all', {
        cwd: this.projectRoot,
        env: { ...process.env, GIT_INDEX_FILE: tempIdx },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const output = execSync(`git diff-index --name-only "${latestAgentCommitHash}"`, {
        cwd: this.projectRoot,
        env: { ...process.env, GIT_INDEX_FILE: tempIdx },
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (!output) return [];
      return output.split('\n').filter(Boolean);
    } catch {
      return [];
    } finally {
      if (fs.existsSync(tempIdx)) {
        try {
          fs.unlinkSync(tempIdx);
        } catch {
          // Ignore
        }
      }
    }
  }
}
