import * as fs from 'fs';
import * as path from 'path';

export interface LogEntry {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  context: string;
  message: string;
  data?: unknown;
}

export class Logger {
  private logFilePath: string;

  constructor(projectRoot: string = process.cwd()) {
    const rewindDir = path.join(projectRoot, '.git', 'rewind');
    if (!fs.existsSync(rewindDir)) {
      try {
        fs.mkdirSync(rewindDir, { recursive: true });
      } catch {
        // Fallback to current directory
      }
    }
    this.logFilePath = path.join(rewindDir, 'rewind.log');
  }

  private write(level: LogEntry['level'], context: string, message: string, data?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      context,
      message,
      data,
    };

    const line = JSON.stringify(entry) + '\n';
    try {
      fs.appendFileSync(this.logFilePath, line, 'utf8');
    } catch {
      // Ignore disk logging error
    }
  }

  public info(context: string, message: string, data?: unknown): void {
    this.write('INFO', context, message, data);
  }

  public warn(context: string, message: string, data?: unknown): void {
    this.write('WARN', context, message, data);
  }

  public error(context: string, message: string, error?: unknown): void {
    const serialized = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : error;
    this.write('ERROR', context, message, serialized);
  }

  public debug(context: string, message: string, data?: unknown): void {
    if (process.env.DEBUG === 'rewind:*' || process.env.DEBUG === 'true') {
      this.write('DEBUG', context, message, data);
    }
  }
}

export const logger = new Logger();
