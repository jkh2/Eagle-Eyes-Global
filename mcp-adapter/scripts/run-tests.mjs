#!/usr/bin/env node
// Cross-platform test runner: the plain `node --test '**/*.test.mjs'` script
// silently reported "0 pass / 0 fail" (exit 0) on Windows because cmd.exe/
// npm.cmd passed the quoted glob through literally instead of expanding it —
// a false green Orion Sentinel caught in independent review (2026-09-18).
// This finds *.test.mjs files itself (no shell globbing involved on any
// platform) and hard-fails if it finds zero, so a broken discovery pattern
// can never again report a passing test suite.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function findTestFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) found.push(...findTestFiles(full));
    else if (entry.endsWith('.test.mjs')) found.push(full);
  }
  return found;
}

const files = findTestFiles(root);
if (files.length === 0) {
  console.error('run-tests.mjs: discovered ZERO *.test.mjs files — this is a failure, not a clean pass.');
  process.exit(1);
}

console.log(`run-tests.mjs: running ${files.length} test file(s):`);
for (const f of files) console.log(`  ${f}`);

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
