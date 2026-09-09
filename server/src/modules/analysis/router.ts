import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';
import { accepted, ok } from '../../lib/response.js';
import { currentUser, requireRole } from '../../middleware/auth.js';
import { loadSubmissionForViewer } from '../submissions/router.js';
import { findAnalysisBySubmission } from './repo.js';
import { requestAnalysis, toAnalysisDto, type AnalysisDeps } from './service.js';

export function analysisRouter(deps: AnalysisDeps): Router {
  const r = Router();
  const { db } = deps;

  const start = (retryOnly: boolean): RequestHandler => async (req, res, next) => {
    try {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const { submission, access } = await loadSubmissionForViewer(db, id, user);
      if (access !== 'WITNESS') throw ApiError.notFound('Submission not found');
      const { analysis, existing } = await requestAnalysis(deps, submission, user, { retryOnly });
      accepted(res, { analysisId: analysis.id, status: analysis.status, existing });
    } catch (err) {
      next(err);
    }
  };

  r.post('/submissions/:id/analyze', requireRole('WITNESS'), start(false));
  r.post('/submissions/:id/analyze/retry', requireRole('WITNESS'), start(true));

  r.get('/submissions/:id/analysis', async (req, res, next) => {
    try {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const { submission } = await loadSubmissionForViewer(db, id, user);
      const analysis = await findAnalysisBySubmission(db, submission.id);
      if (!analysis) throw ApiError.notFound('Analysis has not been requested for this submission');
      ok(res, toAnalysisDto(analysis));
    } catch (err) {
      next(err);
    }
  });

  return r;
}
