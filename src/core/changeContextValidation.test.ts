import { afterEach, describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHANGE_CONTEXT_DIR } from "./changeContextResolution";
import {
  renderChangeContextValidationText,
  validateChangeContextAgainstChangeset,
  validateChangeContextCommand,
  type ChangeContextValidationIssue,
} from "./changeContextValidation";
import { buildDiffFile } from "./diffFile";
import type { Changeset } from "./types";

const tempDirs: string[] = [];

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function createTempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function jj(cwd: string, ...cmd: string[]) {
  const proc = Bun.spawnSync(
    [
      "jj",
      "--config",
      "signing.behavior=drop",
      "--config",
      'user.name="Test User"',
      "--config",
      "user.email=test@example.com",
      ...cmd,
    ],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );

  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr).toString("utf8");
    throw new Error(stderr.trim() || `jj ${cmd.join(" ")} failed`);
  }

  return Buffer.from(proc.stdout).toString("utf8");
}

function createTempJjRepo(prefix: string) {
  const dir = createTempDir(prefix);
  jj(tmpdir(), "git", "init", "--colocate", dir);
  writeFileSync(join(dir, "example.ts"), "export const value = 1;\n");
  return dir;
}

function currentChangeId(repo: string) {
  return jj(repo, "log", "--no-graph", "-r", "@", "-T", 'change_id ++ "\\n"').trim();
}

function createValidationChangeset(): Changeset {
  const oldLines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[9] = "line 10 changed";
  newLines[29] = "line 30 changed";
  newLines.splice(49, 0, "line inserted");
  newLines.splice(70, 1);

  const metadata = parseDiffFromFile(
    { name: "app.ts", contents: `${oldLines.join("\n")}\n` },
    { name: "app.ts", contents: `${newLines.join("\n")}\n` },
    { context: 3 },
    true,
  );
  const file = buildDiffFile(metadata, "", 0, "test", null);

  return {
    id: "changeset:test",
    sourceLabel: "test",
    title: "test changeset",
    files: [file],
  };
}

function validateDocument(document: {
  changeId?: string;
  files: Array<{
    path: string;
    summary?: string;
    annotations: Array<{
      summary?: string;
      oldRange?: [number, number];
      newRange?: [number, number];
      sawOldRange?: boolean;
      sawNewRange?: boolean;
    }>;
  }>;
}) {
  const normalized = {
    ...document,
    files: document.files.map((file) => ({
      ...file,
      annotations: file.annotations.map((annotation) => ({
        ...annotation,
        sawOldRange: annotation.sawOldRange ?? annotation.oldRange !== undefined,
        sawNewRange: annotation.sawNewRange ?? annotation.newRange !== undefined,
      })),
    })),
  };
  const issues: ChangeContextValidationIssue[] = [];
  validateChangeContextAgainstChangeset(normalized, createValidationChangeset(), issues);
  return issues;
}

afterEach(() => {
  cleanupTempDirs();
});

const jjTest = Bun.which("jj") ? test : test.skip;

describe("change context validation", () => {
  test("valid context passes", () => {
    const issues = validateDocument({
      files: [
        {
          path: "app.ts",
          summary: "Updates app behavior.",
          annotations: [{ summary: "Changed line", newRange: [10, 10] }],
        },
      ],
    });

    expect(issues).toEqual([]);
  });

  test("missing file reports an issue", () => {
    const issues = validateDocument({
      files: [{ path: "missing.ts", annotations: [{ summary: "Missing", newRange: [10, 10] }] }],
    });

    expect(issues).toMatchObject([
      {
        severity: "error",
        code: "missing-file",
        file: "missing.ts",
      },
    ]);
  });

  test("range outside all hunks fails with nearest-hunk suggestion", () => {
    const issues = validateDocument({
      files: [{ path: "app.ts", annotations: [{ summary: "Stale", newRange: [90, 90] }] }],
    });

    expect(issues).toMatchObject([
      {
        code: "range-outside-hunks",
        rangeKind: "newRange",
        range: [90, 90],
        suggestedRange: [68, 73],
      },
    ]);
  });

  test("range that overlaps a hunk but starts outside fails with hunk suggestion", () => {
    const issues = validateDocument({
      files: [{ path: "app.ts", annotations: [{ summary: "Wide", newRange: [5, 10] }] }],
    });

    expect(issues).toMatchObject([
      {
        code: "range-start-outside-hunk",
        rangeKind: "newRange",
        range: [5, 10],
        suggestedRange: [7, 13],
      },
    ]);
  });

  test("range crossing multiple hunks fails", () => {
    const issues = validateDocument({
      files: [{ path: "app.ts", annotations: [{ summary: "Too wide", newRange: [10, 30] }] }],
    });

    expect(issues).toMatchObject([
      {
        code: "range-crosses-hunks",
        rangeKind: "newRange",
        range: [10, 30],
        suggestedRange: [7, 13],
      },
    ]);
  });

  test("added-only and deleted-only side mismatches fail", () => {
    const issues = validateDocument({
      files: [
        {
          path: "app.ts",
          annotations: [
            { summary: "Added hunk on old side", oldRange: [50, 50] },
            { summary: "Deleted hunk on new side", newRange: [70, 70] },
          ],
        },
      ],
    });

    expect(issues).toMatchObject([
      {
        code: "range-side-mismatch",
        annotationIndex: 0,
        rangeKind: "oldRange",
      },
      {
        code: "range-side-mismatch",
        annotationIndex: 1,
        rangeKind: "newRange",
      },
    ]);
  });

  test("annotations require at least one range", () => {
    const issues = validateDocument({
      files: [{ path: "app.ts", annotations: [{ summary: "No range" }] }],
    });

    expect(issues).toMatchObject([
      {
        code: "missing-annotation-range",
        file: "app.ts",
        annotationIndex: 0,
      },
    ]);
  });

  test("plain mode renders concise nonzero-style failure text", () => {
    const text = renderChangeContextValidationText({
      ok: false,
      path: ".hunk/change-context/id.json",
      changeId: "id",
      issues: [
        {
          severity: "error",
          code: "range-start-outside-hunk",
          file: "app.ts",
          annotationIndex: 3,
          rangeKind: "newRange",
          range: [5, 10],
          message: "newRange starts outside the changed hunk it overlaps.",
          suggestedRange: [7, 13],
        },
      ],
    });

    expect(text).toContain("Change Context validation failed: .hunk/change-context/id.json");
    expect(text).toContain(
      "- app.ts annotation 3 newRange 5-10 newRange starts outside the changed hunk it overlaps; suggested 7-13.",
    );
  });

  jjTest("missing context file fails clearly", async () => {
    const repo = createTempJjRepo("hunk-change-context-validate-missing-");
    const result = await validateChangeContextCommand(
      {
        kind: "change-context-validate",
        rev: "@",
        commandKind: "diff",
        strict: true,
        output: "json",
      },
      { cwd: repo, env: { HOME: createTempDir("hunk-change-context-home-") } },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toMatchObject([{ code: "missing-context-file" }]);
  });

  jjTest("malformed JSON fails clearly", async () => {
    const repo = createTempJjRepo("hunk-change-context-validate-json-");
    const changeId = currentChangeId(repo);
    mkdirSync(join(repo, DEFAULT_CHANGE_CONTEXT_DIR), { recursive: true });
    writeFileSync(join(repo, DEFAULT_CHANGE_CONTEXT_DIR, `${changeId}.json`), "{not json");

    const result = await validateChangeContextCommand(
      {
        kind: "change-context-validate",
        rev: "@",
        commandKind: "diff",
        strict: true,
        output: "json",
      },
      { cwd: repo, env: { HOME: createTempDir("hunk-change-context-home-") } },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toMatchObject([{ code: "malformed-json" }]);
  });

  jjTest("mismatched change id reports an issue", async () => {
    const repo = createTempJjRepo("hunk-change-context-validate-mismatch-");
    const changeId = currentChangeId(repo);
    mkdirSync(join(repo, DEFAULT_CHANGE_CONTEXT_DIR), { recursive: true });
    writeFileSync(
      join(repo, DEFAULT_CHANGE_CONTEXT_DIR, `${changeId}.json`),
      JSON.stringify({
        version: 1,
        change: { vcs: "jj", key: "jj-change-id", id: "different" },
        files: [],
      }),
    );

    const result = await validateChangeContextCommand(
      {
        kind: "change-context-validate",
        rev: "@",
        commandKind: "diff",
        strict: true,
        output: "json",
      },
      { cwd: repo, env: { HOME: createTempDir("hunk-change-context-home-") } },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toMatchObject([{ code: "change-id-mismatch" }]);
  });
});
