import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DiffEntry } from '../types';

export class ShadowGitError extends Error {
  constructor(message: string, public readonly stderr?: string) {
    super(message);
    this.name = 'ShadowGitError';
  }
}

export class ShadowGit {
  private sessionId: string;
  private shadowIdx: string;
  private projectRoot: string;
  private readonly EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

  constructor(sessionId: string, projectRoot: string = process.cwd()) {
    this.sessionId = sessionId;
    this.projectRoot = path.resolve(projectRoot);
    this.shadowIdx = `/tmp/rewind-idx-${sessionId}.tmp`;

    // Ensure /tmp path is writable
    try {
      fs.accessSync('/tmp', fs.constants.W_OK);
    } catch {
      // Fallback if /tmp is restricted
      this.shadowIdx = path.join(this.projectRoot, '.git', `rewind-idx-${sessionId}.tmp`);
    }

    this.ensureExcludes();
  }

  private ensureExcludes(): void {
    const excludeFile = path.join(this.projectRoot, '.git', 'info', 'exclude');
    if (fs.existsSync(path.dirname(excludeFile))) {
      let content = '';
      if (fs.existsSync(excludeFile)) {
        content = fs.readFileSync(excludeFile, 'utf8');
      }

      const defaultExcludes = [
        'node_modules/',
        '.next/',
        'dist/',
        'build/',
        'target/',
        'coverage/',
      ];

      const toAdd = defaultExcludes.filter(pattern => !content.includes(pattern));
      if (toAdd.length > 0) {
        const appended = content + (content.endsWith('\n') ? '' : '\n') +
          '# Rewind default exclusions\n' +
          toAdd.join('\n') + '\n';
        fs.writeFileSync(excludeFile, appended, 'utf8');
      }
    }
  }

  private execGit(cmd: string, envOverrides: Record<string, string> = {}): string {
    const env = {
      ...process.env,
      ...envOverrides,
    };
    try {
      return execSync(`git ${cmd}`, {
        cwd: this.projectRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      }).trim();
    } catch (error: unknown) {
      const execError = error as { stderr?: Buffer | string; message?: string };
      const stderr = execError.stderr ? execError.stderr.toString() : execError.message || String(error);
      try {
        fs.writeFileSync('rewind_fatal_error.log', stderr, 'utf8');
      } catch {
        // Ignore file write failure in extreme circumstances
      }
      throw new ShadowGitError(`Git command failed: git ${cmd}`, stderr);
    }
  }

  public getCurrentHead(): string {
    try {
      return this.execGit('rev-parse HEAD');
    } catch {
      // Fallback for detached or empty repositories
      return this.EMPTY_TREE_HASH;
    }
  }

  public getCurrentBranch(): string {
    try {
      return this.execGit('rev-parse --abbrev-ref HEAD');
    } catch {
      return 'detached';
    }
  }

  public getTreeHashForCommit(commitHash: string): string {
    if (!commitHash || commitHash === this.EMPTY_TREE_HASH) {
      return this.EMPTY_TREE_HASH;
    }
    try {
      return this.execGit(`rev-parse "${commitHash}^{tree}"`);
    } catch {
      return this.EMPTY_TREE_HASH;
    }
  }

  public createSnapshot(stepId: string, parentCommitHash: string): string {
    const env = { GIT_INDEX_FILE: this.shadowIdx };

    // Step A: git read-tree --empty
    this.execGit('read-tree --empty', env);

    // Step B: git add --all
    this.execGit('add --all', env);

    // Step C: git write-tree
    const treeHash = this.execGit('write-tree', env);

    // Step D: git commit-tree
    const parentArg = parentCommitHash && parentCommitHash !== this.EMPTY_TREE_HASH
      ? `-p ${parentCommitHash}`
      : '';
    const commitHash = this.execGit(`commit-tree ${treeHash} ${parentArg} -m "rewind: snapshot ${stepId}"`, env);

    // Step E: git update-ref
    this.execGit(`update-ref refs/rewind/${this.sessionId}/${stepId} ${commitHash}`);

    return commitHash;
  }

  public computeDiff(oldCommitHash: string | null, newCommitHash: string): DiffEntry[] {
    const baseCommit = oldCommitHash || this.EMPTY_TREE_HASH;
    if (baseCommit === newCommitHash) {
      return [];
    }

    try {
      const output = this.execGit(`diff-tree -r --name-status "${baseCommit}" "${newCommitHash}"`);
      if (!output) {
        return [];
      }

      const diffs: DiffEntry[] = [];
      const lines = output.split('\n').filter(Boolean);

      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length < 2) continue;

        const status = parts[0];
        const filePath = parts[1];

        if (status.startsWith('A')) {
          diffs.push({ filePath, changeType: 'ADDED', isOverlay: false });
        } else if (status.startsWith('D')) {
          diffs.push({ filePath, changeType: 'DELETED', isOverlay: false });
        } else if (status.startsWith('M')) {
          diffs.push({ filePath, changeType: 'MODIFIED', isOverlay: false });
        } else if (status.startsWith('R')) {
          const newPath = parts[2] || filePath;
          diffs.push({ filePath: parts[1], changeType: 'DELETED', isOverlay: false });
          diffs.push({ filePath: newPath, changeType: 'ADDED', isOverlay: false });
        }
      }

      return diffs;
    } catch {
      return [];
    }
  }

  public restoreTree(targetTreeHash: string, currentTreeHash?: string): void {
    const tempName = `rewind-restore-${Date.now()}-${Math.random().toString(36).substring(2)}.tmp`;
    const tempIndex = path.join('/tmp', tempName);
    const env = { GIT_INDEX_FILE: tempIndex };

    try {
      if (currentTreeHash && currentTreeHash !== this.EMPTY_TREE_HASH) {
        try {
          this.execGit(`read-tree "${currentTreeHash}"`, env);
        } catch {
          this.execGit('read-tree --empty', env);
        }
      } else {
        this.execGit('read-tree --empty', env);
      }

      this.execGit(`read-tree --reset -u "${targetTreeHash}"`, env);
    } finally {
      if (fs.existsSync(tempIndex)) {
        try {
          fs.unlinkSync(tempIndex);
        } catch {
          // Ignore
        }
      }
    }
  }

  public resetIndex(): void {
    try {
      execSync('git reset --quiet', {
        cwd: this.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // Ignore
    }
  }

  public garbageCollectIndex(): void {
    if (fs.existsSync(this.shadowIdx)) {
      try {
        fs.unlinkSync(this.shadowIdx);
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error.code !== 'ENOENT') {
          // Ignore ENOENT as specified
        }
      }
    }
  }
}
