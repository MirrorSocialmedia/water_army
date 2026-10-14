/**
 * Session service — opaque tokens; only SHA-256 hashes are stored (MD §7).
 * Cookies carry the plaintext token (HttpOnly); the DB never sees it.
 */
import crypto from 'node:crypto';

const LAST_SEEN_REFRESH_MS = 60_000;

export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSessionService({ db, config }) {
  /**
   * @param {string} userId
   * @returns {Promise<{token:string, expiresAt:Date}>}
   */
  async function issue(userId) {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlMs);
    await db.session.create({
      data: { tokenHash: hashToken(token), userId, expiresAt },
    });
    return { token, expiresAt };
  }

  /**
   * @param {string|undefined} token
   * @returns {Promise<{session:object, user:object}|null>}
   * @throws when the session store itself is unavailable (DB down)
   */
  async function verify(token) {
    if (!token) return null;
    const row = await db.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await db.session.delete({ where: { id: row.id } }).catch(() => {});
      return null;
    }
    if (!row.user.isActive) return null;
    return { session: row, user: row.user };
  }

  /** Revoke (logout). Missing rows are fine. */
  async function revoke(sessionId) {
    if (!sessionId) return;
    await db.session.delete({ where: { id: sessionId } }).catch(() => {});
  }

  /**
   * Throttled last-seen update (avoid one DB write per request).
   */
  async function touch(session) {
    if (!session) return;
    if (Date.now() - session.lastSeenAt.getTime() < LAST_SEEN_REFRESH_MS) return;
    await db.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => {});
  }

  return { issue, verify, revoke, touch };
}
