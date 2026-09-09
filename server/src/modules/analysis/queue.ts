import type { Logger } from '../../lib/logger.js';

/**
 * In-process FIFO job queue with bounded concurrency. Jobs are analysis ids; the DB row is the
 * source of truth (runner no-ops unless the row is QUEUED), so duplicates and restarts are safe.
 */
export class AnalysisQueue {
  private readonly pending: string[] = [];
  private readonly queued = new Set<string>();
  private running = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly runner: (analysisId: string) => Promise<void>,
    private readonly logger: Logger,
  ) {}

  enqueue(analysisId: string): void {
    if (this.queued.has(analysisId)) return;
    this.queued.add(analysisId);
    this.pending.push(analysisId);
    this.pump();
  }

  get size(): number {
    return this.pending.length + this.running;
  }

  /** Resolves once no job is pending or running (tests, graceful shutdown). */
  onIdle(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private pump(): void {
    while (this.running < Math.max(1, this.concurrency) && this.pending.length) {
      const id = this.pending.shift()!;
      this.running++;
      void this.runner(id)
        .catch((err: unknown) => this.logger.error({ err, analysisId: id }, 'analysis job crashed'))
        .finally(() => {
          this.running--;
          this.queued.delete(id);
          if (this.size === 0) {
            const resolvers = this.idleResolvers;
            this.idleResolvers = [];
            for (const r of resolvers) r();
          }
          this.pump();
        });
    }
  }
}
