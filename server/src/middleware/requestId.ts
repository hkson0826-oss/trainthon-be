import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const HEADER = 'x-request-id';
const SAFE = /^[A-Za-z0-9._-]{8,128}$/;

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header(HEADER);
  const id = incoming && SAFE.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = id;
  res.setHeader(HEADER, id);
  next();
};
