export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN_ROLE'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'ALREADY_EXISTS'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'VIDEO_UNANALYZABLE'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN_ROLE: 403,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  ALREADY_EXISTS: 409,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VIDEO_UNANALYZABLE: 422,
  RATE_LIMITED: 429,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export interface ApiErrorOptions {
  fieldErrors?: Record<string, string>;
  retryable?: boolean;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors: Record<string, string> | undefined;
  readonly retryable: boolean;

  constructor(
    public readonly code: ErrorCode,
    message: string,
    opts: ApiErrorOptions = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ApiError';
    this.status = STATUS[code];
    this.fieldErrors = opts.fieldErrors;
    this.retryable = opts.retryable ?? (code === 'PROVIDER_UNAVAILABLE' || code === 'RATE_LIMITED');
  }

  static validation(message: string, fieldErrors?: Record<string, string>): ApiError {
    return new ApiError('VALIDATION_ERROR', message, fieldErrors ? { fieldErrors } : {});
  }
  static unauthenticated(message = 'Authentication required'): ApiError {
    return new ApiError('UNAUTHENTICATED', message);
  }
  static forbiddenRole(message = 'Your role cannot perform this action'): ApiError {
    return new ApiError('FORBIDDEN_ROLE', message);
  }
  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError('NOT_FOUND', message);
  }
  static invalidState(message: string): ApiError {
    return new ApiError('INVALID_STATE', message);
  }
}
