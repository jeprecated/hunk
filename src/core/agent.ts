import { resolve as resolvePath } from "node:path";
import type {
  AgentContext,
  AgentFileContext,
  ChangeContext,
  ChangeContextIdentity,
  ReviewAttention,
} from "./types";

interface AgentContextLoadOptions {
  cwd?: string;
  expectedChangeId?: string;
  warn?: (message: string) => void;
}

/** Emit one non-fatal Change Context warning before the TUI starts. */
function defaultWarn(message: string) {
  process.stderr.write(`${message}\n`);
}

/** Normalize one file entry from the optional agent-context sidecar JSON. */
function normalizeAnnotationFile(file: unknown): AgentFileContext {
  if (!file || typeof file !== "object") {
    throw new Error("Agent context files must be objects.");
  }

  const value = file as Record<string, unknown>;

  if (typeof value.path !== "string" || value.path.length === 0) {
    throw new Error("Agent context file entries require a non-empty path.");
  }

  const annotations = Array.isArray(value.annotations) ? value.annotations : [];

  return {
    path: value.path,
    summary: typeof value.summary === "string" ? value.summary : undefined,
    annotations: annotations.map((annotation) => {
      if (!annotation || typeof annotation !== "object") {
        throw new Error("Agent annotations must be objects.");
      }

      const item = annotation as Record<string, unknown>;

      if (typeof item.summary !== "string" || item.summary.length === 0) {
        throw new Error("Each agent annotation requires a summary.");
      }

      /** Normalize a line-range tuple if the sidecar provides one. */
      const normalizeRange = (range: unknown) => {
        if (!Array.isArray(range) || range.length !== 2) {
          return undefined;
        }

        const [start, end] = range;

        if (
          typeof start !== "number" ||
          typeof end !== "number" ||
          !Number.isInteger(start) ||
          !Number.isInteger(end)
        ) {
          throw new Error("Annotation ranges must be integer tuples.");
        }

        if (start < 1 || end < 1) {
          throw new Error("Annotation ranges must use positive 1-based line numbers.");
        }

        if (end < start) {
          throw new Error("Annotation ranges must be ordered start..end tuples.");
        }

        return [start, end] as [number, number];
      };

      return {
        id: typeof item.id === "string" ? item.id : undefined,
        oldRange: normalizeRange(item.oldRange),
        newRange: normalizeRange(item.newRange),
        summary: item.summary,
        rationale: typeof item.rationale === "string" ? item.rationale : undefined,
        tags: Array.isArray(item.tags)
          ? item.tags.filter((tag): tag is string => typeof tag === "string")
          : undefined,
        confidence:
          item.confidence === "low" || item.confidence === "medium" || item.confidence === "high"
            ? item.confidence
            : undefined,
        source: typeof item.source === "string" ? item.source : undefined,
        author: typeof item.author === "string" ? item.author : undefined,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
      };
    }),
  };
}

function normalizeReviewAttention(value: unknown, warn: (message: string) => void) {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warn("Ignoring malformed Review Attention: expected an object.");
    return undefined;
  }

  const item = value as Record<string, unknown>;
  const level = item.level;
  const summary = item.summary;
  if (level !== "low" && level !== "medium" && level !== "high") {
    warn("Ignoring malformed Review Attention: level must be low, medium, or high.");
    return undefined;
  }

  if (typeof summary !== "string" || summary.length === 0) {
    warn("Ignoring malformed Review Attention: summary is required.");
    return undefined;
  }

  return {
    level,
    summary,
    rationale: typeof item.rationale === "string" ? item.rationale : undefined,
  } satisfies ReviewAttention;
}

function normalizeChangeIdentity(
  value: unknown,
  expectedChangeId: string | undefined,
  warn: (message: string) => void,
) {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warn("Ignoring malformed Change Context identity: expected an object.");
    return undefined;
  }

  const item = value as Record<string, unknown>;
  if (item.vcs !== "jj" || item.key !== "jj-change-id" || typeof item.id !== "string") {
    warn("Ignoring malformed Change Context identity: expected jj change id metadata.");
    return undefined;
  }

  if (expectedChangeId && item.id !== expectedChangeId) {
    warn(
      `Change Context identity ${item.id} does not match resolved jj change ${expectedChangeId}.`,
    );
  }

  return {
    vcs: "jj",
    key: "jj-change-id",
    id: item.id,
  } satisfies ChangeContextIdentity;
}

/** Load the optional Change Context File from a file path or stdin. */
export async function loadAgentContext(
  pathOrDash?: string,
  { cwd = process.cwd(), expectedChangeId, warn = defaultWarn }: AgentContextLoadOptions = {},
): Promise<ChangeContext | null> {
  if (!pathOrDash) {
    return null;
  }

  const raw =
    pathOrDash === "-"
      ? await new Response(Bun.stdin.stream()).text()
      : await Bun.file(resolvePath(cwd, pathOrDash)).text();

  const parsed = JSON.parse(raw) as Record<string, unknown>;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Agent context must be a JSON object.");
  }

  const files = Array.isArray(parsed.files) ? parsed.files.map(normalizeAnnotationFile) : [];

  return {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
    change: normalizeChangeIdentity(parsed.change, expectedChangeId, warn),
    reviewAttention: normalizeReviewAttention(parsed.reviewAttention, warn),
    files,
  };
}

/** Match agent context to a diff file by current path first, then previous path for renames. */
export function findAgentFileContext(
  agentContext: AgentContext | null,
  currentPath: string,
  previousPath?: string,
): AgentFileContext | null {
  if (!agentContext) {
    return null;
  }

  return (
    agentContext.files.find(
      (file) => file.path === currentPath || (previousPath ? file.path === previousPath : false),
    ) ?? null
  );
}
