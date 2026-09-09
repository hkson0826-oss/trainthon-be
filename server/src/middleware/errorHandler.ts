import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

export function zodFieldErrors(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(ApiError.notFound('Route not found'));
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    const requestId = res.locals.requestId as string | undefined;
    let apiErr: ApiError;
    if (err instanceof ApiError) {
      apiErr = err;
    } else if (err instanceof ZodError) {
      apiErr = ApiError.validation('Request validation failed', zodFieldErrors(err));
    } else if (isBodyParserError(err)) {
      apiErr =
        err.type === 'entity.too.large'
          ? new ApiError('FILE_TOO_LARGE', 'Request body too large')
          : ApiError.validation('Malformed request body');
    } else {
      logger.error({ err, requestId }, 'unhandled error');
      apiErr = new ApiError('INTERNAL_ERROR', 'Internal server error', { retryable: true });
    }
    if (apiErr.status >= 500) logger.error({ requestId, code: apiErr.code }, apiErr.message);
    res.status(apiErr.status).json({
      error: {
        code: apiErr.code,
        message: apiErr.message,
        ...(apiErr.fieldErrors ? { fieldErrors: apiErr.fieldErrors } : {}),
        retryable: apiErr.retryable,
      },
      meta: { requestId },
    });
  };
}

function isBodyParserError(err: unknown): err is { type: string; status?: number } {
  return typeof err === 'object' && err !== null && 'type' in err && typeof (err as { type: unknown }).type === 'string';
}
