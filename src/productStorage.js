/**
 * Read a product-owned value from the Eagle Eyes Global namespace.
 *
 * A legacy key is imported only when the new key does not exist. The imported
 * value is copied forward once; later legacy writes cannot keep feeding the new
 * shell, and Eagle Eyes Global never writes back into the old namespace. Copy
 * failure deliberately propagates instead of returning the legacy value: new
 * code must not run from state that still belongs only to an old installation.
 */
export function readMigratedStorage(currentKey, legacyKeys = [], storage) {
  const target = storage === undefined ? globalThis.localStorage : storage;
  if (!target?.getItem) return null;
  const current = target.getItem(currentKey);
  if (current !== null) return current;

  for (const legacyKey of legacyKeys) {
    const legacy = target.getItem(legacyKey);
    if (legacy === null) continue;
    if (!target.setItem)
      throw new TypeError('Storage migration requires setItem');
    target.setItem(currentKey, legacy);
    return legacy;
  }
  return null;
}

/** Write only to the Eagle Eyes Global namespace. */
export function writeProductStorage(currentKey, value, storage) {
  const target = storage === undefined ? globalThis.localStorage : storage;
  if (!target?.setItem) throw new TypeError('Storage write requires setItem');
  target.setItem(currentKey, value);
}
