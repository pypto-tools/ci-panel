import fs from "fs-extra";
import path from "path";
import { describe, expect, it } from "vitest";
import { DAEMON_ROOT, REPO_ROOT } from "../setup";

// i18next returns the key itself when a key is missing, so a typo or a forgotten catalogue entry
// does not fail anywhere — it reaches the user as the literal string "TXT_CODE_...". The
// catalogue spec in common compares the translations against each other and says in its own
// header that it does not look at call sites; this is that missing gate.
//
// It was not written speculatively: two keys shipped without catalogue entries and were found by
// hand, one of them on the error path an un-upgraded panel takes.

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && e.name.endsWith(".ts") ? [full] : [];
  });

// Only literal keys can be checked; a computed key is invisible here either way.
const CALL = /\$t\(\s*"(TXT_CODE_[A-Za-z0-9_.]+)"/g;

// Inherited from upstream MCSManager, missing before this fork existed. Listed rather than
// counted so the edit is a reviewable declaration; delete a line once the key is added.
const KNOWN_MISSING = ["TXT_CODE_app.forcedShutdown"];

describe("every key the daemon asks for exists in the source catalogue", () => {
  const catalogue = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "languages/en_US.json"), "utf8")
  ) as Record<string, string>;

  const used = new Map<string, string>(); // key -> first file that asks for it
  for (const file of walk(path.join(DAEMON_ROOT, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(CALL))
      if (!used.has(m[1])) used.set(m[1], path.relative(DAEMON_ROOT, file));
  }

  it("finds the call sites at all", () => {
    // Guards against the regex silently matching nothing after a refactor.
    expect(used.size).toBeGreaterThan(50);
  });

  it("has a catalogue entry for each", () => {
    const missing = [...used]
      .filter(([key]) => !(key in catalogue) && !KNOWN_MISSING.includes(key))
      .map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  it("keeps the known-missing list honest", () => {
    // A key that got added to the catalogue should leave this list, or it hides a future miss.
    for (const key of KNOWN_MISSING) expect(catalogue[key], key).toBeUndefined();
  });
});
