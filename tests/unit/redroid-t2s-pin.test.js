/**
 * R1 (2026-10-20) — tun2socks source pin + fetch script contract.
 *
 *  - the shell-side pin (docker/redroid-matrix/tun2socks.env) and the JS-side
 *    constant (TUN2SOCKS_PIN) must agree — one drift = a silently different
 *    binary between what the image bakes and what the service documents
 *  - fetch-tun2socks.sh is exercised FOR REAL (subprocess `sh`) against
 *    committed zip fixtures via file:// URLs: hermetic (no network), and it
 *    proves every fail-fast branch (checksum, magic, arch, retry cap,
 *    'latest' refusal, missing inner file)
 *
 * The real upstream download (v2.7.0 zip → inner sha256
 * 98d545a6…c031) was verified live during R1 and is re-verified on every
 * `docker build` of the wrapper image (builder stage).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { TUN2SOCKS_PIN, tun2socksAssetUrl } from '../../apps/api/src/services/redroid-service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MATRIX_DIR = path.join(REPO_ROOT, 'docker', 'redroid-matrix');
const PIN_FILE = path.join(MATRIX_DIR, 'tun2socks.env');
const FETCH_SCRIPT = path.join(MATRIX_DIR, 'fetch-tun2socks.sh');
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures');

/** Parse KEY=VALUE lines from the shell pin file (resolves the `${VAR:-default}` form to its default). */
function readPin() {
  const out = {};
  for (const line of fs.readFileSync(PIN_FILE, 'utf8').split('\n')) {
    const envForm = line.match(/^TUN2SOCKS_([A-Z0-9_]+)=\$\{TUN2SOCKS_[A-Z0-9_]+:-([^}]*)\}$/);
    const plain = line.match(/^(TUN2SOCKS_[A-Z0-9_]+)=(.*)$/);
    if (envForm) out[`TUN2SOCKS_${envForm[1]}`] = envForm[2];
    else if (plain) out[plain[1]] = plain[2];
  }
  return out;
}

/** sha256 (hex) of a file. */
function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * The staging test (redroid-t2s-staging.test.js) runs REAL `pkill -f ...un2socks`
 * commands, and the full suite runs test files in parallel — a child whose
 * cmdline contains the literal token (e.g. `sh docker/redroid-matrix/
 * fetch-tun2socks.sh`) is collateral. So every spawn below goes through a
 * NEUTRAL copy of the script (path without the token); the pin file is then
 * located via TUN2SOCKS_PIN_FILE (the script's default is dirname($0)-based).
 */
let neutralScriptPath = null;
function getNeutralFetchScript() {
  if (!neutralScriptPath) {
    neutralScriptPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'wa-r1-fs-')),
      'fetch-run.sh',
    );
    fs.copyFileSync(FETCH_SCRIPT, neutralScriptPath);
  }
  return neutralScriptPath;
}

/**
 * Run the fetch script for real against a local zip.
 * @param {object} o
 * @param {string} o.zip fixture zip path
 * @param {string} o.sha expected inner sha256 override (computed by the caller)
 * @param {object} [o.env] extra env
 */
function runFetch({ zip, sha, env = {}, retries = 1 }) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-r1-fetch-'));
  const r = spawnSync('sh', [getNeutralFetchScript(), dest], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      TUN2SOCKS_PIN_FILE: PIN_FILE,
      TUN2SOCKS_URL: `file://${zip}`,
      TUN2SOCKS_SHA256: sha,
      TUN2SOCKS_FETCH_RETRIES: String(retries),
      TUN2SOCKS_RETRY_SLEEP: '0',
      ...env,
    },
  });
  return { r, dest, out: `${r.stdout}\n${r.stderr}` };
}

// ---------------------------------------------------------------------------
// Pin consistency (shell file ↔ JS constant)
// ---------------------------------------------------------------------------

test('t2s pin: tun2socks.env and TUN2SOCKS_PIN agree (single source of truth, two mirrors)', () => {
  const pin = readPin();
  assert.ok(pin.TUN2SOCKS_VERSION, 'pin file has a version');
  assert.equal(pin.TUN2SOCKS_VERSION, TUN2SOCKS_PIN.version);
  assert.equal(pin.TUN2SOCKS_ASSET, TUN2SOCKS_PIN.asset);
  assert.equal(pin.TUN2SOCKS_INNER_FILE, TUN2SOCKS_PIN.innerFile);
  assert.equal(pin.TUN2SOCKS_SHA256, TUN2SOCKS_PIN.sha256);
  assert.equal(TUN2SOCKS_PIN.url, tun2socksAssetUrl(pin.TUN2SOCKS_VERSION, pin.TUN2SOCKS_ASSET));
  assert.match(TUN2SOCKS_PIN.sha256, /^[a-f0-9]{64}$/);
  // the R0-verified digest (docs/audits/repair-baseline.md §5.2)
  assert.equal(TUN2SOCKS_PIN.sha256, '98d545a663b790b4a4100d0c796e1d43d82c5442efdb6e9c4d82e2e32e99c031');
});

test("t2s pin: no floating 'latest' anywhere in the pin file (non-comment) or derived URL", () => {
  const codeLines = fs.readFileSync(PIN_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).join('\n');
  assert.ok(!/latest/i.test(codeLines), `no 'latest' in pin assignments: ${codeLines}`);
  assert.ok(!/latest/i.test(TUN2SOCKS_PIN.url));
});

// ---------------------------------------------------------------------------
// fetch-tun2socks.sh — real execution against committed fixtures (hermetic)
// ---------------------------------------------------------------------------

test('t2s fetch: happy path — download, unzip, sha256 OK, ELF OK → 0755 staged output', (t) => {
  const zip = path.join(FIXTURES, 't2s-fixture-good.zip');
  // compute the fixture's real inner sha (unzip once)
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-r1-probe-'));
  t.after(() => fs.rmSync(probe, { recursive: true, force: true }));
  assert.equal(spawnSync('unzip', ['-o', '-j', '-q', zip, '-d', probe], { encoding: 'utf8' }).status, 0);
  const innerSha = sha256File(path.join(probe, TUN2SOCKS_PIN.innerFile));

  const { r, dest } = runFetch({ zip, sha: innerSha });
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  assert.equal(r.status, 0, `fetch must succeed: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /tun2socks-fetch: OK version=2\.7\.0/);
  const staged = path.join(dest, 'tun2socks');
  assert.ok(fs.existsSync(staged), 'staged output exists');
  assert.equal(sha256File(staged), innerSha, 'staged output = verified inner binary');
  assert.equal(fs.statSync(staged).mode & 0o777, 0o755, 'staged output is 0755 (mode must survive COPY)');
});

test('t2s fetch: sha256 mismatch → fail fast, no staged output', (t) => {
  const zip = path.join(FIXTURES, 't2s-fixture-good.zip');
  const { r, dest } = runFetch({ zip, sha: '0'.repeat(64) });
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  assert.notEqual(r.status, 0, 'must fail');
  assert.match(r.stderr, /sha256 mismatch/);
  assert.ok(!fs.existsSync(path.join(dest, 'tun2socks')), 'no staged output on checksum failure');
});

test('t2s fetch: non-ELF payload (valid sha) → fail fast with format diagnosis', (t) => {
  const zip = path.join(FIXTURES, 't2s-fixture-bad-magic.zip');
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-r1-probe-'));
  t.after(() => fs.rmSync(probe, { recursive: true, force: true }));
  assert.equal(spawnSync('unzip', ['-o', '-j', '-q', zip, '-d', probe], { encoding: 'utf8' }).status, 0);
  const { r, dest } = runFetch({ zip, sha: sha256File(path.join(probe, TUN2SOCKS_PIN.innerFile)) });
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  assert.notEqual(r.status, 0, 'must fail');
  assert.match(r.stderr, /not an ELF/);
});

test('t2s fetch: wrong-arch ELF (x86-32 header, valid sha) → fail fast with arch diagnosis', (t) => {
  const zip = path.join(FIXTURES, 't2s-fixture-wrong-arch.zip');
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-r1-probe-'));
  t.after(() => fs.rmSync(probe, { recursive: true, force: true }));
  assert.equal(spawnSync('unzip', ['-o', '-j', '-q', zip, '-d', probe], { encoding: 'utf8' }).status, 0);
  const { r, dest } = runFetch({ zip, sha: sha256File(path.join(probe, TUN2SOCKS_PIN.innerFile)) });
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  assert.notEqual(r.status, 0, 'must fail');
  assert.match(r.stderr, /not an x86-64 ELF/);
});

test('t2s fetch: archive without the expected inner file → fail fast', (t) => {
  const zip = path.join(FIXTURES, 't2s-fixture-no-inner.zip');
  const { r, dest } = runFetch({ zip, sha: '0'.repeat(64) });
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  assert.notEqual(r.status, 0, 'must fail');
  assert.match(r.stderr, /not found in archive/);
});

test('t2s fetch: download failure → bounded retries then failure (retry cap honored)', (t) => {
  const { r, dest } = runFetch({ zip: path.join(FIXTURES, 'does-not-exist.zip'), sha: '0'.repeat(64), retries: 2 });
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  assert.notEqual(r.status, 0, 'must fail');
  assert.match(r.stderr, /download failed after 2 attempt\(s\)/);
  assert.match(r.stderr, /attempt 1\/2 failed, retrying/);
});

test("t2s fetch: floating 'latest' URL is refused before any network use", (t) => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-r1-fetch-'));
  const r = spawnSync('sh', [getNeutralFetchScript(), dest], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TUN2SOCKS_PIN_FILE: PIN_FILE,
      TUN2SOCKS_URL: 'https://github.com/xjasonlyu/tun2socks/releases/download/latest/tun2socks-linux-amd64.zip',
    },
  });
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  assert.notEqual(r.status, 0, 'must refuse');
  assert.match(r.stderr, /floating 'latest'/);
});
