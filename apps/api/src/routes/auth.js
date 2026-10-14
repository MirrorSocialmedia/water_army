/**
 * Auth routes — login / logout / me (施工 MD §8, §13.2).
 * No public registration: the first admin is created via `npm run setup:admin`.
 *
 * Security notes:
 *  - argon2id (MD §13.2), equal-time verify against a dummy hash when the
 *    username is unknown (prevents user enumeration via timing).
 *  - Login rate limit: 5 attempts / 60s / IP (429 RATE_LIMITED).
 *  - Every failed login is audited (MD §7 audit_events).
 *  - Session = opaque token in an HttpOnly SameSite=Lax cookie; DB stores
 *    only the SHA-256 hash (MD §7 sessions).
 */
import argon2 from '@node-rs/argon2';
import crypto from 'node:crypto';

const { argon2id, hash, verify } = argon2;

import { clearSessionCookie, parseCookies, serializeSessionCookie } from '../security/cookie.js';
import { SESSION_COOKIE } from '@water-army/shared';

// Timing-equalization decoy (verified against any password attempt).
const DUMMY_HASH = await hash(crypto.randomBytes(16).toString('hex'), { type: argon2id });

const LOGIN_SCHEMA = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['username', 'password'],
    properties: {
      username: { type: 'string', minLength: 3, maxLength: 32, pattern: '^[a-zA-Z0-9_.-]+$' },
      password: { type: 'string', minLength: 8, maxLength: 128 },
    },
  },
};

const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  role: user.role,
});

export function authRoutes(app) {
  app.post('/api/auth/login', { schema: LOGIN_SCHEMA }, async (req, reply) => {
    const ip = req.ip;
    const gate = app.rateLimiter.check(ip);
    if (!gate.allowed) {
      await app.audit({
        action: 'auth.login_failed',
        status: 'failure',
        ip,
        requestId: req.id,
        details: { username: req.body.username, reason: 'rate_limited' },
      });
      reply.header('retry-after', Math.ceil(gate.retryAfterMs / 1000));
      return reply.code(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many login attempts — try again later',
          requestId: req.id,
        },
      });
    }

    const { username, password } = req.body;
    const user = await app.db.user.findUnique({ where: { username } });
    const passwordOk = user
      ? await verify(user.passwordHash, password)
      : await verify(DUMMY_HASH, password);

    if (!user || !passwordOk) {
      app.rateLimiter.hit(ip);
      await app.audit({
        action: 'auth.login_failed',
        status: 'failure',
        ip,
        requestId: req.id,
        details: { username, reason: user ? 'bad_password' : 'unknown_user' },
      });
      return reply.code(401).send({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid username or password',
          requestId: req.id,
        },
      });
    }
    if (!user.isActive) {
      app.rateLimiter.hit(ip);
      await app.audit({
        action: 'auth.login_failed',
        status: 'failure',
        ip,
        requestId: req.id,
        details: { username, reason: 'inactive' },
      });
      return reply.code(401).send({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid username or password',
          requestId: req.id,
        },
      });
    }

    const { token, expiresAt } = await app.sessions.issue(user.id);
    await app.db.user
      .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
      .catch(() => {});
    await app.audit({
      actorUserId: user.id,
      action: 'auth.login_success',
      status: 'success',
      ip,
      requestId: req.id,
      details: { username: user.username },
    });

    reply.header(
      'set-cookie',
      serializeSessionCookie(token, {
        maxAgeSeconds: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
        secure: app.config.cookieSecure,
      }),
    );
    return { user: publicUser(user) };
  });

  app.post(
    '/api/auth/logout',
    { preHandler: app.requireRole('viewer') },
    async (req, reply) => {
    await app.sessions.revoke(req.session?.id);
    await app.audit({
      actorUserId: req.user?.id ?? null,
      action: 'auth.logout',
      status: 'success',
      ip: req.ip,
      requestId: req.id,
    });
    reply.header('set-cookie', clearSessionCookie());
    return reply.code(204).send();
  });

  app.get(
    '/api/auth/me',
    { preHandler: app.requireRole('viewer') },
    async (req) => {
    return {
      user: {
        ...publicUser(req.user),
        lastLoginAt: req.user.lastLoginAt,
      },
    };
  });
}

export { parseCookies, SESSION_COOKIE };
