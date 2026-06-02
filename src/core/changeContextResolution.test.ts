import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHANGE_CONTEXT_DIR, resolveChangeContextPath } from "./changeContextResolution";
import type { CliInput } from "./types";

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

function createPatchInput(options: CliInput["options"] = {}): CliInput {
  return {
    kind: "patch",
    file: "change.patch",
    options,
  };
}

function createJjDiffInput(
  options: Partial<CliInput["options"]> = {},
  range?: string,
): Extract<CliInput, { kind: "vcs" }> {
  return {
    kind: "vcs",
    range,
    staged: false,
    options: {
      vcs: "jj",
      changeContextKey: "jj-change-id",
      ...options,
    },
  };
}

afterEach(() => {
  cleanupTempDirs();
});

// Keep jj-backed resolution coverage opt-in on machines with the external CLI installed.
const jjTest = Bun.which("jj") ? test : test.skip;

describe("change context resolution", () => {
  test("returns explicit context paths before convention lookup", () => {
    expect(resolveChangeContextPath(createPatchInput({ agentContext: "notes.json" }))?.path).toBe(
      "notes.json",
    );
  });

  test("returns null when discovery is not enabled", () => {
    expect(resolveChangeContextPath(createPatchInput())).toBeNull();
    expect(resolveChangeContextPath(createPatchInput({ changeContextKey: "none" }))).toBeNull();
  });

  test("silently skips jj keys for non-jj inputs", () => {
    expect(
      resolveChangeContextPath(createPatchInput({ vcs: "git", changeContextKey: "jj-change-id" })),
    ).toBeNull();
  });

  jjTest("uses the conventional directory when the jj key is enabled and dir is omitted", () => {
    const repo = createTempJjRepo("hunk-change-context-default-");
    const changeId = currentChangeId(repo);
    const contextPath = join(repo, DEFAULT_CHANGE_CONTEXT_DIR, `${changeId}.json`);
    mkdirSync(join(repo, DEFAULT_CHANGE_CONTEXT_DIR), { recursive: true });
    writeFileSync(contextPath, '{"version":1,"files":[]}\n');

    const resolved = resolveChangeContextPath(createJjDiffInput(), { cwd: repo });

    expect(resolved).toMatchObject({
      path: contextPath,
      source: "convention",
      exists: true,
      key: "jj-change-id",
      changeId,
    });
  });

  jjTest(
    "returns a missing convention candidate only when callers do not require existence",
    () => {
      const repo = createTempJjRepo("hunk-change-context-missing-");
      const changeId = currentChangeId(repo);
      const expectedPath = join(repo, DEFAULT_CHANGE_CONTEXT_DIR, `${changeId}.json`);

      expect(resolveChangeContextPath(createJjDiffInput(), { cwd: repo })).toBeNull();
      expect(
        resolveChangeContextPath(createJjDiffInput(), { cwd: repo, requireExisting: false }),
      ).toMatchObject({
        path: expectedPath,
        source: "convention",
        exists: false,
        changeId,
      });
    },
  );

  jjTest("resolves omitted jj diff ranges as the current change", () => {
    const repo = createTempJjRepo("hunk-change-context-current-");
    const changeId = currentChangeId(repo);
    const contextDir = join(repo, "context");
    const contextPath = join(contextDir, `${changeId}.json`);
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(contextPath, '{"version":1,"files":[]}\n');

    expect(
      resolveChangeContextPath(createJjDiffInput({ changeContextDir: "context" }), { cwd: repo })
        ?.path,
    ).toBe(contextPath);
  });

  jjTest("resolves show inputs with relative dirs from the repo root", () => {
    const repo = createTempJjRepo("hunk-change-context-show-");
    const child = join(repo, "nested");
    mkdirSync(child);
    const changeId = currentChangeId(repo);
    const contextPath = join(repo, "review-context", `${changeId}.json`);
    mkdirSync(join(repo, "review-context"), { recursive: true });
    writeFileSync(contextPath, '{"version":1,"files":[]}\n');

    const input = {
      kind: "show",
      ref: "@",
      options: {
        vcs: "jj",
        changeContextKey: "jj-change-id",
        changeContextDir: "review-context",
      },
    } satisfies Extract<CliInput, { kind: "show" }>;

    expect(resolveChangeContextPath(input, { cwd: child })?.path).toBe(contextPath);
  });

  jjTest("uses absolute context directories as-is", () => {
    const repo = createTempJjRepo("hunk-change-context-absolute-");
    const absoluteContextDir = createTempDir("hunk-change-context-dir-");
    const changeId = currentChangeId(repo);
    const contextPath = join(absoluteContextDir, `${changeId}.json`);
    writeFileSync(contextPath, '{"version":1,"files":[]}\n');

    expect(
      resolveChangeContextPath(createJjDiffInput({ changeContextDir: absoluteContextDir }), {
        cwd: repo,
      })?.path,
    ).toBe(contextPath);
  });

  jjTest("skips auto-discovery for revsets that resolve to multiple changes", () => {
    const repo = createTempJjRepo("hunk-change-context-multiple-");
    jj(repo, "commit", "-m", "first");
    writeFileSync(join(repo, "second.ts"), "export const second = true;\n");

    const resolved = resolveChangeContextPath(createJjDiffInput({}, "all()"), {
      cwd: repo,
      requireExisting: false,
    });

    expect(resolved).toBeNull();
    expect(existsSync(join(repo, DEFAULT_CHANGE_CONTEXT_DIR))).toBe(false);
  });
});
