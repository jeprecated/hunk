import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CHANGE_CONTEXT_DIR } from "./changeContextResolution";
import { loadAppBootstrap } from "./loaders";
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

function writeChangeContext(path: string, summary: string, changeId: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        version: 1,
        summary,
        change: {
          vcs: "jj",
          key: "jj-change-id",
          id: changeId,
        },
        reviewAttention: {
          level: "high",
          summary: "Review generated rationale",
          rationale: "The loader should carry change-level review attention into the UI model.",
        },
        files: [
          {
            path: "example.ts",
            summary: `${summary} file summary`,
            annotations: [
              {
                id: "example-rationale",
                newRange: [1, 1],
                summary: "Explains the new example file.",
                rationale: "This proves convention-loaded annotations reach DiffFile.agent.",
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
}

afterEach(() => {
  cleanupTempDirs();
});

// Keep jj-backed loader coverage opt-in on machines with the external CLI installed.
const jjTest = Bun.which("jj") ? test : test.skip;

describe("loadAppBootstrap Change Context discovery", () => {
  jjTest(
    "loads annotations, summaries, and Review Attention from the conventional jj path",
    async () => {
      const repo = createTempJjRepo("hunk-loader-change-context-");
      const changeId = currentChangeId(repo);
      const contextPath = join(repo, DEFAULT_CHANGE_CONTEXT_DIR, `${changeId}.json`);
      writeChangeContext(contextPath, "Convention context", changeId);

      const bootstrap = await loadAppBootstrap(createJjDiffInput(), { cwd: repo });

      expect(bootstrap.changeset.agentSummary).toBe("Convention context");
      expect(bootstrap.changeset.reviewAttention).toEqual({
        level: "high",
        summary: "Review generated rationale",
        rationale: "The loader should carry change-level review attention into the UI model.",
      });
      expect(bootstrap.changeset.files[0]?.path).toBe("example.ts");
      expect(bootstrap.changeset.files[0]?.agent?.summary).toBe("Convention context file summary");
      expect(bootstrap.changeset.files[0]?.agent?.annotations[0]?.id).toBe("example-rationale");
    },
  );

  jjTest("resolves omitted jj diff ranges as @ when loading conventional context", async () => {
    const repo = createTempJjRepo("hunk-loader-change-context-current-");
    const changeId = currentChangeId(repo);
    const contextPath = join(repo, DEFAULT_CHANGE_CONTEXT_DIR, `${changeId}.json`);
    writeChangeContext(contextPath, "Current change context", changeId);

    const bootstrap = await loadAppBootstrap(createJjDiffInput(), { cwd: repo });

    expect(bootstrap.changeset.agentSummary).toBe("Current change context");
  });

  jjTest("explicit --change-context paths override conventional jj discovery", async () => {
    const repo = createTempJjRepo("hunk-loader-change-context-explicit-");
    const changeId = currentChangeId(repo);
    const conventionPath = join(repo, DEFAULT_CHANGE_CONTEXT_DIR, `${changeId}.json`);
    const explicitPath = join(repo, "explicit-context.json");
    writeChangeContext(conventionPath, "Convention context", changeId);
    writeChangeContext(explicitPath, "Explicit context", changeId);

    const bootstrap = await loadAppBootstrap(createJjDiffInput({ agentContext: explicitPath }), {
      cwd: repo,
    });

    expect(bootstrap.changeset.agentSummary).toBe("Explicit context");
  });

  jjTest("continues without annotations when the conventional context file is absent", async () => {
    const repo = createTempJjRepo("hunk-loader-change-context-absent-");

    const bootstrap = await loadAppBootstrap(createJjDiffInput(), { cwd: repo });

    expect(bootstrap.changeset.agentSummary).toBeUndefined();
    expect(bootstrap.changeset.reviewAttention).toBeUndefined();
    expect(bootstrap.changeset.files[0]?.agent).toBeNull();
  });
});
