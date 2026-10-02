import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { OverlayFile, OverlayManifest, DiffEntry } from '../types';
import { logger } from '../utils/logger';

export class OverlayCAS {
  public static readonly MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
  public static readonly WHITELIST = [
    '.env',
    '.env.local',
    '.env.development',
    '.env.production',
    '.env.test',
    'schema.prisma',
    'local.db',
    'dev.sqlite3',
  ];

  private projectRoot: string;
  private casDir: string;
  private manifestDir: string;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = path.resolve(projectRoot);
    this.casDir = path.join(this.projectRoot, '.git', 'rewind', 'overlay', 'blobs');
    this.manifestDir = path.join(this.projectRoot, '.git', 'rewind', 'overlay', 'manifests');
    this.init();
  }

  public init(): void {
    if (!fs.existsSync(this.casDir)) {
      fs.mkdirSync(this.casDir, { recursive: true });
    }
    if (!fs.existsSync(this.manifestDir)) {
      fs.mkdirSync(this.manifestDir, { recursive: true });
    }
  }

  public isWhitelisted(filePath: string): boolean {
    const base = path.basename(filePath);
    return OverlayCAS.WHITELIST.includes(base) || base.startsWith('.env');
  }

  public storeFile(filePath: string): OverlayFile | null {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
    const relativePath = path.relative(this.projectRoot, fullPath).replace(/\\/g, '/');

    if (!fs.existsSync(fullPath)) {
      return null;
    }

    if (!this.isWhitelisted(relativePath)) {
      return null;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(fullPath);
    } catch {
      return null;
    }

    if (stats.size > OverlayCAS.MAX_FILE_SIZE) {
      logger.warn('OverlayCAS', `File exceeds 50MB ceiling: ${relativePath} (${stats.size} bytes)`);
      return null;
    }

    try {
      const fileBuffer = fs.readFileSync(fullPath);
      const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      const prefixDir = path.join(this.casDir, hash.substring(0, 2));
      const targetPath = path.join(prefixDir, hash);

      if (!fs.existsSync(prefixDir)) {
        fs.mkdirSync(prefixDir, { recursive: true });
      }

      if (!fs.existsSync(targetPath)) {
        fs.copyFileSync(fullPath, targetPath);
      }

      const permissions = '0' + (stats.mode & 0o777).toString(8);

      return {
        relativePath,
        sha256: hash,
        permissions,
        sizeBytes: stats.size,
      };
    } catch (err: unknown) {
      const error = err as { code?: string; message?: string };
      // Edge case defense: catch EACCES on read/copy and continue without crashing
      if (error.code === 'EACCES') {
        logger.warn('OverlayCAS', `Permission denied accessing ${relativePath}, skipping.`);
        return null;
      }
      logger.error('OverlayCAS', `Failed to store file ${relativePath}`, err);
      return null;
    }
  }

  public scanWhitelistedFiles(dir: string = this.projectRoot): string[] {
    const matches: string[] = [];

    const traverse = (currentDir: string): void => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
          continue;
        }

        const fullPath = path.join(currentDir, entry.name);
        const rel = path.relative(this.projectRoot, fullPath).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          traverse(fullPath);
        } else if (entry.isFile() && this.isWhitelisted(rel)) {
          matches.push(rel);
        }
      }
    };

    traverse(dir);
    return matches;
  }

  public generateManifest(stepId: string): string | null {
    this.init();
    const candidateFiles = this.scanWhitelistedFiles();
    const storedFiles: OverlayFile[] = [];

    for (const relPath of candidateFiles) {
      const stored = this.storeFile(relPath);
      if (stored) {
        storedFiles.push(stored);
      }
    }

    if (storedFiles.length === 0) {
      return null;
    }

    const manifest: OverlayManifest = {
      stepId,
      timestamp: Date.now(),
      files: storedFiles,
    };

    const manifestJson = JSON.stringify(manifest, null, 2);
    const manifestHash = crypto.createHash('sha256').update(manifestJson).digest('hex');
    const manifestPath = path.join(this.manifestDir, `${manifestHash}.json`);

    fs.writeFileSync(manifestPath, manifestJson, 'utf8');
    return manifestHash;
  }

  public getManifest(manifestHash: string | null): OverlayManifest | null {
    if (!manifestHash) return null;
    const manifestPath = path.join(this.manifestDir, `${manifestHash}.json`);
    if (!fs.existsSync(manifestPath)) return null;

    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as OverlayManifest;
    } catch {
      return null;
    }
  }

  public computeOverlayDiff(oldManifestHash: string | null, newManifestHash: string | null): DiffEntry[] {
    const diffs: DiffEntry[] = [];
    const oldManifest = this.getManifest(oldManifestHash);
    const newManifest = this.getManifest(newManifestHash);

    const oldMap = new Map<string, string>();
    const newMap = new Map<string, string>();

    if (oldManifest) {
      for (const f of oldManifest.files) oldMap.set(f.relativePath, f.sha256);
    }
    if (newManifest) {
      for (const f of newManifest.files) newMap.set(f.relativePath, f.sha256);
    }

    for (const [relPath, hash] of newMap.entries()) {
      const oldHash = oldMap.get(relPath);
      if (!oldHash) {
        diffs.push({ filePath: relPath, changeType: 'ADDED', isOverlay: true });
      } else if (oldHash !== hash) {
        diffs.push({ filePath: relPath, changeType: 'MODIFIED', isOverlay: true });
      }
    }

    for (const [relPath] of oldMap.entries()) {
      if (!newMap.has(relPath)) {
        diffs.push({ filePath: relPath, changeType: 'DELETED', isOverlay: true });
      }
    }

    return diffs;
  }

  public restoreManifest(manifestHash: string | null): string[] {
    const restoredFiles: string[] = [];
    const targetManifest = this.getManifest(manifestHash);
    const targetPaths = new Set<string>();

    if (targetManifest) {
      for (const file of targetManifest.files) {
        targetPaths.add(file.relativePath);
        const blobPath = path.join(this.casDir, file.sha256.substring(0, 2), file.sha256);
        const destPath = path.join(this.projectRoot, file.relativePath);

        if (fs.existsSync(blobPath)) {
          const parentDir = path.dirname(destPath);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }

          try {
            fs.copyFileSync(blobPath, destPath);
            const mode = parseInt(file.permissions, 8);
            fs.chmodSync(destPath, mode);
            restoredFiles.push(file.relativePath);
          } catch (err) {
            logger.warn('OverlayCAS', `Failed to restore file ${file.relativePath}`, err);
          }
        }
      }
    }

    // Delete any whitelisted files currently on disk that did not exist in target manifest
    const currentFiles = this.scanWhitelistedFiles();
    for (const relPath of currentFiles) {
      if (!targetPaths.has(relPath)) {
        const fullPath = path.join(this.projectRoot, relPath);
        if (fs.existsSync(fullPath)) {
          try {
            fs.unlinkSync(fullPath);
            restoredFiles.push(relPath);
          } catch (err) {
            logger.warn('OverlayCAS', `Failed to delete extraneous overlay file ${relPath}`, err);
          }
        }
      }
    }

    return restoredFiles;
  }
}
