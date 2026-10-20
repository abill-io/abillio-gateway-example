import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNode } from './helpers.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

// No key in the environment: a server that reaches main() fails on it, and one
// that never does exits 0 without a word, which is what `npm start` did from a
// checkout reached through a symlink or under a path a URL cannot hold as is.
function assertStarts(serverTs: string, label: string) {
  const run = runNode([serverTs]);
  assert.equal(run.status, 1, `${label}: ${run.stderr}`);
  assert.match(run.stderr, /ABILLIO_API_KEY_ID is missing/, label);
}

test('server.ts starts when node is started with it through a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-start-'));
  try {
    symlinkSync(root, join(dir, 'checkout'));
    assertStarts(join(dir, 'checkout', 'server.ts'), 'through a symlink');
  } finally {
    // unlink, never a recursive remove of the link: that would follow it into the checkout.
    try { unlinkSync(join(dir, 'checkout')); } catch { /* never linked */ }
    rmdirSync(dir);
  }
});

test('server.ts starts from a checkout whose path holds #, % and [', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-start-'));
  const checkout = join(dir, 'C#', '100%', '[gw]');
  try {
    mkdirSync(checkout, { recursive: true });
    for (const part of ['server.ts', 'package.json', 'lib', 'steps', 'views']) cpSync(join(root, part), join(checkout, part), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(checkout, 'node_modules'));
    assertStarts(join(checkout, 'server.ts'), 'C#/100%/[gw]');
  } finally {
    try { unlinkSync(join(checkout, 'node_modules')); } catch { /* never linked */ }
    rmSync(dir, { recursive: true });
  }
});
