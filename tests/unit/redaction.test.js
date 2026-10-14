/**
 * Secret redaction tests (施工 MD §16.1 / §13.3):
 *  - PINO_REDACT_PATHS covers the real secret fields
 *  - a pino logger configured exactly like apps/api (same paths + censor)
 *    redacts top-level and nested secrets, including req.headers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { PINO_REDACT_PATHS } from '@water-army/shared';

const SECRETS = {
  authorization: 'Bearer top-secret-token-123',
  cookie: 'session=cookie-secret-abc',
  'x-api-key': 'sk-live-abc123',
  password: 'hunter2password',
  apiKey: 'sk-live-top',
  token: 'raw-token-xyz',
};

function collectLogger() {
  const lines = [];
  const stream = { write: (line) => lines.push(line) };
  const logger = pino({ redact: { paths: [...PINO_REDACT_PATHS], censor: '***' }, level: 'info' }, stream);
  return { logger, lines };
}

test('PINO_REDACT_PATHS covers the known secret fields', () => {
  for (const key of [
    'password',
    'apiKey',
    'token',
    '*.password',
    '*.apiKey',
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers.x-api-key',
  ]) {
    assert.ok(PINO_REDACT_PATHS.includes(key), `missing redact path: ${key}`);
  }
});

test('top-level secrets are redacted', () => {
  const { logger, lines } = collectLogger();
  logger.info({ password: SECRETS.password, apiKey: SECRETS.apiKey, token: SECRETS.token }, 'login attempt');
  const out = lines.join('');
  assert.ok(!out.includes(SECRETS.password));
  assert.ok(!out.includes(SECRETS.apiKey));
  assert.ok(!out.includes(SECRETS.token));
  assert.ok(out.includes('***'), 'censor marker present');
  // non-secret context survives
  assert.ok(out.includes('login attempt'));
});

test('nested secrets are redacted (user.apiKey etc.)', () => {
  const { logger, lines } = collectLogger();
  logger.info({ user: { username: 'admin', apiKey: SECRETS.apiKey, password: SECRETS.password } }, 'user event');
  const out = lines.join('');
  assert.ok(!out.includes(SECRETS.apiKey));
  assert.ok(!out.includes(SECRETS.password));
  assert.ok(out.includes('admin'), 'benign nested fields survive');
});

test('request headers are redacted (authorization / cookie / x-api-key)', () => {
  const { logger, lines } = collectLogger();
  logger.info(
    { req: { method: 'POST', url: '/api/auth/login', headers: { authorization: SECRETS.authorization, cookie: SECRETS.cookie, 'x-api-key': SECRETS['x-api-key'] } } },
    'request',
  );
  const out = lines.join('');
  assert.ok(!out.includes(SECRETS.authorization));
  assert.ok(!out.includes(SECRETS.cookie));
  assert.ok(!out.includes(SECRETS['x-api-key']));
  assert.ok(out.includes('***'));
});

test('the app actually uses these paths (app.js wiring)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../apps/api/src/app.js', import.meta.url), 'utf8');
  assert.match(src, /PINO_REDACT_PATHS/);
  assert.match(src, /censor:\s*'\*\*\*'/);
});
