import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export function scaffoldMockProject(targetDir: string, fileCount: number = 500): void {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 1. Base config files
  fs.writeFileSync(
    path.join(targetDir, 'package.json'),
    JSON.stringify({ name: 'mock-fuzz-app', version: '1.0.0', private: true }, null, 2),
    'utf8'
  );

  fs.writeFileSync(
    path.join(targetDir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS', strict: true } }, null, 2),
    'utf8'
  );

  fs.writeFileSync(path.join(targetDir, '.env'), 'DATABASE_URL=postgres://user:pass@localhost:5432/db\nSECRET=rewind_secret_123\n', 'utf8');
  fs.writeFileSync(path.join(targetDir, '.env.local'), 'LOCAL_OVERRIDE=true\n', 'utf8');

  // 2. node_modules (should be ignored by shadow git and CAS)
  const nodeModulesDir = path.join(targetDir, 'node_modules', 'mock-package');
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  fs.writeFileSync(path.join(nodeModulesDir, 'index.js'), 'module.exports = { isMock: true };\n', 'utf8');

  // 3. Create nested source directories
  const subdirs = [
    'src/components/ui',
    'src/components/forms',
    'src/hooks',
    'src/utils/math',
    'src/utils/string',
    'src/services/api',
    'src/pages/dashboard',
    'src/pages/settings',
    'src/types',
  ];

  for (const sub of subdirs) {
    fs.mkdirSync(path.join(targetDir, sub), { recursive: true });
  }

  // 4. Generate up to `fileCount` mock source files
  // We already have ~5 files, so generate the rest
  const remaining = Math.max(10, fileCount - 10);
  for (let i = 0; i < remaining; i++) {
    const dir = subdirs[i % subdirs.length];
    const fileName = `Module_${i}.ts`;
    const filePath = path.join(targetDir, dir, fileName);
    const content = `// Auto-generated mock file ${i}
export interface Config_${i} {
  id: number;
  name: string;
  active: boolean;
}

export function compute_${i}(val: number): number {
  return val * ${i} + 1;
}
`;
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

export async function simulateRogueAgent(
  targetDir: string,
  steps: number,
  snapshotTrigger: () => Promise<void> | void
): Promise<void> {
  const tsFiles: string[] = [];
  const findTsFiles = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        findTsFiles(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        tsFiles.push(full);
      }
    }
  };
  findTsFiles(targetDir);

  const actions = ['APPEND_GARBAGE', 'DELETE_NESTED', 'OVERWRITE_ENV', 'CREATE_BATCH', 'GIT_ADD'];

  for (let step = 0; step < steps; step++) {
    const action = actions[step % actions.length];

    switch (action) {
      case 'APPEND_GARBAGE': {
        // Action A: Append garbage text to a .ts file
        if (tsFiles.length > 0) {
          const targetIndex = (step * 7) % tsFiles.length;
          const targetFile = tsFiles[targetIndex];
          if (fs.existsSync(targetFile)) {
            fs.appendFileSync(targetFile, `\n// Rogue Agent Mutation Step ${step}: garbage_${Math.random()}\n`, 'utf8');
          }
        }
        break;
      }

      case 'DELETE_NESTED': {
        // Action B: Delete a deeply nested file
        if (tsFiles.length > 5) {
          const deleteIndex = (step * 13) % tsFiles.length;
          const toDelete = tsFiles[deleteIndex];
          if (fs.existsSync(toDelete)) {
            try {
              fs.unlinkSync(toDelete);
            } catch {
              // Ignore
            }
          }
        }
        break;
      }

      case 'OVERWRITE_ENV': {
        // Action C: Overwrite .env with a massive string
        const envPath = path.join(targetDir, '.env');
        const massivePayload = `DATABASE_URL=postgres://rogue:hacked@localhost:5432/corrupted\n` +
          '# CORRUPTED_PAYLOAD_START\n' +
          'A'.repeat(5000) +
          `\n# STEP_${step}\n`;
        fs.writeFileSync(envPath, massivePayload, 'utf8');
        break;
      }

      case 'CREATE_BATCH': {
        // Action D: Create new files in a new directory
        const batchDir = path.join(targetDir, `src/generated_chaos_${step}`);
        if (!fs.existsSync(batchDir)) {
          fs.mkdirSync(batchDir, { recursive: true });
        }
        for (let j = 0; j < 5; j++) {
          const newFile = path.join(batchDir, `rogue_file_${j}.ts`);
          fs.writeFileSync(newFile, `export const rogue_${step}_${j} = ${step * 100 + j};\n`, 'utf8');
          tsFiles.push(newFile);
        }
        break;
      }

      case 'GIT_ADD': {
        // Action E: Run git add . to test engine resilience against index mutation
        try {
          execSync('git add .', { cwd: targetDir, stdio: 'pipe' });
        } catch {
          // Ignore
        }
        break;
      }
    }

    // Trigger snapshot after every chaos action
    await snapshotTrigger();
  }
}
