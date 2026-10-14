/**
 * Audit service — appends to audit_events. Failures are logged, never
 * crash the request (audit must not take the API down).
 * Secrets must already be redacted by the caller before `details` is passed
 * (施工 MD §13.3 / threat model T3).
 */
export function createAuditService({ db, log }) {
  /**
   * @param {{
   *   actorUserId?: string|null,
   *   action: string,
   *   resourceType?: string|null,
   *   resourceId?: string|null,
   *   requestId?: string|null,
   *   ip?: string|null,
   *   status?: string|null,
   *   details?: object|null,
   * }} entry
   */
  return async function writeAudit(entry) {
    try {
      await db.auditEvent.create({
        data: {
          actorUserId: entry.actorUserId ?? null,
          action: entry.action,
          resourceType: entry.resourceType ?? null,
          resourceId: entry.resourceId ?? null,
          requestId: entry.requestId ?? null,
          ip: entry.ip ?? null,
          status: entry.status ?? null,
          detailsJson: entry.details ?? undefined,
        },
      });
    } catch (err) {
      log.error({ action: entry.action, error: err.message }, 'audit write failed');
    }
  };
}
