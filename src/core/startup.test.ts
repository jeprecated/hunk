import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHANGE_CONTEXT_DIR } from "./changeContextResolution";
import { HunkUserError } from "./errors";
import { prepareStartupPlan } from "./startup";
import type { AppBootstrap, CliInput, ParsedCliInput } from "./types";

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

async function withCwd<T>(cwd: string, callback: () => T | Promise<T>) {
  const previousCwd = process.cwd();
  process.chdir(cwd);

  try {
    return await callback();
  } finally {
    process.chdir(previousCwd);
  }
}

function createBootstrap(input: CliInput): AppBootstrap {
  return {
    input,
    changeset: {
      id: "changeset:startup",
      sourceLabel: "repo",
      title: "repo working tree",
      files: [],
    },
    initialMode: input.options.mode ?? "auto",
  };
}

afterEach(() => {
  cleanupTempDirs();
});

// Keep jj-backed helper coverage opt-in on machines with the external CLI installed.
const jjTest = Bun.which("jj") ? test : test.skip;

describe("startup planning", () => {
  test("returns help output without entering app startup", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk"], {
      parseCliImpl: async () => ({ kind: "help", text: "Usage: hunk\n" }),
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "help", text: "Usage: hunk\n" });
    expect(loaded).toBe(false);
  });

  test("passes the daemon serve command through without app bootstrap work", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk", "daemon", "serve"], {
      parseCliImpl: async () => ({ kind: "daemon-serve" }),
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "daemon-serve" });
    expect(loaded).toBe(false);
  });

  test("passes session commands through without app bootstrap work", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk", "session", "list"], {
      parseCliImpl: async () => ({
        kind: "session",
        action: "list",
        output: "text",
      }),
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({
      kind: "session-command",
      input: { kind: "session", action: "list", output: "text" },
    });
    expect(loaded).toBe(false);
  });

  jjTest("prints a Change Context File path for helper command text output", async () => {
    const repo = createTempJjRepo("hunk-startup-change-context-text-");
    const home = createTempDir("hunk-startup-home-");
    const changeId = currentChangeId(repo);

    const plan = await withCwd(repo, () =>
      prepareStartupPlan(["bun", "hunk", "change-context", "path", "@"], {
        env: { HOME: home },
      }),
    );

    expect(plan).toMatchObject({
      kind: "change-context-command",
      input: {
        kind: "change-context-path",
        rev: "@",
        output: "text",
      },
      text: `${join(repo, DEFAULT_CHANGE_CONTEXT_DIR, `${changeId}.json`)}\n`,
    });
  });

  jjTest("returns structured Change Context helper status and applies --for config", async () => {
    const repo = createTempJjRepo("hunk-startup-change-context-json-");
    const home = createTempDir("hunk-startup-home-");
    const changeId = currentChangeId(repo);
    mkdirSync(join(repo, ".hunk"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "config.toml"),
      [
        'change_context_key = "none"',
        "",
        "[diff]",
        'change_context_key = "jj-change-id"',
        'change_context_dir = ".hunk/diff-context"',
      ].join("\n"),
    );

    const plan = await withCwd(repo, () =>
      prepareStartupPlan(
        ["bun", "hunk", "change-context", "path", "@", "--for", "diff", "--json"],
        {
          env: { HOME: home },
        },
      ),
    );

    expect(plan.kind).toBe("change-context-command");
    if (plan.kind !== "change-context-command") {
      throw new Error("Expected a Change Context helper plan.");
    }

    expect(JSON.parse(plan.text)).toEqual({
      enabled: true,
      vcs: "jj",
      key: "jj-change-id",
      changeId,
      path: join(repo, ".hunk", "diff-context", `${changeId}.json`),
      exists: false,
    });
  });

  jjTest(
    "returns unresolved Change Context helper JSON status for multi-change revsets",
    async () => {
      const repo = createTempJjRepo("hunk-startup-change-context-unresolved-");
      const home = createTempDir("hunk-startup-home-");
      jj(repo, "commit", "-m", "first");
      writeFileSync(join(repo, "second.ts"), "export const second = true;\n");
      mkdirSync(join(repo, ".hunk"), { recursive: true });
      writeFileSync(join(repo, ".hunk", "config.toml"), 'change_context_key = "jj-change-id"\n');

      const plan = await withCwd(repo, () =>
        prepareStartupPlan(["bun", "hunk", "change-context", "path", "all()", "--json"], {
          env: { HOME: home },
        }),
      );

      expect(plan.kind).toBe("change-context-command");
      if (plan.kind !== "change-context-command") {
        throw new Error("Expected a Change Context helper plan.");
      }

      expect(JSON.parse(plan.text)).toEqual({
        enabled: true,
        vcs: "jj",
        key: "jj-change-id",
        reason: "Revset did not resolve to exactly one Jujutsu change.",
      });
    },
  );

  jjTest("returns nonzero Change Context validation plans when JSON validation fails", async () => {
    const repo = createTempJjRepo("hunk-startup-change-context-validate-");
    const home = createTempDir("hunk-startup-home-");

    const plan = await withCwd(repo, () =>
      prepareStartupPlan(
        ["bun", "hunk", "change-context", "validate", "@", "--for", "diff", "--strict", "--json"],
        {
          env: { HOME: home },
        },
      ),
    );

    expect(plan.kind).toBe("change-context-command");
    if (plan.kind !== "change-context-command") {
      throw new Error("Expected a Change Context helper plan.");
    }

    expect(plan.exitCode).toBe(1);
    expect(JSON.parse(plan.text)).toMatchObject({
      ok: false,
      issues: [{ code: "missing-context-file" }],
    });
  });

  jjTest("returns concise nonzero Change Context validation plans for plain output", async () => {
    const repo = createTempJjRepo("hunk-startup-change-context-validate-text-");
    const home = createTempDir("hunk-startup-home-");

    const plan = await withCwd(repo, () =>
      prepareStartupPlan(["bun", "hunk", "change-context", "validate", "@", "--for", "diff"], {
        env: { HOME: home },
      }),
    );

    expect(plan.kind).toBe("change-context-command");
    if (plan.kind !== "change-context-command") {
      throw new Error("Expected a Change Context helper plan.");
    }

    expect(plan.exitCode).toBe(1);
    expect(plan.text).toContain("Change Context validation failed:");
    expect(plan.text).toContain("- Referenced Change Context File does not exist.");
  });

  test("routes non-diff pager stdin to the plain-text pager path", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({
        kind: "pager",
        options: { theme: "github-light-default" },
      }),
      readStdinText: async () => "* main\n  feature/demo\n",
      looksLikePatchInputImpl: () => false,
      stdoutIsTTY: true,
      env: { TERM: "xterm-256color" },
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({
      kind: "plain-text-pager",
      text: "* main\n  feature/demo\n",
    });
    expect(loaded).toBe(false);
  });

  test("passes non-diff pager stdin through for captured pager hosts", async () => {
    let loaded = false;
    const text = "* main\n  feature/demo\n";

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({
        kind: "pager",
        options: { theme: "github-light-default" },
      }),
      readStdinText: async () => text,
      looksLikePatchInputImpl: () => false,
      stdoutIsTTY: true,
      env: { TERM: "dumb", LAZYGIT_NEW_DIR_FILE: "/tmp/lazygit-dir" },
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "passthrough", text });
    expect(loaded).toBe(false);
  });

  test("passes non-diff pager stdin through for a plain dumb terminal", async () => {
    let loaded = false;
    const text = "* main\n  feature/demo\n";

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({ kind: "pager", options: {} }),
      readStdinText: async () => text,
      looksLikePatchInputImpl: () => false,
      stdoutIsTTY: true,
      env: { TERM: "dumb" },
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "passthrough", text });
    expect(loaded).toBe(false);
  });

  test("normalizes diff-like pager stdin into patch app startup", async () => {
    const seenInputs: CliInput[] = [];

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({
        kind: "pager",
        options: { theme: "github-light-default" },
      }),
      readStdinText: async () => "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      looksLikePatchInputImpl: () => true,
      stdoutIsTTY: true,
      env: { TERM: "xterm-256color" },
      openControllingTerminalImpl: () => ({
        stdin: {} as never,
        close: () => {},
      }),
      resolveRuntimeCliInputImpl(input) {
        seenInputs.push(input);
        return input;
      },
      resolveConfiguredCliInputImpl(input) {
        seenInputs.push(input);
        return { input } as never;
      },
      loadAppBootstrapImpl: async (input) => {
        seenInputs.push(input);
        return createBootstrap(input);
      },
      usesPipedPatchInputImpl: () => false,
    });

    expect(plan.kind).toBe("app");
    if (plan.kind !== "app") {
      throw new Error("Expected app startup plan.");
    }

    expect(plan.cliInput).toMatchObject({
      kind: "patch",
      file: "-",
      text: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      options: {
        theme: "github-light-default",
        pager: true,
      },
    });
    expect(seenInputs).toHaveLength(3);
  });

  test("passes diff-like pager stdin through when stdout is not interactive", async () => {
    let loaded = false;
    const patchText = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({ kind: "pager", options: {} }),
      readStdinText: async () => patchText,
      looksLikePatchInputImpl: () => true,
      stdoutIsTTY: false,
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "passthrough", text: patchText });
    expect(loaded).toBe(false);
  });

  test("passes diff-like pager stdin through for a plain dumb terminal", async () => {
    let loaded = false;
    const patchText = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({ kind: "pager", options: {} }),
      readStdinText: async () => patchText,
      looksLikePatchInputImpl: () => true,
      stdoutIsTTY: true,
      env: { TERM: "dumb" },
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "passthrough", text: patchText });
    expect(loaded).toBe(false);
  });

  test("routes diff-like pager stdin to static output when the host advertises a captured pager", async () => {
    let loaded = false;
    const patchText = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const customTheme = { base: "github-light-default", text: "#123456" };

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({
        kind: "pager",
        options: { theme: "custom" },
      }),
      readStdinText: async () => patchText,
      looksLikePatchInputImpl: () => true,
      stdoutIsTTY: true,
      env: { TERM: "dumb", LV: "-c" },
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) =>
        ({
          input: {
            ...input,
            options: { ...input.options, lineNumbers: false, theme: "custom" },
          },
          customTheme,
        }) as never,
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({
      kind: "static-diff-pager",
      text: patchText,
      options: { theme: "custom", pager: true, lineNumbers: false },
      customTheme,
    });
    expect(loaded).toBe(false);
  });

  test("routes diff-like pager stdin to static output when no controlling terminal is available", async () => {
    let loaded = false;
    const patchText = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({ kind: "pager", options: {} }),
      readStdinText: async () => patchText,
      looksLikePatchInputImpl: () => true,
      stdoutIsTTY: true,
      env: { TERM: "xterm-256color" },
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
      openControllingTerminalImpl: () => null,
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({
      kind: "static-diff-pager",
      text: patchText,
      options: { pager: true },
    });
    expect(loaded).toBe(false);
  });

  test("passes configured custom theme data into app bootstrap", async () => {
    const cliInput: CliInput = {
      kind: "patch",
      file: "-",
      options: {
        theme: "custom",
      },
    };
    const customTheme = {
      base: "github-dark-default",
      accent: "#123456",
    };

    await prepareStartupPlan(["bun", "hunk", "patch", "-"], {
      parseCliImpl: async () => cliInput as ParsedCliInput,
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => ({ input, customTheme }) as never,
      loadAppBootstrapImpl: async (input, options) => {
        expect(input).toBe(cliInput);
        expect(options).toEqual({ customTheme });
        return {
          ...createBootstrap(input),
          customTheme,
        };
      },
      usesPipedPatchInputImpl: () => false,
    });
  });

  test("rejects watch mode for stdin-backed patch inputs", async () => {
    const cliInput: CliInput = {
      kind: "patch",
      file: "-",
      options: {
        watch: true,
      },
    };

    await expect(
      prepareStartupPlan(["bun", "hunk", "patch", "-", "--watch"], {
        parseCliImpl: async () => cliInput as ParsedCliInput,
        resolveRuntimeCliInputImpl: (input) => input,
        resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
      }),
    ).rejects.toBeInstanceOf(HunkUserError);
  });

  test("opens the controlling terminal for any app startup with piped stdin", async () => {
    const cliInput: CliInput = {
      kind: "vcs",
      staged: false,
      options: {
        theme: "github-dark-default",
      },
    };
    const controllingTerminal = { stdin: {} as never, close: () => {} };
    let opened = 0;

    const plan = await prepareStartupPlan(
      ["bun", "hunk", "diff", "--theme", "github-dark-default"],
      {
        parseCliImpl: async () => cliInput as ParsedCliInput,
        resolveRuntimeCliInputImpl: (input) => input,
        resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
        loadAppBootstrapImpl: async (input) => createBootstrap(input),
        openControllingTerminalImpl: () => {
          opened += 1;
          return controllingTerminal;
        },
        stdinIsTTY: false,
        stdoutIsTTY: true,
      },
    );

    expect(plan).toMatchObject({
      kind: "app",
      cliInput,
      controllingTerminal,
    });
    expect(opened).toBe(1);
  });

  test("detects auto theme through the controlling terminal before app startup", async () => {
    const cliInput: CliInput = {
      kind: "patch",
      file: "-",
      options: {
        theme: "auto",
        pager: true,
      },
    };
    const controllingTerminal = { stdin: {} as never, close: () => {} };
    let opened = 0;

    const plan = await prepareStartupPlan(["bun", "hunk", "patch", "-", "--theme", "auto"], {
      parseCliImpl: async () => cliInput as ParsedCliInput,
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
      loadAppBootstrapImpl: async (input) => createBootstrap(input),
      openControllingTerminalImpl: () => {
        opened += 1;
        return controllingTerminal;
      },
      detectTerminalThemeModeFromBackgroundImpl: async ({ input }) => {
        expect(input).toBe(controllingTerminal.stdin);
        return "dark";
      },
      stdinIsTTY: false,
      stdoutIsTTY: true,
      stdout: { write: () => true } as never,
    });

    expect(plan).toMatchObject({
      kind: "app",
      controllingTerminal,
      bootstrap: { initialThemeMode: "dark" },
    });
    expect(opened).toBe(1);
  });

  test("opens the controlling terminal for piped patch startup", async () => {
    const cliInput: CliInput = {
      kind: "patch",
      file: "-",
      options: {
        mode: "auto",
        pager: true,
      },
    };
    const controllingTerminal = {
      stdin: {} as never,
      stdout: {} as never,
      close: () => {},
    };
    let opened = 0;

    const plan = await prepareStartupPlan(["bun", "hunk", "patch", "-"], {
      parseCliImpl: async () => cliInput as ParsedCliInput,
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
      loadAppBootstrapImpl: async (input) => createBootstrap(input),
      usesPipedPatchInputImpl: (input) => {
        expect(input).toBe(cliInput);
        return true;
      },
      openControllingTerminalImpl: () => {
        opened += 1;
        return controllingTerminal;
      },
    });

    expect(plan).toMatchObject({
      kind: "app",
      cliInput,
      controllingTerminal,
    });
    expect(opened).toBe(1);
  });
});
