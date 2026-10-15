/**
 * P6 flag #3 — schedule notifier (worker side) unit tests.
 *
 * Contract:
 *  - one notification per TERMINAL scheduled run (unique runId)
 *  - ad-hoc runs (no scheduleId) and non-terminal runs never notify
 *  - deleted schedule → skip (no dangling rows)
 *  - duplicate terminal write (P2002 on runId) = already notified → null
 *  - terminal last_status written back onto the schedule
 *  - write failures are non-fatal (logged, null returned)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleNotifier } from '../../apps/worker/src/schedule-notifier.js';
import { makeFakeDb } from '../helpers/fakes.js';

const SCHED_ID = '22222222-2222-4222-8222-222222222222';

async function setup() {
  const warnings = [];
  const log = { debug: () => {}, warn: (m) => warnings.push(m), info: () => {}, error: () => {} };
  const db = makeFakeDb({});
  await db.schedule.create({
    data: { id: SCHED_ID, name: 'Nightly check', taskDefinitionId: 'def-1', scheduleType: 'interval', intervalMs: 60000 },
  });
  return { db, log, warnings, notifier: createScheduleNotifier({ db, log }) };
}

const RUN = (over = {}) => ({ id: 'run-1', scheduleId: SCHED_ID, status: 'succeeded', ...over });

test('notifier: terminal scheduled run → notification + last_status backfill', async (t) => {
  const { db, notifier } = await setup();

  await t.test('succeeded → row created with title/status, last_status written', async () => {
    const id = await notifier.notifyTerminal(RUN());
    assert.ok(id, 'returns the notification id');
    const row = await db.scheduleNotification.findUnique({ where: { id } });
    assert.equal(row.runId, 'run-1');
    assert.equal(row.scheduleId, SCHED_ID);
    assert.equal(row.status, 'succeeded');
    assert.equal(row.title, '[Nightly check] completed');
    assert.equal(row.isRead, false);
    const sched = await db.schedule.findUnique({ where: { id: SCHED_ID } });
    assert.equal(sched.lastStatus, 'succeeded');
  });

  await t.test('failed → message carries errorCode (+truncated errorMessage)', async () => {
    const id = await notifier.notifyTerminal(RUN({ id: 'run-fail', status: 'failed', errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'x'.repeat(500) }));
    const row = await db.scheduleNotification.findUnique({ where: { id } });
    assert.equal(row.status, 'failed');
    assert.ok(row.message.startsWith('PROVIDER_TIMEOUT: '));
    assert.ok(row.message.length <= 'PROVIDER_TIMEOUT: '.length + 200, 'errorMessage truncated to 200 chars');
  });

  await t.test('skipped (overlap) → notified — once-schedules need the record', async () => {
    const id = await notifier.notifyTerminal(RUN({ id: 'run-skip', status: 'skipped' }));
    const row = await db.scheduleNotification.findUnique({ where: { id } });
    assert.equal(row.status, 'skipped');
    assert.equal(row.title, '[Nightly check] skipped');
  });
});

test('notifier: negative paths return null without rows', async (t) => {
  const { db, notifier } = await setup();

  await t.test('non-terminal run (running) → null, no row', async () => {
    assert.equal(await notifier.notifyTerminal(RUN({ id: 'run-live', status: 'running' })), null);
    assert.equal(await db.scheduleNotification.count({}), 0);
  });

  await t.test('ad-hoc run (no scheduleId) → null', async () => {
    assert.equal(await notifier.notifyTerminal(RUN({ id: 'run-adhoc', scheduleId: null })), null);
    assert.equal(await db.scheduleNotification.count({}), 0);
  });

  await t.test('deleted schedule → null (no dangling notification)', async () => {
    await db.schedule.delete({ where: { id: SCHED_ID } });
    assert.equal(await notifier.notifyTerminal(RUN()), null);
    assert.equal(await db.scheduleNotification.count({}), 0);
  });

  await t.test('malformed run (no id) → null, no throw', async () => {
    assert.equal(await notifier.notifyTerminal(null), null);
    assert.equal(await notifier.notifyTerminal({ status: 'failed' }), null);
  });
});

test('notifier: duplicate terminal write is a no-op (unique runId)', async (t) => {
  const { db, notifier } = await setup();
  const first = await notifier.notifyTerminal(RUN());
  assert.ok(first);
  // Second terminal write for the SAME run (crash-path race) → P2002 inside
  // the fake → treated as already notified.
  assert.equal(await notifier.notifyTerminal(RUN()), null);
  assert.equal(await db.scheduleNotification.count({}), 1);
});

test('notifier: DB failure is non-fatal (logged, null returned)', async (t) => {
  const warnings = [];
  const log = { debug: () => {}, warn: (m) => warnings.push(m), info: () => {}, error: () => {} };
  const db = {
    schedule: { findUnique: async () => { throw new Error('db down'); } },
    scheduleNotification: {},
  };
  const { createScheduleNotifier } = await import('../../apps/worker/src/schedule-notifier.js');
  const notifier = createScheduleNotifier({ db, log });
  assert.equal(await notifier.notifyTerminal(RUN()), null);
  assert.equal(warnings.length, 1);
});
