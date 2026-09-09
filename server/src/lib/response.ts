import type { Response } from 'express';

export interface Meta {
  requestId: string;
  [key: string]: unknown;
}

export function ok<T>(res: Response, data: T, status = 200, extraMeta: Record<string, unknown> = {}): void {
  res.status(status).json({ data, meta: { requestId: res.locals.requestId as string, ...extraMeta } });
}

export function created<T>(res: Response, data: T, extraMeta: Record<string, unknown> = {}): void {
  ok(res, data, 201, extraMeta);
}

export function accepted<T>(res: Response, data: T, extraMeta: Record<string, unknown> = {}): void {
  ok(res, data, 202, extraMeta);
}
