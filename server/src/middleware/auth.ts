import type { RequestHandler } from 'express';
import type { AuthAdapter } from '../adapters/auth/index.js';
import type { Db } from '../lib/db.js';
import { ApiError } from '../lib/errors.js';
import { ensureProfile, type Role } from '../modules/me/profiles.repo.js';

export interface AuthedUser {
  id: string;
  role: Role;
  displayName: string;
  email: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() || null;
}

/** Verifies the Supabase JWT and loads/creates the profile. Rejects with 401 on failure. */
export function requireAuth(auth: AuthAdapter, db: Db): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = extractBearer(req.header('authorization'));
      if (!token) throw ApiError.unauthenticated('Missing bearer token');
      const identity = await auth.verifyAccessToken(token);
      if (!identity) throw ApiError.unauthenticated('Invalid or expired token');
      const profile = await ensureProfile(db, identity.userId, identity.email);
      req.user = { id: profile.id, role: profile.role, displayName: profile.display_name, email: profile.email };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Role gate; must run after requireAuth. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthenticated());
    if (!roles.includes(req.user.role)) return next(ApiError.forbiddenRole(`Requires role ${roles.join(' or ')}`));
    next();
  };
}

export function currentUser(req: { user?: AuthedUser }): AuthedUser {
  if (!req.user) throw ApiError.unauthenticated();
  return req.user;
}
