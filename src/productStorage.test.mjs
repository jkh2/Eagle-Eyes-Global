import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readMigratedStorage,
  writeProductStorage,
} from './productStorage.js';

function fakeStorage(entries = []) {
  const values = new Map(entries);
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    values,
  };
}

test('imports a legacy value once, then ignores later legacy writes', () => {
  const storage = fakeStorage([['godsEyeView.setting', 'legacy']]);

  assert.equal(
    readMigratedStorage(
      'eagleEyesGlobal.setting',
      ['godsEyeView.setting'],
      storage,
    ),
    'legacy',
  );
  assert.equal(storage.values.get('eagleEyesGlobal.setting'), 'legacy');

  storage.setItem('godsEyeView.setting', 'changed-by-old-install');
  assert.equal(
    readMigratedStorage(
      'eagleEyesGlobal.setting',
      ['godsEyeView.setting'],
      storage,
    ),
    'legacy',
  );
});

test('new namespace wins and writes never flow back to the legacy key', () => {
  const storage = fakeStorage([
    ['eagleEyesGlobal.setting', 'current'],
    ['godsEyeView.setting', 'legacy'],
  ]);

  assert.equal(
    readMigratedStorage(
      'eagleEyesGlobal.setting',
      ['godsEyeView.setting'],
      storage,
    ),
    'current',
  );
  writeProductStorage('eagleEyesGlobal.setting', 'next', storage);
  assert.equal(storage.values.get('eagleEyesGlobal.setting'), 'next');
  assert.equal(storage.values.get('godsEyeView.setting'), 'legacy');
});
