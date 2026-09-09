import { createClient } from '@supabase/supabase-js';

export interface VerifiedIdentity {
  /** Supabase auth user UUID (`sub`). */
  userId: string;
  email: string | null;
}

export interface AuthAdapter {
  /** Returns null when the token is missing, malformed, expired or has a bad signature. */
  verifyAccessToken(token: string): Promise<VerifiedIdentity | null>;
}

/**
 * Verifies Supabase access tokens server-side via auth.getUser(jwt), which checks
 * signature, expiry and issuer against the project. Never trusts a decoded payload.
 */
export class SupabaseAuthAdapter implements AuthAdapter {
  private readonly client;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async verifyAccessToken(token: string): Promise<VerifiedIdentity | null> {
    const { data, error } = await this.client.auth.getUser(token);
    if (error || !data.user) return null;
    return { userId: data.user.id, email: data.user.email ?? null };
  }
}

/** Test/dev adapter: maps opaque tokens to identities. */
export class StaticAuthAdapter implements AuthAdapter {
  constructor(private readonly tokens: Map<string, VerifiedIdentity>) {}

  async verifyAccessToken(token: string): Promise<VerifiedIdentity | null> {
    return this.tokens.get(token) ?? null;
  }
}
