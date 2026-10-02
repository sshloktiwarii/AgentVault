import * as http from 'http';
import { logger } from './logger';

export interface TelemetryMetrics {
  snapshot_latency_ms: number[];
  files_hashed_count: number;
  ipc_roundtrip_ms: number[];
  sqlite_insert_ms: number[];
}

export class TelemetryService {
  private static instance: TelemetryService;
  private metrics: TelemetryMetrics = {
    snapshot_latency_ms: [],
    files_hashed_count: 0,
    ipc_roundtrip_ms: [],
    sqlite_insert_ms: [],
  };
  private server: http.Server | null = null;

  private constructor() {}

  public static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService();
    }
    return TelemetryService.instance;
  }

  public recordSnapshotLatency(startNano: bigint): void {
    const elapsedMs = Number(process.hrtime.bigint() - startNano) / 1_000_000;
    this.metrics.snapshot_latency_ms.push(elapsedMs);
  }

  public recordFilesHashed(count: number): void {
    this.metrics.files_hashed_count += count;
  }

  public recordIpcRoundtrip(startNano: bigint): void {
    const elapsedMs = Number(process.hrtime.bigint() - startNano) / 1_000_000;
    this.metrics.ipc_roundtrip_ms.push(elapsedMs);
  }

  public recordSqliteInsert(startNano: bigint): void {
    const elapsedMs = Number(process.hrtime.bigint() - startNano) / 1_000_000;
    this.metrics.sqlite_insert_ms.push(elapsedMs);
  }

  public generatePrometheusText(sessionId: string = 'default'): string {
    const avgSnapshot = this.metrics.snapshot_latency_ms.length > 0
      ? this.metrics.snapshot_latency_ms.reduce((a, b) => a + b, 0) / this.metrics.snapshot_latency_ms.length
      : 0;

    return [
      '# HELP rewind_snapshot_latency_ms The time taken to execute shadow git and CAS',
      '# TYPE rewind_snapshot_latency_ms gauge',
      `rewind_snapshot_latency_ms{session="${sessionId}"} ${avgSnapshot.toFixed(2)}`,
      '',
      '# HELP rewind_files_hashed_total Total number of files processed by CAS',
      '# TYPE rewind_files_hashed_total counter',
      `rewind_files_hashed_total{session="${sessionId}"} ${this.metrics.files_hashed_count}`,
    ].join('\n') + '\n';
  }

  public startPrometheusServer(port: number = 49999, sessionId: string = 'default'): void {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(this.generatePrometheusText(sessionId));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.server.listen(port, '127.0.0.1', () => {
      logger.info('Telemetry', `Prometheus metrics exporter running on http://127.0.0.1:${port}/metrics`);
    });
  }

  public stopPrometheusServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

export const telemetry = TelemetryService.getInstance();
