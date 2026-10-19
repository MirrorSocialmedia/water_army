/**
 * URL guard (SSRF defence for provider baseUrls).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPublicHttpUrl,
  inspectHostSync,
  parseHttpUrl,
  UrlGuardError,
} from '../../apps/api/src/security/url-guard.js';

// Never hit real DNS in the suite: stub resolve.
const resolveTo = (addr, family = 4) => async () => [{ address: addr, family }];
const resolveFail = async () => {
  throw new Error('ENOTFOUND');
};

test('parseHttpUrl rejects non-http(s) and garbage', () => {
  assert.throws(() => parseHttpUrl('ftp://host/x'), UrlGuardError);
  assert.throws(() => parseHttpUrl('file:///etc/passwd'), UrlGuardError);
  assert.throws(() => parseHttpUrl('not a url'), UrlGuardError);
  assert.equal(parseHttpUrl('https://api.example.com/v1').protocol, 'https:');
});

test('inspectHostSync blocks loopback / private / link-local literals', () => {
  assert.ok(inspectHostSync('127.0.0.1'));
  assert.ok(inspectHostSync('10.1.2.3'));
  assert.ok(inspectHostSync('172.16.0.1'));
  assert.ok(inspectHostSync('192.168.1.1'));
  assert.ok(inspectHostSync('169.254.169.254')); // cloud metadata
  assert.ok(inspectHostSync('::1'));
  assert.ok(inspectHostSync('::ffff:127.0.0.1')); // IPv4-mapped IPv6
  assert.ok(inspectHostSync('localhost'));
  assert.ok(inspectHostSync('redis.internal'));
  assert.ok(inspectHostSync('db.local'));
  // public literals pass the sync check
  assert.equal(inspectHostSync('1.1.1.1'), null);
  assert.equal(inspectHostSync('api.openai.com'), null);
});

test('assertPublicHttpUrl rejects the metadata endpoint before any DNS', async () => {
  await assert.rejects(
    () => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/', { resolve: resolveFail }),
    (e) => e instanceof UrlGuardError && e.code === 'BLOCKED_URL',
  );
});

test('assertPublicHttpUrl blocks a public name that resolves to a private IP (rebinding)', async () => {
  await assert.rejects(
    () => assertPublicHttpUrl('https://evil.example.com/v1', { resolve: resolveTo('10.0.0.5') }),
    (e) => e instanceof UrlGuardError && /private/.test(e.message),
  );
});

test('assertPublicHttpUrl blocks when the name resolves to IPv4-mapped loopback', async () => {
  await assert.rejects(
    () => assertPublicHttpUrl('https://sneaky.example.com/v1', { resolve: resolveTo('::ffff:127.0.0.1', 6) }),
    UrlGuardError,
  );
});

test('assertPublicHttpUrl rejects an unresolvable host', async () => {
  await assert.rejects(
    () => assertPublicHttpUrl('https://nope.invalid/v1', { resolve: resolveFail }),
    (e) => e instanceof UrlGuardError && /could not be resolved/.test(e.message),
  );
});

test('assertPublicHttpUrl allows a public endpoint', async () => {
  const u = await assertPublicHttpUrl('https://api.openai.com/v1', { resolve: resolveTo('104.18.6.192') });
  assert.equal(u.hostname, 'api.openai.com');
});

test('assertPublicHttpUrl skips DNS for a public IP literal', async () => {
  let called = false;
  const u = await assertPublicHttpUrl('http://1.1.1.1:8000/v1', {
    resolve: async () => {
      called = true;
      return [];
    },
  });
  assert.equal(u.hostname, '1.1.1.1');
  assert.equal(called, false, 'IP literals must not trigger DNS');
});
