import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';

const STATE_DIRS = Object.freeze({
  cache: Object.freeze({ current: '.eagle-eyes-cache', legacy: '.gev-cache' }),
  logs: Object.freeze({ current: '.eagle-eyes-logs', legacy: '.gev-logs' }),
});

/**
 * Return the Eagle Eyes Global state directory, importing a legacy directory
 * once when the new namespace does not yet exist.
 *
 * If a filesystem denies the rename, the new path still wins. That can mean a
 * cold cache, but it prevents the new product from writing into a directory an
 * old installation may still own.
 */
export function resolveProductStateDir(
  root,
  kind,
  filesystem = { existsSync, renameSync },
) {
  const names = STATE_DIRS[kind];
  if (!names) throw new TypeError(`Unknown product state directory: ${kind}`);
  const current = path.join(root, names.current);
  const legacy = path.join(root, names.legacy);
  if (filesystem.existsSync(current)) return current;
  if (!filesystem.existsSync(legacy)) return current;
  try {
    filesystem.renameSync(legacy, current);
    return current;
  } catch {
    return current;
  }
}

export { STATE_DIRS };
