import type { User } from '@supabase/supabase-js';
import { supabaseAdmin, supabaseAuth } from '../config/supabase';
import { env } from '../config/env';
import { adminUserRepo } from '../repositories';
import { IAdminUser } from '../interfaces/common';
import { ApiError } from '../utils/ApiError';
import { logger } from '../config/logger';
import { Role, ROLES, ALL_ROLES } from '../constants';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatar?: string;
  lastLoginAt?: Date | string;
}

/** Passwords are stored by Supabase Auth; this mirrors the old schema minimum. */
const MIN_PASSWORD_LENGTH = 8;

/** An admin-panel URL for a link in an email or the Google return trip. */
function adminUrl(path: string): string {
  if (!env.adminAppUrl) {
    throw ApiError.serviceUnavailable('Email and Google sign-in are not configured (ADMIN_APP_URL)');
  }
  return `${env.adminAppUrl}${path}`;
}

/** Same wording whichever reason a link or code was refused. */
const EXPIRED_CODE = 'That code is invalid or has expired';
const EXPIRED_LINK = 'This link is invalid or has expired. Request a new one.';
const NO_ACCESS = 'This account does not have access to the GloryTecks admin panel.';

/**
 * True when an access token came from a password-recovery email (link or
 * code). Only such a token may set a new password without the current one —
 * an ordinary session token must go through change-password instead.
 */
function isRecoveryToken(accessToken: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      amr?: { method?: string }[];
      iat?: number;
    };
    const fresh = typeof payload.iat === 'number' && Date.now() / 1000 - payload.iat < 60 * 60;
    return fresh && (payload.amr ?? []).some((a) => a.method === 'recovery');
  } catch {
    return false;
  }
}

function toPublicUser(user: IAdminUser): PublicUser {
  return {
    id: String(user.id),
    name: user.name,
    email: user.email,
    role: user.role,
    avatar: user.avatar,
    lastLoginAt: user.lastLoginAt,
  };
}

/**
 * Authentication service — Supabase Auth behind the existing API contract.
 *
 * WHAT CHANGED
 *   Tokens are now issued and verified by Supabase Auth instead of being
 *   signed by this process. `accessToken` in the login/refresh response is a
 *   Supabase access token and the refresh cookie holds a Supabase refresh
 *   token.
 *
 * WHAT DID NOT CHANGE
 *   Route paths, request bodies, response envelopes, status codes, error
 *   messages, and the httpOnly refresh cookie. The admin frontend still posts
 *   { email, password } to /auth/login, reads `data.accessToken`, and sends
 *   `Authorization: Bearer <token>` — so it needs no changes at all.
 *
 * AUTHORIZATION IS NOT DELEGATED
 *   Supabase Auth answers "who is this?". It never answers "may they do this?".
 *   Every method below re-reads the `admin_users` profile, and a Supabase
 *   identity with no profile row — or an inactive one — is rejected. That is
 *   what makes self-signup useless even if it were somehow enabled on the
 *   project: an account with no profile has no access to anything.
 */
export const authService = {
  /** Look up the application profile for a Supabase identity. */
  async getProfileById(userId: string): Promise<IAdminUser | null> {
    return adminUserRepo.findById(userId);
  },

  async login(email: string, password: string): Promise<{ user: PublicUser; tokens: AuthTokens }> {
    const normalisedEmail = email.toLowerCase().trim();

    const { data, error } = await supabaseAuth.auth.signInWithPassword({
      email: normalisedEmail,
      password,
    });

    // Supabase distinguishes "wrong password" from "no such user"; the previous
    // implementation deliberately did not, and neither do we.
    if (error || !data.session || !data.user) {
      throw ApiError.unauthorized('Invalid email or password');
    }

    const profile = await adminUserRepo.findById(data.user.id);
    if (!profile) {
      // A Supabase identity with no admin profile is not a user of this app.
      // Revoke the session it was just given, by that session's own token.
      // `supabaseAuth.auth.signOut()` signs out whichever session the shared
      // client stored last: on a busy instance that can be an administrator
      // whose sign-in finished during the profile lookup above, while this
      // session stayed live.
      await supabaseAdmin.auth.admin.signOut(data.session.access_token, 'global').catch(() => undefined);
      throw ApiError.unauthorized('Invalid email or password');
    }
    if (!profile.isActive) {
      throw ApiError.forbidden('Account is disabled');
    }

    const updated = await adminUserRepo.updateRawById(profile.id, {
      last_login_at: new Date().toISOString(),
    });

    return {
      user: toPublicUser(updated ?? profile),
      tokens: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
      },
    };
  },

  /**
   * Exchange a refresh token for a new session.
   * Supabase rotates the refresh token on every use and invalidates the old
   * one, which is the same reuse protection the previous hashed-token scheme
   * provided — without this service storing anything.
   */
  async refresh(refreshToken: string): Promise<{ user: PublicUser; tokens: AuthTokens }> {
    if (!refreshToken) throw ApiError.unauthorized('No refresh token provided');

    const { data, error } = await supabaseAuth.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.session || !data.user) {
      throw ApiError.unauthorized('Invalid refresh token');
    }

    const profile = await adminUserRepo.findById(data.user.id);
    if (!profile || !profile.isActive) {
      throw ApiError.unauthorized('Session expired, please log in again');
    }

    return {
      user: toPublicUser(profile),
      tokens: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
      },
    };
  },

  /**
   * Revoke the caller's sessions. The old implementation cleared the stored
   * refresh-token hash; the equivalent here is asking Supabase to sign the
   * user out. Failures are logged and swallowed: the client clears its cookie
   * regardless, and logout must never return an error to the user.
   */
  async logout(accessToken?: string): Promise<void> {
    if (!accessToken) return;
    try {
      await supabaseAdmin.auth.admin.signOut(accessToken, 'global');
    } catch (err) {
      logger.warn(`Logout: could not revoke Supabase session — ${(err as Error).message}`);
    }
  },

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await adminUserRepo.findById(userId);
    if (!user) throw ApiError.notFound('User not found');
    return toPublicUser(user);
  },

  async updateProfile(
    userId: string,
    data: { name?: string; avatar?: string },
  ): Promise<PublicUser> {
    const existing = await adminUserRepo.findById(userId);
    if (!existing) throw ApiError.notFound('User not found');

    const payload: Record<string, unknown> = {};
    if (data.name !== undefined) payload.name = data.name;
    if (data.avatar !== undefined) payload.avatar = data.avatar;

    const updated = await adminUserRepo.updateById(userId, payload);
    return toPublicUser(updated ?? existing);
  },

  /**
   * Change the caller's password.
   * The current password is verified by attempting a real sign-in, which is
   * the Supabase equivalent of the old bcrypt compare — this service never
   * sees or stores a password hash.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    accessToken?: string,
  ): Promise<void> {
    const user = await adminUserRepo.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const { error: signInError } = await supabaseAuth.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });
    if (signInError) throw ApiError.badRequest('Current password is incorrect');

    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: newPassword,
    });
    if (error) {
      // The provider's wording is written for its own API, not ours: it can
      // name internal policies and endpoints. The one thing a caller can act
      // on is the password rule, which we state ourselves.
      logger.warn('Password update rejected by the identity provider', {
        userId,
        providerMessage: error.message,
      });
      throw ApiError.badRequest(
        `Password could not be updated. It must be at least ${MIN_PASSWORD_LENGTH} characters and not previously used.`,
      );
    }

    // Previously the stored refresh hash was cleared to force re-login
    // everywhere; the equivalent is revoking all outstanding sessions.
    await this.logout(accessToken);
  },

  /* ── Email code, Google and password reset ──────────────────────────────── */
  //
  // Each of these ends in openSession(): the same admin_users check as the
  // password login, so a code, a link or a Google account only ever opens the
  // panel for someone who already has an active admin profile. Nothing here
  // creates an account.

  /** The active admin profile for an email address, or null. */
  async activeAdminByEmail(email: string): Promise<IAdminUser | null> {
    const profile = await adminUserRepo.findOne({ email: email.toLowerCase().trim() });
    return profile && profile.isActive ? profile : null;
  },

  /**
   * Email a one-time sign-in code (and link) to an active administrator.
   * Anyone else gets the same reply and no email, so the endpoint cannot be
   * used to find out which addresses are admins.
   */
  async requestLoginCode(email: string): Promise<void> {
    const profile = await this.activeAdminByEmail(email);
    if (!profile) return;
    const { error } = await supabaseAuth.auth.signInWithOtp({
      email: profile.email,
      options: { shouldCreateUser: false, emailRedirectTo: adminUrl('/auth/callback') },
    });
    if (error) {
      logger.warn('Sign-in code could not be sent', { userId: profile.id, status: error.status, providerMessage: error.message });
      if (error.status === 429) throw ApiError.tooMany('Too many emails requested. Wait a minute and try again.');
    }
  },

  async verifyLoginCode(email: string, code: string): Promise<{ user: PublicUser; tokens: AuthTokens }> {
    const { data, error } = await supabaseAuth.auth.verifyOtp({
      email: email.toLowerCase().trim(),
      token: code,
      type: 'email',
    });
    if (error || !data.session || !data.user) throw ApiError.unauthorized(EXPIRED_CODE);
    return this.openSession(data.session.access_token, data.session.refresh_token, data.user.id);
  },

  /**
   * The Google sign-in address. Checked against the project's auth settings
   * first: with the provider off, Supabase would show the visitor a bare JSON
   * error page instead of returning them to the panel.
   */
  async googleSignInUrl(): Promise<string> {
    const redirectTo = adminUrl('/auth/callback');
    const settings = await fetch(`${env.supabase.url}/auth/v1/settings`, { headers: { apikey: env.supabase.anonKey } })
      .then((r) => (r.ok ? (r.json() as Promise<{ external?: Record<string, boolean> }>) : null))
      .catch(() => null);
    if (!settings?.external?.google) {
      throw ApiError.serviceUnavailable('Google sign-in is not set up yet. Use your email and password, or an email code.');
    }
    const { data, error } = await supabaseAuth.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } },
    });
    if (error || !data?.url) throw ApiError.serviceUnavailable('Google sign-in is not available right now.');
    return data.url;
  },

  /**
   * Turn the session a Google sign-in or an email link hands back into a
   * panel session. The tokens travelled in a URL, so they are rotated before
   * use, and the identity must have an active admin profile.
   */
  async exchangeSession(accessToken: string, refreshToken: string): Promise<{ user: PublicUser; tokens: AuthTokens }> {
    const { data: who, error } = await supabaseAdmin.auth.getUser(accessToken);
    if (error || !who.user) throw ApiError.unauthorized(EXPIRED_LINK);

    const profile = await adminUserRepo.findById(who.user.id);
    if (!profile) {
      await this.forgetStranger(who.user, accessToken);
      throw ApiError.unauthorized(NO_ACCESS);
    }

    const { data, error: refreshError } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });
    if (refreshError || !data.session || data.user?.id !== who.user.id) throw ApiError.unauthorized(EXPIRED_LINK);
    return this.openSession(data.session.access_token, data.session.refresh_token, who.user.id);
  },

  /**
   * A Google sign-in by someone who is not an admin still leaves a Supabase
   * identity behind (Supabase creates it before we see it). Revoke it, and
   * delete it when it was created moments ago — an identity with no admin
   * profile has no use in this project.
   */
  async forgetStranger(user: User, accessToken: string): Promise<void> {
    await supabaseAdmin.auth.admin.signOut(accessToken, 'global').catch(() => undefined);
    const created = Date.parse(user.created_at ?? '');
    if (Number.isFinite(created) && Date.now() - created < 15 * 60 * 1000) {
      const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id);
      logger.info('Removed a sign-in identity with no admin profile', { userId: user.id, removed: !error });
    }
  },

  /** The tail every sign-in method shares: admin profile, active, last-login stamp. */
  async openSession(accessToken: string, refreshToken: string, userId: string): Promise<{ user: PublicUser; tokens: AuthTokens }> {
    const profile = await adminUserRepo.findById(userId);
    if (!profile) {
      await supabaseAdmin.auth.admin.signOut(accessToken, 'global').catch(() => undefined);
      throw ApiError.unauthorized(NO_ACCESS);
    }
    if (!profile.isActive) throw ApiError.forbidden('Account is disabled');
    const updated = await adminUserRepo.updateRawById(profile.id, { last_login_at: new Date().toISOString() });
    return { user: toPublicUser(updated ?? profile), tokens: { accessToken, refreshToken } };
  },

  /** Email a password-reset link (and code) to an active administrator; same reply for anyone else. */
  async requestPasswordReset(email: string): Promise<void> {
    const profile = await this.activeAdminByEmail(email);
    if (!profile) return;
    const { error } = await supabaseAuth.auth.resetPasswordForEmail(profile.email, {
      redirectTo: adminUrl('/reset-password'),
    });
    if (error) {
      logger.warn('Password reset email could not be sent', { userId: profile.id, status: error.status, providerMessage: error.message });
      if (error.status === 429) throw ApiError.tooMany('Too many emails requested. Wait a minute and try again.');
    }
  },

  /**
   * Set a new password from a reset email: either the link (its recovery
   * access token) or the code typed with the email address. Every session the
   * account had is then signed out.
   */
  async resetPassword(
    proof: { accessToken?: string; email?: string; code?: string },
    newPassword: string,
  ): Promise<void> {
    let userId: string;
    let token: string;
    if (proof.accessToken) {
      const { data, error } = await supabaseAdmin.auth.getUser(proof.accessToken);
      if (error || !data.user || !isRecoveryToken(proof.accessToken)) throw ApiError.unauthorized(EXPIRED_LINK);
      userId = data.user.id;
      token = proof.accessToken;
    } else {
      const { data, error } = await supabaseAuth.auth.verifyOtp({
        email: String(proof.email).toLowerCase().trim(),
        token: String(proof.code),
        type: 'recovery',
      });
      if (error || !data.session || !data.user) throw ApiError.unauthorized(EXPIRED_CODE);
      userId = data.user.id;
      token = data.session.access_token;
    }

    const profile = await adminUserRepo.findById(userId);
    if (!profile || !profile.isActive) throw ApiError.unauthorized(EXPIRED_LINK);

    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: newPassword });
    if (error) {
      logger.warn('Password reset rejected by the identity provider', { userId, providerMessage: error.message });
      throw ApiError.badRequest(
        `Password could not be updated. It must be at least ${MIN_PASSWORD_LENGTH} characters and not previously used.`,
      );
    }
    await supabaseAdmin.auth.admin.signOut(token, 'global').catch(() => undefined);
  },

  /* ── Administrator provisioning ─────────────────────────────────────────── */

  /**
   * Create an administrator: a Supabase Auth identity plus its application
   * profile. Only reachable from the admin-only POST /admins route — there is
   * no public signup endpoint anywhere in this API.
   *
   * The two writes span two systems and cannot share a transaction, so a failed
   * profile insert deletes the just-created identity. Without that compensation
   * a half-created account would occupy the email address while being unable to
   * sign in to anything.
   */
  async createAdminUser(input: {
    name: string;
    email: string;
    password: string;
    role?: Role;
  }): Promise<IAdminUser> {
    const email = String(input.email ?? '').toLowerCase().trim();
    const name = String(input.name ?? '').trim();
    // Validated here as well as at the route. This method is also reachable
    // from the seed scripts, and a cast (`input.role as Role`) asserts a type
    // rather than checking one — it would happily store "superadmin", which
    // matches no authorization rule and yields an account nobody can reason
    // about.
    const requestedRole = input.role ?? ROLES.ADMIN;
    if (!ALL_ROLES.includes(requestedRole as Role)) {
      throw ApiError.unprocessable('Validation failed', [
        { field: 'role', message: `Role must be one of: ${ALL_ROLES.join(', ')}` },
      ]);
    }
    const role = requestedRole as Role;

    if (!name) {
      throw ApiError.unprocessable('Validation failed', [
        { field: 'name', message: 'Name is required' },
      ]);
    }
    if (!email) {
      throw ApiError.unprocessable('Validation failed', [
        { field: 'email', message: 'A valid email is required' },
      ]);
    }
    // Mirrors the former `minlength: 8` on the Mongoose password path.
    if (!input.password || input.password.length < MIN_PASSWORD_LENGTH) {
      throw ApiError.unprocessable('Validation failed', [
        {
          field: 'password',
          message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        },
      ]);
    }

    const existing = await adminUserRepo.exists({ email });
    if (existing) throw ApiError.conflict('An admin with this email already exists');

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: input.password,
      // Admins are provisioned by another admin, so there is nobody to click a
      // confirmation link; mark the address confirmed at creation time.
      email_confirm: true,
      user_metadata: { name },
    });

    if (error || !data.user) {
      if (error?.message?.toLowerCase().includes('already')) {
        throw ApiError.conflict('An admin with this email already exists');
      }
      // Anything else is the provider's own diagnostic. Log it; tell the
      // calling admin only that it did not work.
      logger.warn('Identity provider rejected admin creation', {
        providerMessage: error?.message,
      });
      throw ApiError.badRequest('Could not create the administrator account');
    }

    try {
      return await adminUserRepo.insertRaw({
        id: data.user.id,
        name,
        email,
        role,
      });
    } catch (err) {
      // Compensating action — never leave an orphaned identity behind.
      await supabaseAdmin.auth.admin.deleteUser(data.user.id).catch(() => undefined);
      throw err;
    }
  },

  /**
   * Delete an administrator. Removing the Supabase identity cascades to the
   * profile row (admin_users.id references auth.users ON DELETE CASCADE), so
   * the identity is deleted first and the profile follows automatically.
   */
  async deleteAdminUser(userId: string): Promise<boolean> {
    const profile = await adminUserRepo.findById(userId);
    if (!profile) return false;

    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (error) {
      // The identity may already be gone; make sure the profile is too.
      await adminUserRepo.deleteById(userId);
      logger.warn(`Deleted admin profile ${userId} but Auth reported: ${error.message}`);
      return true;
    }
    // Defensive: if the cascade did not fire, remove the profile explicitly.
    await adminUserRepo.deleteById(userId).catch(() => undefined);
    return true;
  },
};
