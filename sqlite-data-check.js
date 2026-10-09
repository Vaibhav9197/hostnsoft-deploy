/**
 * sqlite-data-check.js — the part of the activator's wake-time data check
 * that knows what a SQLite checkpoint looks like. Separate file so it can
 * be tested without starting the activator's listener.
 */
const fsp = require('fs/promises');

// SQLite files are recognised by their header, not their name: apps call
// them .db, .sqlite, .sqlite3 or nothing at all.
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

async function isSqliteFile(fullPath) {
  let fh;
  try {
    fh = await fsp.open(fullPath, 'r');
    const buf = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return bytesRead === buf.length && buf.equals(SQLITE_HEADER);
  } catch {
    return false;
  } finally {
    if (fh) await fh.close();
  }
}

/**
 * Decide whether a manifest entry's change is a CHECKPOINT or a LOSS.
 *
 * Litestream (and SQLite itself on a clean close) folds the write-ahead
 * log into the main database file. That is the only legitimate thing
 * that touches a stopped app's data, and it looks like this: the main
 * file grows or stays the same, the -wal shrinks, is emptied or is
 * deleted, and the -shm is rewritten. Before this function existed every
 * one of those tripped the size check and the app could never wake again
 * after Litestream's first pass over APP_DATA_ROOT.
 *
 * Still a failure: any non-SQLite file that is missing or changed, a main
 * database file that is missing or SMALLER than at stop time, and a -wal
 * or -shm whose main database is not a SQLite file at all (then there is
 * no checkpoint story and the generic rule applies).
 *
 * Residual gap, stated plainly: a -wal deleted WITHOUT a checkpoint loses
 * the last writes and this cannot tell that apart from a clean one.
 * Litestream itself is the backstop for that case — it ships the WAL to
 * S3 continuously, which is the whole reason it opens these files.
 *
 * Returns null when fine, else a problem string. `sqliteMains` is the set
 * of manifest paths whose on-disk file has a SQLite header.
 */
function manifestEntryProblem(f, actual, sqliteMains) {
  const present = actual.has(f.path);
  const size = actual.get(f.path);
  const m = f.path.match(/^(.*)-(wal|shm)$/);
  if (m && sqliteMains.has(m[1])) {
    // Side file of a SQLite database: any size, present or not, is a
    // state a checkpoint can leave behind.
    return null;
  }
  if (!present) return `missing: ${f.path} (was ${f.bytes} bytes)`;
  if (sqliteMains.has(f.path)) {
    if (size < f.bytes) return `sqlite shrank: ${f.path} ${f.bytes} -> ${size}`;
    return null; // same or grown — a checkpoint, not a loss
  }
  if (size !== f.bytes) return `size changed: ${f.path} ${f.bytes} -> ${size}`;
  return null;
}

module.exports = { isSqliteFile, manifestEntryProblem, SQLITE_HEADER };
