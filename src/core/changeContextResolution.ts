import fs from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { resolveJjRepoRoot, runJjText, type JjBackedInput } from "./jj";
import type {
  ChangeContextKey,
  CliInput,
  CommonOptions,
  VcsShowCommandInput,
  VcsDiffCommandInput,
  VcsMode,
} from "./types";

export const DEFAULT_CHANGE_CONTEXT_DIR = ".hunk/change-context";

export interface ResolvedChangeContextPath {
  path: string;
  source: "explicit" | "convention";
  exists: boolean;
  key?: Exclude<ChangeContextKey, "none">;
  changeId?: string;
}

interface ResolveChangeContextPathOptions {
  cwd?: string;
  requireExisting?: boolean;
}

interface ResolveJjChangeIdOptions {
  cwd?: string;
}

/** Return whether this review input can be keyed by a Jujutsu change id. */
function isJjReviewInput(input: CliInput): input is VcsDiffCommandInput | VcsShowCommandInput {
  return input.kind === "vcs" || input.kind === "show";
}

/** Return the revset whose full jj change id should key this Hunk input. */
function revsetForInput(input: VcsDiffCommandInput | VcsShowCommandInput) {
  return input.kind === "show" ? (input.ref ?? "@") : (input.range ?? "@");
}

/** Resolve a relative convention directory against the jj repo root. */
function resolveContextDir(dir: string | undefined, repoRoot: string) {
  const selected = dir ?? DEFAULT_CHANGE_CONTEXT_DIR;
  return isAbsolute(selected) ? selected : join(repoRoot, selected);
}

/** Resolve one full canonical jj change id from a revset, accepting exactly one result. */
export function resolveJjChangeIdForRevset(
  revset: string,
  input: JjBackedInput,
  { cwd = process.cwd() }: ResolveJjChangeIdOptions = {},
) {
  const stdout = runJjText({
    input,
    cwd,
    args: ["log", "--no-graph", "-r", revset, "-T", 'change_id ++ "\\n"'],
  });
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.length === 1 ? (lines[0] ?? null) : null;
}

/** Resolve one full canonical jj change id for a Hunk review input. */
export function resolveJjChangeIdForInput(
  input: VcsDiffCommandInput | VcsShowCommandInput,
  options: ResolveJjChangeIdOptions = {},
) {
  return resolveJjChangeIdForRevset(revsetForInput(input), input, options);
}

/** Resolve the explicit or conventional Change Context File path for a review input. */
export function resolveChangeContextPath(
  input: CliInput,
  { cwd = process.cwd(), requireExisting = true }: ResolveChangeContextPathOptions = {},
): ResolvedChangeContextPath | null {
  if (input.options.agentContext) {
    const path = input.options.agentContext;
    return {
      path,
      source: "explicit",
      exists: path === "-" ? true : fs.existsSync(resolvePath(cwd, path)),
    };
  }

  if (input.options.changeContextKey !== "jj-change-id") {
    return null;
  }

  if ((input.options.vcs ?? "git") !== "jj" || !isJjReviewInput(input)) {
    return null;
  }

  const changeId = resolveJjChangeIdForInput(input, { cwd });
  if (!changeId) {
    return null;
  }

  const repoRoot = resolveJjRepoRoot(input, { cwd });
  const path = join(
    resolveContextDir(input.options.changeContextDir, repoRoot),
    `${changeId}.json`,
  );
  const exists = fs.existsSync(path);
  if (requireExisting && !exists) {
    return null;
  }

  return {
    path,
    source: "convention",
    key: "jj-change-id",
    changeId,
    exists,
  };
}

export interface ChangeContextPathStatus {
  enabled: boolean;
  vcs: VcsMode;
  key?: Exclude<ChangeContextKey, "none">;
  changeId?: string;
  path?: string;
  exists?: boolean;
  reason?: string;
}

/** Resolve helper-command status for agent authoring without writing files. */
export function resolveChangeContextPathStatus({
  rev,
  options,
  cwd = process.cwd(),
}: {
  rev?: string;
  options: CommonOptions;
  cwd?: string;
}): ChangeContextPathStatus {
  const vcs = options.vcs ?? "git";
  const enabled = options.changeContextKey === "jj-change-id";
  if (vcs !== "jj") {
    return { enabled, vcs, reason: "Change Context paths require a Jujutsu repository." };
  }

  const input: VcsDiffCommandInput = {
    kind: "vcs",
    range: rev ?? "@",
    staged: false,
    options: { ...options, vcs: "jj" },
  };

  let changeId: string | null;
  try {
    changeId = resolveJjChangeIdForRevset(rev ?? "@", input, { cwd });
  } catch (error) {
    return {
      enabled,
      vcs,
      key: enabled ? "jj-change-id" : undefined,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!changeId) {
    return {
      enabled,
      vcs,
      key: enabled ? "jj-change-id" : undefined,
      reason: "Revset did not resolve to exactly one Jujutsu change.",
    };
  }

  let repoRoot: string;
  try {
    repoRoot = resolveJjRepoRoot(input, { cwd });
  } catch (error) {
    return {
      enabled,
      vcs,
      key: enabled ? "jj-change-id" : undefined,
      changeId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const path = join(resolveContextDir(options.changeContextDir, repoRoot), `${changeId}.json`);
  return {
    enabled,
    vcs,
    key: "jj-change-id",
    changeId,
    path,
    exists: fs.existsSync(path),
  };
}
