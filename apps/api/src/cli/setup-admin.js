#!/usr/bin/env node
/**
 * setup:admin — bootstrap the FIRST administrator (施工 MD §13.2/§14).
 *
 *  - Refuses to run when any user already exists (first admin only).
 *  - Interactive: username + password (typed twice). Password input is
 *    hidden on a TTY; piped input (`printf 'u\np\np\n' | ...`) works for
 *    `docker compose exec -T`.
 *  - argon2id hashing with an immediate verify round-trip.
 *  - Never prints the password or hash.
 *
 * Usage (compose, canonical):
 *   sg docker -c 'docker compose exec api node apps/api/src/cli/setup-admin.js'
 * Usage (local dev against a running DB):
 *   npm run setup:admin
 */
import process from 'node:process';
import argon2 from '@node-rs/argon2';

const { argon2id, hash, verify } = argon2;

import { loadConfig } from '../config.js';
import { createDb, closeDb } from '../plugins/db.js';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LEN = 12;
const MAX_ATTEMPTS = 3;

function readLine(prompt, { echo = true } = {}) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);

    // Non-interactive (piped) path: read one line per call.
    if (!stdin.isTTY) {
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('utf8');
        const idx = buffer.indexOf('\n');
        if (idx === -1) return;
        const line = buffer.slice(0, idx);
        stdin.off('data', onData);
        stdin.off('end', onEnd);
        resolve(line);
      };
      const onEnd = () => {
        if (buffer.length > 0) resolve(buffer.replace(/\n+$/, ''));
        else reject(new Error('no input provided'));
      };
      stdin.on('data', onData);
      stdin.on('end', onEnd);
      return;
    }

    // TTY path: raw mode, hidden input (optional echo as •).
    stdin.setRawMode(true);
    stdin.resume();
    let out = '';
    const onKey = (data) => {
      const key = data.toString('utf8');
      if (key === '\r' || key === '\n') {
        stdin.off('data', onKey);
        stdin.setRawMode(false);
        process.stdout.write('\n');
        resolve(out);
      } else if (key === '\u007f' || key === '\b') {
        out = out.slice(0, -1);
        if (echo) process.stdout.write('\b \b');
      } else if (key.length === 1 && key >= ' ') {
        out += key;
        if (echo) process.stdout.write('•');
      }
    };
    stdin.on('data', onKey);
  });
}

function validateUsername(value) {
  if (!USERNAME_RE.test(value)) {
    return '3-32 chars; letters, digits, underscore, dot, hyphen only';
  }
  return null;
}

function validatePassword(value) {
  if (value.length < MIN_PASSWORD_LEN) return `at least ${MIN_PASSWORD_LEN} characters`;
  if (value.length > 128) return 'at most 128 characters';
  if (!/[a-zA-Z]/.test(value) || !/\d/.test(value)) return 'must contain letters and digits';
  return null;
}

async function promptValidated(prompt, validator, { echo = true } = {}) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const value = await readLine(prompt, { echo });
    const problem = validator(value);
    if (!problem) return value;
    process.stdout.write(`  ✖ ${problem} (attempt ${attempt}/${MAX_ATTEMPTS})\n`);
  }
  throw new Error('input validation failed after 3 attempts');
}

async function main() {
  const config = loadConfig();
  process.stdout.write('water_army — first-admin bootstrap\n');
  process.stdout.write(`Database: ${config.databaseUrl.replace(/:([^:@/]+)@/, ':***@')}\n`);

  const db = await createDb(config);
  try {
    const existing = await db.user.count();
    if (existing > 0) {
      throw new Error(
        `refusing to create: ${existing} user(s) already exist. setup:admin only creates the FIRST admin.`,
      );
    }

    const username = await promptValidated('Username: ', validateUsername);

    let password;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const first = await readLine('Password: ', { echo: false });
      const second = await readLine('Confirm password: ', { echo: false });
      if (validatePassword(first)) {
        process.stdout.write(`  ✖ ${validatePassword(first)}\n`);
        continue;
      }
      if (first !== second) {
        process.stdout.write('  ✖ passwords do not match\n');
        continue;
      }
      password = first;
      break;
    }
    if (!password) throw new Error('password input failed after 3 attempts');

    const passwordHash = await hash(password, {
      type: argon2id,
      memoryCost: 19_456, // 19 MiB
      timeCost: 2,
      parallelism: 1,
    });
    if (!(await verify(passwordHash, password))) {
      throw new Error('argon2 self-check failed — refusing to create user');
    }

    await db.user.create({
      data: { username, passwordHash, role: 'admin', isActive: true },
    });

    process.stdout.write('');
    process.stdout.write(`✔ admin '${username}' created (argon2id, role=admin).\n`);
    process.stdout.write(`  Sign in at: ${config.publicUrl}\n`);
    process.stdout.write('  This CLI will not run again (first admin only).\n');
  } finally {
    await closeDb(db);
  }
}

main().catch((err) => {
  // Never include secrets in the failure message (password is not in err by design).
  process.stderr.write(`setup:admin failed: ${err.message}\n`);
  process.exit(1);
});
