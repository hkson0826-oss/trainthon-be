import { TwelveLabsClient } from '../../adapters/twelvelabs/client.js';
import type { StorageAdapter } from '../../adapters/storage/index.js';
import type { Env } from '../../config/env.js';
import type { Db, Queryable } from '../../lib/db.js';
import type { Logger } from '../../lib/logger.js';
import { InMemoryPrerecordedStore, loadPrerecordedFixtures, type PrerecordedStore } from './prerecorded.js';
import { FakeAnalysisProvider, LiveTwelveLabsProvider, type AnalysisProvider } from './provider.js';
import { AnalysisQueue } from './queue.js';
import { findAnalysisBySubmission } from './repo.js';
import { recoverQueuedAnalyses, runAnalysis, sweepStaleAnalyses, toAnalysisDto, type AnalysisDeps } from './service.js';

export interface AnalysisRuntime {
  deps: AnalysisDeps;
  queue: AnalysisQueue;
  provider: AnalysisProvider;
  prerecorded: PrerecordedStore;
  /** Summary for submission DTOs (`analysis` field). */
  analysisSummary: (q: Queryable, submissionId: string) => Promise<ReturnType<typeof toAnalysisDto> | null>;
  sweep: () => Promise<string[]>;
  recover: () => Promise<number>;
}

export interface AnalysisRuntimeOptions {
  env: Env;
  db: Db;
  storage: StorageAdapter;
  logger: Logger;
  /** Override for tests; defaults to Live (AI_MODE=live) or Fake (AI_MODE=fake). */
  provider?: AnalysisProvider;
  prerecorded?: PrerecordedStore;
  fetchImpl?: typeof fetch;
}

export async function loadPrerecordedStore(dir: string, logger: Logger): Promise<PrerecordedStore> {
  const report = await loadPrerecordedFixtures(dir);
  for (const s of report.skipped) logger.warn({ file: s.file, reason: s.reason }, 'prerecorded fixture skipped');
  if (report.loaded.length) logger.info({ count: report.loaded.length, dir }, 'prerecorded fixtures loaded');
  return new InMemoryPrerecordedStore(report.loaded);
}

export function createAnalysisRuntime(opts: AnalysisRuntimeOptions): AnalysisRuntime {
  const { env, db, storage, logger } = opts;
  const prerecorded = opts.prerecorded ?? new InMemoryPrerecordedStore();
  const provider =
    opts.provider ??
    (env.AI_MODE === 'fake'
      ? new FakeAnalysisProvider(prerecorded, env)
      : new LiveTwelveLabsProvider(new TwelveLabsClient({ apiKey: env.TWELVELABS_API_KEY, baseUrl: env.TWELVELABS_BASE_URL, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }), env));

  // deps.enqueue is bound after the queue exists (queue runner needs deps).
  const deps: AnalysisDeps = { env, db, storage, provider, prerecorded, logger, enqueue: () => undefined };
  const queue = new AnalysisQueue(env.ANALYSIS_QUEUE_CONCURRENCY, (id) => runAnalysis(deps, id), logger);
  deps.enqueue = (id) => queue.enqueue(id);

  return {
    deps,
    queue,
    provider,
    prerecorded,
    analysisSummary: async (q, submissionId) => {
      const a = await findAnalysisBySubmission(q, submissionId);
      return a ? toAnalysisDto(a) : null;
    },
    sweep: () => sweepStaleAnalyses(deps),
    recover: () => recoverQueuedAnalyses(deps),
  };
}
