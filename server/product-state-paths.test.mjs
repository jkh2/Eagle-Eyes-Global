import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  resolveProductStateDir,
  STATE_DIRS,
} from './product-state-paths.js';

function fakeFilesystem(existing, { refuseRename = false } = {}) {
  const paths = new Set(existing);
  return {
    paths,
    existsSync: (candidate) => paths.has(candidate),
    renameSync(from, to) {
      if (refuseRename) throw new Error('read-only');
      paths.delete(from);
      paths.add(to);
    },
  };
}

test('migrates a legacy cache directory once and makes the new name canonical', () => {
  const root = path.resolve('fixture-root');
  const legacy = path.join(root, STATE_DIRS.cache.legacy);
  const current = path.join(root, STATE_DIRS.cache.current);
  const filesystem = fakeFilesystem([legacy]);

  assert.equal(resolveProductStateDir(root, 'cache', filesystem), current);
  assert.equal(filesystem.paths.has(legacy), false);
  assert.equal(filesystem.paths.has(current), true);
});

test('never lets a later legacy directory override an existing new namespace', () => {
  const root = path.resolve('fixture-root');
  const legacy = path.join(root, STATE_DIRS.logs.legacy);
  const current = path.join(root, STATE_DIRS.logs.current);
  const filesystem = fakeFilesystem([legacy, current]);

  assert.equal(resolveProductStateDir(root, 'logs', filesystem), current);
  assert.equal(filesystem.paths.has(legacy), true);
});

test('never writes back to the legacy state path when migration is denied', () => {
  const root = path.resolve('fixture-root');
  const legacy = path.join(root, STATE_DIRS.cache.legacy);
  const current = path.join(root, STATE_DIRS.cache.current);
  const filesystem = fakeFilesystem([legacy], { refuseRename: true });

  assert.equal(resolveProductStateDir(root, 'cache', filesystem), current);
  assert.equal(filesystem.paths.has(legacy), true);
  assert.equal(filesystem.paths.has(current), false);
});
