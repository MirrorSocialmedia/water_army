/**
 * BR-B1 — batch split + capacity validation (施工 MD §14.1 unit items 1-3):
 *   - 200 identities → exactly 4 batches of 50
 *   - 201 identities → 4×50 + one short final batch; nothing dropped
 *   - disabled identities → SKIPPED in place (positions of others unchanged)
 *   - capacity input validation (MD §3.1)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { planCycle, validateCapacityInput, BatchError } from '@water-army/shared';

const ids = (n, start = 0) => Array.from({ length: n }, (_, i) => ({ id: `id-${start + i}`, status: 'READY' }));

test('200 identities / batch 50 → exactly 4 batches of 50, no loss, no dup', () => {
  const plan = planCycle({ identities: ids(200), batchSize: 50 });
  assert.equal(plan.batchCount, 4);
  assert.deepEqual(plan.batches.map((b) => b.size), [50, 50, 50, 50]);
  assert.deepEqual(plan.batches.map((b) => b.batchNo), [1, 2, 3, 4]);
  assert.deepEqual(plan.stats, { total: 200, included: 200, skipped: 0 });

  const flat = plan.batches.flatMap((b) => b.members.map((m) => m.identityId));
  assert.equal(flat.length, 200);
  assert.equal(new Set(flat).size, 200, 'every identity exactly once');
  // positions are 1-based and gapless per batch
  for (const b of plan.batches) {
    assert.deepEqual(b.members.map((m) => m.position), Array.from({ length: 50 }, (_, i) => i + 1));
  }
});

test('201 identities / batch 50 → 5 batches, last size 1, nothing dropped (MD §14.1)', () => {
  const plan = planCycle({ identities: ids(201), batchSize: 50 });
  assert.equal(plan.batchCount, 5);
  assert.deepEqual(plan.batches.map((b) => b.size), [50, 50, 50, 50, 1]);
  assert.equal(plan.stats.total, 201);
  assert.equal(plan.stats.included, 201);
  const flat = plan.batches.flatMap((b) => b.members.map((m) => m.identityId));
  assert.equal(new Set(flat).size, 201);
  assert.equal(flat[200], 'id-200', 'the 201st identity lands in the final batch');
});

test('identity order is the stable binding (input order → positions)', () => {
  const shuffled = [...ids(120)].reverse();
  const plan = planCycle({ identities: shuffled, batchSize: 50 });
  // reverse order: [id-119, id-118, ..., id-0]
  //   batch0 = global 0-49   → id-119 ... id-70
  //   batch1 = global 50-99  → id-69  ... id-20
  //   batch2 = global 100-119→ id-19  ... id-0  (20 members)
  assert.equal(plan.batches[0].members[0].identityId, 'id-119'); // first input row → position 1
  assert.equal(plan.batches[0].members[49].identityId, 'id-70'); // last of batch 0
  assert.equal(plan.batches[2].members[0].identityId, 'id-19');  // global index 100
  assert.equal(plan.batches[2].members[19].identityId, 'id-0');  // global index 119 (last row)
});

test('disabled identity → SKIPPED in its own position; others NOT rebound', () => {
  const rows = ids(101);
  rows[7].status = 'DISABLED'; // batch 1, position 8
  rows[70].status = 'DISABLED'; // batch 2, position 21
  const plan = planCycle({ identities: rows, batchSize: 50 });
  assert.deepEqual(plan.stats, { total: 101, included: 99, skipped: 2 });
  const m8 = plan.batches[0].members[7];
  assert.equal(m8.position, 8);
  assert.equal(m8.identityId, 'id-7');
  assert.equal(m8.state, 'SKIPPED');
  assert.match(m8.skipReason, /disabled/);
  // neighbours keep their slots — no silent rebinding (MD §3.2)
  assert.equal(plan.batches[0].members[6].identityId, 'id-6');
  assert.equal(plan.batches[0].members[8].identityId, 'id-8');
  assert.equal(plan.batches[1].members[20].identityId, 'id-70');
  assert.equal(plan.batches[1].members[20].state, 'SKIPPED');
});

test('non-READY (not disabled) identity at planning time → SKIPPED with status reason', () => {
  const rows = ids(60);
  rows[5].status = 'RUNNING'; // stale leftover from a crashed cycle
  const plan = planCycle({ identities: rows, batchSize: 50 });
  const m = plan.batches[0].members[5];
  assert.equal(m.state, 'SKIPPED');
  assert.match(m.skipReason, /RUNNING/);
  assert.equal(plan.stats.included, 59);
});

test('0 identities → 0 batches (MD §3.1: TOTAL_IDENTITIES >= 0 is valid)', () => {
  const plan = planCycle({ identities: [], batchSize: 50 });
  assert.equal(plan.batchCount, 0);
  assert.deepEqual(plan.stats, { total: 0, included: 0, skipped: 0 });
});

test('batchSize must be integer >= 1 (planCycle hard-fails, no silent default)', () => {
  assert.throws(() => planCycle({ identities: ids(3), batchSize: 0 }), TypeError);
  assert.throws(() => planCycle({ identities: ids(3), batchSize: 2.5 }), TypeError);
  assert.throws(() => planCycle({ identities: 'nope', batchSize: 50 }), TypeError);
});

test('validateCapacityInput enforces MD §3.1 + failure_policy allowlist', () => {
  assert.deepEqual(validateCapacityInput({ batchSize: 50, maxActiveContainers: 50, failurePolicy: 'stop_batch' }), []);
  assert.deepEqual(validateCapacityInput({ batchSize: 50, maxActiveContainers: 1, failurePolicy: 'continue_and_report' }), []);

  assert.match(validateCapacityInput({ batchSize: 0, maxActiveContainers: 50, failurePolicy: 'stop_batch' }).join(), /batchSize/);
  assert.match(validateCapacityInput({ batchSize: 50, maxActiveContainers: 0, failurePolicy: 'stop_batch' }).join(), /maxActiveContainers/);
  assert.match(validateCapacityInput({ batchSize: 50, maxActiveContainers: 50, failurePolicy: 'auto_continue' }).join(), /failurePolicy/);
  assert.match(validateCapacityInput({ batchSize: '50', maxActiveContainers: 50, failurePolicy: 'stop_batch' }).join(), /batchSize/);
});

test('large cycle: 999 identities / 50 → 20 batches, last size 49, total preserved', () => {
  const plan = planCycle({ identities: ids(999), batchSize: 50 });
  assert.equal(plan.batchCount, 20);
  assert.equal(plan.batches[19].size, 49);
  assert.equal(plan.stats.total, 999);
  assert.equal(plan.batches.flatMap((b) => b.members).length, 999);
});
