import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { archLabel, defaultRunnerLabels, FALLBACK_ARCH_LABEL } from "../runnerLabels";

// The prefilled labels decide which machines a workflow's `runs-on` can land on. Getting them
// wrong is invisible: the runner registers and goes online, it just never matches a job it can
// actually run. So the default has to follow the selected node's architecture.

describe("archLabel", () => {
  it("passes through the values os.arch() actually reports", () => {
    expect(archLabel("x64")).toBe("x64");
    expect(archLabel("arm64")).toBe("arm64");
    expect(archLabel("arm")).toBe("arm");
  });

  it("normalises the uname / docker spellings of the same architectures", () => {
    expect(archLabel("x86_64")).toBe("x64");
    expect(archLabel("amd64")).toBe("x64");
    expect(archLabel("aarch64")).toBe("arm64");
  });

  it("lowercases and trims", () => {
    expect(archLabel(" X64 ")).toBe("x64");
    expect(archLabel("ARM64")).toBe("arm64");
  });

  it("falls back when the node reports no architecture", () => {
    for (const input of [undefined, "", "   "]) {
      expect(archLabel(input), JSON.stringify(input)).toBe(FALLBACK_ARCH_LABEL);
    }
  });

  it("falls back to arm64 specifically", () => {
    // Asserted against the literal, not the constant: the compat contract is "keep what the
    // dialog prefilled before `arch` existed on the wire", and a daemon older than the panel
    // still reports nothing. Comparing the constant to itself would leave that unpinned.
    expect(FALLBACK_ARCH_LABEL).toBe("arm64");
  });

  it("shows an unrecognised architecture as reported instead of guessing", () => {
    expect(archLabel("ppc64")).toBe("ppc64");
  });
});

describe("defaultRunnerLabels", () => {
  it("pairs linux with the node architecture", () => {
    // linux is fixed: provisioning is systemd plus an actions-runner-linux-* package.
    expect(defaultRunnerLabels("x64")).toBe("linux,x64");
    expect(defaultRunnerLabels("aarch64")).toBe("linux,arm64");
    expect(defaultRunnerLabels("")).toBe("linux,arm64");
  });
});

describe("AddRunnerDialog wiring", () => {
  // The bug this module fixes was a string literal in the dialog. Nothing above would catch its
  // return, so pin the call site too.
  const DIALOG = path.resolve(__dirname, "../../widgets/AddRunnerDialog.vue");
  const source = fs.readFileSync(DIALOG, "utf8");

  it("derives the prefilled labels from this module", () => {
    expect(source).toMatch(/from\s+"@\/tools\/runnerLabels"/);
    expect(source).toMatch(/defaultRunnerLabels\(/);
  });

  it("hardcodes no architecture as a default label, in any quote style", () => {
    expect(source).not.toMatch(/["'`]linux,\s*(x64|arm64|arm)/);
  });

  it("would catch the literal it is meant to reject", () => {
    // Guards the matcher itself: a regex that matched nothing would make the check above pass on
    // any source at all.
    const regression = 'const newGroup = (baseName = "", labels = "linux,arm64")';
    expect(regression).toMatch(/["'`]linux,\s*(x64|arm64|arm)/);
  });
});
