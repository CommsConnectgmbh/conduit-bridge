// Owner-only file modes for everything the bridge keeps about its user: the
// chat database, pasted files and logs. Node creates files with the process
// umask (usually 022, so 0755 directories and 0644 files), which on a shared
// machine lets other local accounts read them. The bridge cannot change its
// umask instead, because agent CLIs inherit it and would then create 0600
// files in the user's projects.
//
// Both helpers also correct paths that already exist, so an install created by
// an older version is tightened on the next start. Errors are swallowed: on
// Windows chmod only toggles the read-only bit, and a path we cannot chmod is
// not a reason to refuse to start.

import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Create `dir` (and parents) if needed and make `dir` itself 0700. */
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try { chmodSync(dir, PRIVATE_DIR_MODE); } catch { /* not ours, or Windows */ }
}

/** Make an existing file 0600; a missing file is fine. */
export function tightenFile(path) {
  try { if (existsSync(path)) chmodSync(path, PRIVATE_FILE_MODE); } catch { /* see above */ }
}

/** Make every regular file directly inside `dir` whose name passes `filter` 0600. */
export function tightenFilesIn(dir, filter = () => true) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isFile() && filter(e.name)) tightenFile(join(dir, e.name));
}
