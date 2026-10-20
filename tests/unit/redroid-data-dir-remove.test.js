/**
 * R6 — unit tests for removeRedroidDataDir (the path-guarded recursive rm
 * behind DELETE ?removeData). The guards are security-relevant (they refuse
 * to rm anything outside the redroid data root, including via symlinks), and
 * the R6 change adds a stable machine-readable `code` to every outcome so
 * the delete response can surface partial failures (e.g. the R5 live
 * EACCES on root-owned dirs) as a code, not just free text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { removeRedroidDataDir } from '../../apps/api/src/services/redroid-service.js';

test('removeRedroidDataDir: refuses anything outside the data root (with a stable code)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-r6-rmroot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await t.test('sibling of the root → DATA_DIR_REFUSED, nothing removed', async () => {
    const outside = path.join(path.dirname(root), `wa-r6-outside-${process.pid}`);
    fs.mkdirSync(outside, { recursive: true });
    try {
      const r = await removeRedroidDataDir(outside, root);
      assert.equal(r.removed, false);
      assert.equal(r.code, 'DATA_DIR_REFUSED');
      assert.match(r.error, /outside redroid data root/);
      assert.ok(fs.existsSync(outside), 'the directory must still exist');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  await t.test('the root itself → refused (never rm the root)', async () => {
    const r = await removeRedroidDataDir(root, root);
    assert.equal(r.removed, false);
    assert.equal(r.code, 'DATA_DIR_REFUSED');
    assert.ok(fs.existsSync(root));
  });

  await t.test('symlink escaping the root → refused', async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-r6-symtarget-'));
    const link = path.join(root, 'escape');
    fs.symlinkSync(target, link);
    try {
      const r = await removeRedroidDataDir(link, root);
      assert.equal(r.removed, false);
      assert.equal(r.code, 'DATA_DIR_REFUSED');
      assert.match(r.error, /realpath escapes/);
      assert.ok(fs.existsSync(target), 'the symlink target must survive');
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  await t.test('not a directory → refused', async () => {
    const file = path.join(root, 'a-file');
    fs.writeFileSync(file, 'x');
    const r = await removeRedroidDataDir(file, root);
    assert.equal(r.removed, false);
    assert.equal(r.code, 'DATA_DIR_REFUSED');
    assert.match(r.error, /not a directory/);
    assert.ok(fs.existsSync(file));
  });
});

test('removeRedroidDataDir: removes a real subdirectory inside the root', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-r6-rmok-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dev = path.join(root, 'redroid-dev1');
  fs.mkdirSync(path.join(dev, 'databoot'), { recursive: true });
  fs.writeFileSync(path.join(dev, 'databoot', 'userdata.img'), 'x');

  const r = await removeRedroidDataDir(dev, root);
  assert.equal(r.removed, true);
  assert.equal(r.code, null);
  assert.equal(r.error, null);
  assert.ok(!fs.existsSync(dev), 'the device data dir must be gone');
  assert.ok(fs.existsSync(root), 'the root must survive');
});
