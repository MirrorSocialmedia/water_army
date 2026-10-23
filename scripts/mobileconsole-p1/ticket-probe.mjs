#!/usr/bin/env node
/**
 * MC P1 ticket probe — service-level verification of stream tickets against the
 * LIVE scratch stack (real PG 16494 + real Redis 16495 + same HMAC secret the
 * API runs with). The P1 HTTP surface has no ticket-validation endpoint by
 * design (P2's WS upgrade consumes tickets); this probe exercises the exact
 * service function the WS layer will call.
 *
 * Usage:
 *   ticket-probe.mjs <ticket> <leaseId> <deviceId> <userId> <mode> [--expired-only]
 * Env: DATABASE_URL, REDIS_URL, STREAM_TICKET_SECRET
 * Output: t13-probe.json (default) / t13b-probe.json (--expired-only) — tickets
 * REDACTED (length + first 6 chars only).
 *
 * Checks (default mode, live ACTIVE lease):
 *   1. valid ticket, consume=false      → lease row returned
 *   2. wrong device binding             → 401 STREAM_TICKET_INVALID
 *   3. wrong user binding               → 401 STREAM_TICKET_INVALID
 *   4. consume=true (burns the ticket)  → ok
 *   5. replay the SAME ticket           → 401 STREAM_TICKET_REPLAYED
 * Checks (--expired-only, ticket >61s old):
 *   1. validate                           → 401 STREAM_TICKET_INVALID (expired)
 */
import ioredis from 'ioredis';
import { createDb, closeDb } from '../../apps/api/src/plugins/db.js';
import { createStreamLeaseService } from '../../apps/api/src/services/stream-lease-service.js';
import { createLeaseService } from '@water-army/shared';

const [ticket, leaseId, deviceId, userId, mode, flag] = process.argv.slice(2);
if (!ticket || !leaseId || !deviceId || !userId || !mode) {
  console.error('usage: ticket-probe.mjs <ticket> <leaseId> <deviceId> <userId> <mode> [--expired-only]');
  process.exit(2);
}
const expiredOnly = flag === '--expired-only';
if (!process.env.DATABASE_URL || !process.env.REDIS_URL || !process.env.STREAM_TICKET_SECRET) {
  console.error('env required: DATABASE_URL, REDIS_URL, STREAM_TICKET_SECRET');
  process.exit(2);
}

const redact = (t) => `***${String(t).slice(0, 6)}...len=${String(t).length}`;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const db = await createDb({ databaseUrl: process.env.DATABASE_URL, nodeEnv: 'production' });
const redis = new ioredis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 });
const svc = createStreamLeaseService({
  db,
  redis,
  config: {
    maxConcurrentDeviceStreamsRaw: '',
    streamTicketSecret: process.env.STREAM_TICKET_SECRET,
    streamLeaseTtlMs: 3000,
    streamReconcileIntervalMs: 0,
  },
  log: SILENT,
  leaseService: createLeaseService({ db }),
});

const out = { redactedTicket: redact(ticket), leaseId, deviceId, mode, checks: [], ok: false };
const codeOf = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, apiCode: e.apiCode, statusCode: e.statusCode, message: e.message };
  }
};

if (expiredOnly) {
  const r = await codeOf(() => svc.validateTicket({ ticket, user: { id: userId }, deviceId, mode }));
  out.checks.push({ name: 'expired_ticket_rejected', got: r.apiCode ?? 'ok', pass: r.ok === false && r.apiCode === 'STREAM_TICKET_INVALID' && /expired/i.test(r.message) });
  out.ok = out.checks.every((c) => c.pass);
} else {
  const r1 = await codeOf(() => svc.validateTicket({ ticket, user: { id: userId }, deviceId, mode }));
  out.checks.push({ name: 'valid_ticket', pass: r1.ok === true && r1.value.id === leaseId });
  const r2 = await codeOf(() => svc.validateTicket({ ticket, user: { id: userId }, deviceId: '00000000-0000-4000-8000-000000000000', mode }));
  out.checks.push({ name: 'wrong_device_401', pass: r2.ok === false && r2.apiCode === 'STREAM_TICKET_INVALID' && r2.statusCode === 401 });
  const r3 = await codeOf(() => svc.validateTicket({ ticket, user: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, deviceId, mode }));
  out.checks.push({ name: 'wrong_user_401', pass: r3.ok === false && r3.apiCode === 'STREAM_TICKET_INVALID' && r3.statusCode === 401 });
  const r4 = await codeOf(() => svc.validateTicket({ ticket, user: { id: userId }, deviceId, mode, consume: true }));
  out.checks.push({ name: 'consume_burns', pass: r4.ok === true });
  const r5 = await codeOf(() => svc.validateTicket({ ticket, user: { id: userId }, deviceId, mode, consume: true }));
  out.checks.push({ name: 'replay_401', pass: r5.ok === false && r5.apiCode === 'STREAM_TICKET_REPLAYED' && r5.statusCode === 401 });
  out.ok = out.checks.every((c) => c.pass);
}

const file = expiredOnly ? 't13b-probe.json' : 't13-probe.json';
const { writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
writeFileSync(join(process.env.EVID ?? '/home/kenneth/.openclaw/workspace/logs/mobileconsole-p1', file), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
await closeDb(db);
redis.disconnect();
process.exit(out.ok ? 0 : 1);
