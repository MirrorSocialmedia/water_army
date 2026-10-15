/**
 * Schedule notifications (P6 flag #3 — 施工 MD 尾段: 排程執行完成/失敗 → UI 通知).
 *
 * Data is written by the worker (schedule-notifier.js) at terminal scheduled
 * runs, incl. overlap-skipped slots. These routes are the read/mark-read
 * surface for the UI badge:
 *
 *   GET  /api/schedule-notifications            (viewer+)  list, newest first
 *   GET  /api/schedule-notifications/unread-count (viewer+) { count }
 *   POST /api/schedule-notifications/read-all   (operator+) mark all read
 *   POST /api/schedule-notifications/:id/read   (operator+) mark one read
 *
 * Marking read is a WRITE (is_read flips) → operator+ per the strict
 * viewer=read-only matrix (MD §13.2). The badge is a per-operator-session
 * convenience; viewers still see the notifications list itself.
 */
const LIST_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    unreadOnly: { type: 'string', enum: ['true', 'false'] },
    limit: { type: 'string' },
  },
};

const ID_PARAM = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
};

export function scheduleNotificationRoutes(app) {
  const db = () => app.db;

  app.get(
    '/api/schedule-notifications/unread-count',
    { preHandler: app.requireRole('viewer') },
    async (req) => {
      const count = await db().scheduleNotification.count({ where: { isRead: false } });
      return { count };
    },
  );

  app.get(
    '/api/schedule-notifications',
    { preHandler: app.requireRole('viewer'), schema: { querystring: LIST_QUERY } },
    async (req) => {
      const unreadOnly = req.query.unreadOnly === 'true';
      let limit = req.query.limit !== undefined ? Number(req.query.limit) : 20;
      if (!Number.isInteger(limit) || limit < 1) limit = 20;
      limit = Math.min(limit, 100);
      const items = await db().scheduleNotification.findMany({
        where: unreadOnly ? { isRead: false } : {},
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: limit,
      });
      return { items };
    },
  );

  app.post(
    '/api/schedule-notifications/read-all',
    { preHandler: app.requireRole('operator') },
    async (req) => {
      const res = await db().scheduleNotification.updateMany({ where: { isRead: false }, data: { isRead: true } });
      return { marked: res.count };
    },
  );

  app.post(
    '/api/schedule-notifications/:id/read',
    { preHandler: app.requireRole('operator'), schema: { params: ID_PARAM } },
    async (req, reply) => {
      try {
        const n = await db().scheduleNotification.update({ where: { id: req.params.id }, data: { isRead: true } });
        return { id: n.id, isRead: true };
      } catch (err) {
        if (String(err?.code ?? '').includes('P2025')) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `notification ${req.params.id} not found`, requestId: req.id } });
        }
        throw err;
      }
    },
  );
}
