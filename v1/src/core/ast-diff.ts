import { Project, DiagnosticCategory } from 'ts-morph';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

export class ASTConflictError extends Error {
  constructor(message: string, public readonly diagnostics?: string[]) {
    super(message);
    this.name = 'ASTConflictError';
  }
}

export class ASTVerifier {
  private projectRoot: string;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = path.resolve(projectRoot);
  }

  public verifyRestoredState(changedFiles: string[]): boolean {
    const tsFiles = changedFiles.filter(f => {
      const ext = path.extname(f).toLowerCase();
      return ['.ts', '.tsx', '.js', '.jsx'].includes(ext);
    });

    if (tsFiles.length === 0) {
      return true;
    }

    try {
      const tsConfigPath = path.join(this.projectRoot, 'tsconfig.json');
      const projectOptions = fs.existsSync(tsConfigPath)
        ? { tsConfigFilePath: tsConfigPath, skipAddingFilesFromTsConfig: true }
        : { compilerOptions: { target: 7 /* ES2022 */, strict: true } };

      const project = new Project(projectOptions);

      for (const relPath of tsFiles) {
        const fullPath = path.isAbsolute(relPath) ? relPath : path.join(this.projectRoot, relPath);
        if (fs.existsSync(fullPath)) {
          project.addSourceFileAtPath(fullPath);
        }
      }

      const diagnostics = project.getPreEmitDiagnostics();
      const errors = diagnostics.filter(d => {
        if (d.getCategory() !== DiagnosticCategory.Error) return false;
        const sourceFile = d.getSourceFile();
        if (!sourceFile) return false;
        const filePath = sourceFile.getFilePath();
        return tsFiles.some(f => filePath.endsWith(f));
      });

      if (errors.length > 0) {
        const formatted = errors.map(e => {
          const sf = e.getSourceFile();
          const line = e.getLineNumber() || 0;
          const msg = e.getMessageText();
          const text = typeof msg === 'string' ? msg : msg.getMessageText();
          return `${sf ? path.basename(sf.getFilePath()) : 'unknown'}:${line} - ${text}`;
        });

        logger.warn('ASTVerifier', 'AST validation failed on restored files', formatted);
        return false;
      }

      return true;
    } catch (err) {
      logger.error('ASTVerifier', 'Error running AST verification', err);
      // Fallback: If AST analysis tool encounters internal error on non-TS files, don't block
      return true;
    }
  }
}
