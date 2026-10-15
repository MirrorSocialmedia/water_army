/**
 * Dashboard summary (P6 UX close — 施工 MD §6.1).
 *
 * One viewer+ endpoint for every number the dashboard shows — no hardcoded
 * demo data, no client-side guessing:
 *   - containers: managed fleet counts (same label-OR-exception rule as the
 *     list + mutation gate, flag #1); degrades to {available:false} when
 *     Docker is down (never 500 — same semantics as /api/health/ready)
 *   - taskRuns: active now / failed 24h / succeeded 24h + 5 most recent
 *     failures (link out to the run detail)
 *   - schedules: total + enabled
 *   - notifications: unread (the topbar bell polls this too, cheaply)
 */

const HOURS_24 = 24 * 60 * 60 * 1000;
const ACTIVE_RUN_STATUSES = ['queued', 'running', 'needs_approval'];
const FAILED_RUN_STATUSES = ['failed', 'timed_out'];

export function dashboardRoutes(app) {
  app.get(
    '/api/dashboard/summary',
    { preHandler: app.requireRole('viewer') },
    async (req) => {
      const since24h = new Date(Date.now() - HOURS_24);

      const [containers, taskRuns, schedules, notifications] = await Promise.all([
        (async () => {
          try {
            const { items, total } = await app.dockerService.listContainers({ managed: true, pageSize: 200 });
            let running = 0;
            let stopped = 0;
            let attention = 0;
            for (const c of items) {
              if (c.state === 'running') running += 1;
              else if (c.state === 'dead' || c.state === 'restarting') attention += 1;
              else stopped += 1; // exited / created / removing / unknown
            }
            return { available: true, total, running, stopped, attention, partial: total > items.length };
          } catch (e) {
            // Docker down/disabled ≠ API failure — the dashboard must still
            // render (health/ready reports the detail).
            req.log.debug?.({ err: e?.message ?? String(e) }, 'dashboard: container summary unavailable');
            return { available: false, total: null, running: null, stopped: null, attention: null, partial: false, reason: e?.code ?? 'docker-unavailable' };
          }
        })(),
        Promise.all([
          app.db.taskRun.count({ where: { status: { in: ACTIVE_RUN_STATUSES } } }),
          app.db.taskRun.count({ where: { status: { in: FAILED_RUN_STATUSES }, finishedAt: { gte: since24h } } }),
          app.db.taskRun.count({ where: { status: 'succeeded', finishedAt: { gte: since24h } } }),
          app.db.taskRun.findMany({
            where: { status: { in: FAILED_RUN_STATUSES } },
            orderBy: { finishedAt: 'desc' },
            take: 5,
          }),
        ]).then(([active, failed24h, succeeded24h, recentFailed]) => ({
          active,
          failed24h,
          succeeded24h,
          recentFailed: recentFailed.map((r) => ({
            id: r.id,
            status: r.status,
            errorCode: r.errorCode ?? null,
            finishedAt: r.finishedAt,
          })),
        })),
        Promise.all([
          app.db.schedule.count(),
          app.db.schedule.count({ where: { isEnabled: true } }),
        ]).then(([total, enabled]) => ({ total, enabled })),
        app.db.scheduleNotification.count({ where: { isRead: false } }).then((unread) => ({ unread })),
      ]);

      return { containers, taskRuns, schedules, notifications };
    },
  );
}
