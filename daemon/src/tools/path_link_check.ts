import fs from "fs-extra";
import path from "path";

/**
 * Resolves the real absolute path by walking backwards from the target to
 * find the deepest existing ancestor, then calling realpathSync on it and
 * appending the non-existent tail segments.
 *
 * Returns null if realpathSync fails on the existing ancestor.
 */
export function resolveRealPath(absolutePath: string): string | null {
  let dir = path.resolve(absolutePath);
  const root = path.parse(dir).root;
  const missed: string[] = [];

  while (true) {
    try {
      fs.lstatSync(dir);
      try {
        return path.join(fs.realpathSync(dir), ...missed);
      } catch {
        return null;
      }
    } catch {
      if (dir === root) return null;
      missed.unshift(path.basename(dir));
      dir = path.dirname(dir);
    }
  }
}

/**
 * Canonical spelling of a path, for callers that compare paths or use them as map keys.
 *
 * Two normalisations, both required for "one directory has exactly one spelling":
 *   1. resolve, not normalize — normalize keeps a trailing separator, so `/a/b/` and `/a/b`
 *      would yield two different strings for the same directory;
 *   2. realpath — a symlink gives a directory a second path, whether it is the leaf
 *      (`<root>/alias` -> `<root>/r1`) or an ancestor (`/data` -> `/mnt/data`).
 *
 * The only difference from resolveRealPath is that this never returns null: when the path
 * cannot be resolved it falls back to the literal resolve rather than propagating "no answer".
 * Callers here need a string they can compare; a null would force a branch at every call site,
 * and every such branch is another chance for one directory to acquire two spellings.
 *
 * resolveRealPath keeps its null contract untouched — system_file.ts relies on it to decide a
 * path is untrustworthy, which is a different question from "what do we call this directory".
 */
export function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  return resolveRealPath(resolved) ?? resolved;
}
