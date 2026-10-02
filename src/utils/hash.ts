import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export function hashString(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function hashFile(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function hashDirectory(dirPath: string, ignoredDirs: string[] = ['.git', 'node_modules', 'dist', '.next']): string {
  const hashes: string[] = [];

  const traverse = (currentDir: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort entries for deterministic hashing
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (ignoredDirs.includes(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(dirPath, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        traverse(fullPath);
      } else if (entry.isFile()) {
        try {
          const fileHash = hashFile(fullPath);
          hashes.push(`${relativePath}:${fileHash}`);
        } catch {
          // Ignore transient read errors
        }
      }
    }
  };

  traverse(dirPath);
  hashes.sort();
  return hashString(hashes.join('\n'));
}
