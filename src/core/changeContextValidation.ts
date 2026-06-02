import { readFileSync } from "node:fs";
import type { Hunk } from "@pierre/diffs";
import { resolveConfiguredChangeContextOptions } from "./config";
import { resolveChangeContextPathStatus } from "./changeContextResolution";
import { hunkLineRange } from "./liveComments";
import { loadAppBootstrap } from "./loaders";
import type {
  ChangeContextValidateCommandInput,
  Changeset,
  CommonOptions,
  DiffFile,
} from "./types";

export type ChangeContextValidationSeverity = "error" | "warning";
export type ChangeContextRangeKind = "oldRange" | "newRange";

export interface ChangeContextValidationIssue {
  severity: ChangeContextValidationSeverity;
  code: string;
  file?: string;
  annotationIndex?: number;
  rangeKind?: ChangeContextRangeKind;
  range?: [number, number];
  message: string;
  suggestedRange?: [number, number];
}

export interface ChangeContextValidationResult {
  ok: boolean;
  path?: string;
  changeId?: string;
  issues: ChangeContextValidationIssue[];
}

interface ValidationFile {
  path: string;
  summary?: string;
  annotations: ValidationAnnotation[];
}

interface ValidationAnnotation {
  summary?: string;
  oldRange?: [number, number];
  newRange?: [number, number];
  sawOldRange: boolean;
  sawNewRange: boolean;
}

interface ValidationDocument {
  changeId?: string;
  files: ValidationFile[];
}

interface HunkSideRange {
  hunk: Hunk;
  index: number;
  range: [number, number];
  oppositeRange: [number, number];
  hasChangedLines: boolean;
}

/** Return whether an unknown JSON value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check whether two inclusive line ranges overlap. */
function rangesOverlap(left: [number, number], right: [number, number]) {
  return left[0] <= right[1] && right[0] <= left[1];
}

/** Return whether a line number is inside an inclusive line range. */
function rangeContainsLine(range: [number, number], line: number) {
  return line >= range[0] && line <= range[1];
}

/** Return a stable human label for a line range. */
function formatRange(range: [number, number]) {
  return range[0] === range[1] ? `${range[0]}` : `${range[0]}-${range[1]}`;
}

/** Compute a mechanical distance from a line range to a hunk side range. */
function rangeDistanceToHunk(range: [number, number], hunkRange: [number, number]) {
  if (rangesOverlap(range, hunkRange)) {
    return 0;
  }

  return range[1] < hunkRange[0] ? hunkRange[0] - range[1] : range[0] - hunkRange[1];
}

/** Add one structured validation issue. */
function addIssue(issues: ChangeContextValidationIssue[], issue: ChangeContextValidationIssue) {
  issues.push(issue);
}

/** Normalize and validate one annotation range tuple if present. */
function normalizeRange(
  value: unknown,
  kind: ChangeContextRangeKind,
  filePath: string,
  annotationIndex: number,
  issues: ChangeContextValidationIssue[],
) {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length !== 2) {
    addIssue(issues, {
      severity: "error",
      code: "invalid-range",
      file: filePath,
      annotationIndex,
      rangeKind: kind,
      message: `${kind} must be a two-item integer tuple.`,
    });
    return undefined;
  }

  const [start, end] = value;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end)
  ) {
    addIssue(issues, {
      severity: "error",
      code: "invalid-range",
      file: filePath,
      annotationIndex,
      rangeKind: kind,
      message: `${kind} must contain integer line numbers.`,
    });
    return undefined;
  }

  const range = [start, end] as [number, number];
  if (start < 1 || end < 1) {
    addIssue(issues, {
      severity: "error",
      code: "invalid-range",
      file: filePath,
      annotationIndex,
      rangeKind: kind,
      range,
      message: `${kind} must use positive 1-based line numbers.`,
    });
    return undefined;
  }

  if (end < start) {
    addIssue(issues, {
      severity: "error",
      code: "invalid-range",
      file: filePath,
      annotationIndex,
      rangeKind: kind,
      range,
      message: `${kind} must be ordered start..end.`,
    });
    return undefined;
  }

  return range;
}

/** Parse a raw Change Context JSON value into the subset needed for validation. */
function normalizeValidationDocument(
  parsed: unknown,
  expectedChangeId: string | undefined,
  issues: ChangeContextValidationIssue[],
): ValidationDocument | null {
  if (!isRecord(parsed)) {
    addIssue(issues, {
      severity: "error",
      code: "invalid-shape",
      message: "Change Context File must be a JSON object.",
    });
    return null;
  }

  if (parsed.version !== undefined && typeof parsed.version !== "number") {
    addIssue(issues, {
      severity: "error",
      code: "invalid-version",
      message: "version must be a number when present.",
    });
  }

  if (parsed.summary !== undefined && typeof parsed.summary !== "string") {
    addIssue(issues, {
      severity: "error",
      code: "invalid-summary",
      message: "summary must be a string when present.",
    });
  }

  if (parsed.reviewAttention !== undefined) {
    if (!isRecord(parsed.reviewAttention)) {
      addIssue(issues, {
        severity: "error",
        code: "invalid-review-attention",
        message: "reviewAttention must be an object when present.",
      });
    } else if (
      parsed.reviewAttention.level !== "low" &&
      parsed.reviewAttention.level !== "medium" &&
      parsed.reviewAttention.level !== "high"
    ) {
      addIssue(issues, {
        severity: "error",
        code: "invalid-review-attention",
        message: "reviewAttention.level must be low, medium, or high.",
      });
    } else if (
      typeof parsed.reviewAttention.summary !== "string" ||
      parsed.reviewAttention.summary.length === 0
    ) {
      addIssue(issues, {
        severity: "error",
        code: "invalid-review-attention",
        message: "reviewAttention.summary is required.",
      });
    }
  }

  let changeId: string | undefined;
  if (parsed.change !== undefined) {
    if (!isRecord(parsed.change)) {
      addIssue(issues, {
        severity: "error",
        code: "invalid-change-identity",
        message: "change must be an object when present.",
      });
    } else if (
      parsed.change.vcs !== "jj" ||
      parsed.change.key !== "jj-change-id" ||
      typeof parsed.change.id !== "string"
    ) {
      addIssue(issues, {
        severity: "error",
        code: "invalid-change-identity",
        message: "change must contain jj change id metadata.",
      });
    } else {
      changeId = parsed.change.id;
      if (expectedChangeId && changeId !== expectedChangeId) {
        addIssue(issues, {
          severity: "error",
          code: "change-id-mismatch",
          message: `Change Context identity ${changeId} does not match resolved jj change ${expectedChangeId}.`,
        });
      }
    }
  }

  if (!Array.isArray(parsed.files)) {
    addIssue(issues, {
      severity: "error",
      code: "invalid-files",
      message: "Change Context File requires a files array.",
    });
    return { changeId, files: [] };
  }

  const files: ValidationFile[] = [];
  parsed.files.forEach((rawFile, fileIndex) => {
    if (!isRecord(rawFile)) {
      addIssue(issues, {
        severity: "error",
        code: "invalid-file-entry",
        message: `files[${fileIndex}] must be an object.`,
      });
      return;
    }

    if (typeof rawFile.path !== "string" || rawFile.path.length === 0) {
      addIssue(issues, {
        severity: "error",
        code: "invalid-file-path",
        message: `files[${fileIndex}] requires a non-empty path.`,
      });
      return;
    }

    const filePath = rawFile.path;
    if (rawFile.summary !== undefined && typeof rawFile.summary !== "string") {
      addIssue(issues, {
        severity: "error",
        code: "invalid-file-summary",
        file: filePath,
        message: "File summary must be a string when present.",
      });
    }

    const annotationsValue = rawFile.annotations;
    const annotations: ValidationAnnotation[] = [];
    if (annotationsValue !== undefined && !Array.isArray(annotationsValue)) {
      addIssue(issues, {
        severity: "error",
        code: "invalid-annotations",
        file: filePath,
        message: "annotations must be an array when present.",
      });
    }

    if (Array.isArray(annotationsValue)) {
      annotationsValue.forEach((rawAnnotation, annotationIndex) => {
        if (!isRecord(rawAnnotation)) {
          addIssue(issues, {
            severity: "error",
            code: "invalid-annotation",
            file: filePath,
            annotationIndex,
            message: "Annotation entries must be objects.",
          });
          return;
        }

        if (typeof rawAnnotation.summary !== "string" || rawAnnotation.summary.length === 0) {
          addIssue(issues, {
            severity: "error",
            code: "invalid-annotation-summary",
            file: filePath,
            annotationIndex,
            message: "Each annotation requires a non-empty summary.",
          });
        }

        const oldRange = normalizeRange(
          rawAnnotation.oldRange,
          "oldRange",
          filePath,
          annotationIndex,
          issues,
        );
        const newRange = normalizeRange(
          rawAnnotation.newRange,
          "newRange",
          filePath,
          annotationIndex,
          issues,
        );

        annotations.push({
          summary: typeof rawAnnotation.summary === "string" ? rawAnnotation.summary : undefined,
          oldRange,
          newRange,
          sawOldRange: rawAnnotation.oldRange !== undefined,
          sawNewRange: rawAnnotation.newRange !== undefined,
        });
      });
    }

    files.push({
      path: filePath,
      summary: typeof rawFile.summary === "string" ? rawFile.summary : undefined,
      annotations,
    });
  });

  return { changeId, files };
}

/** Find a changeset file using the same current/previous path rule as annotation loading. */
function findDiffFileByContextPath(changeset: Changeset, contextPath: string) {
  return changeset.files.find(
    (file) =>
      file.path === contextPath || (file.previousPath ? file.previousPath === contextPath : false),
  );
}

/** Return hunk ranges for the requested annotation side. */
function hunkSideRanges(file: DiffFile, kind: ChangeContextRangeKind): HunkSideRange[] {
  return file.metadata.hunks.map((hunk, index) => {
    const lineRange = hunkLineRange(hunk);
    return {
      hunk,
      index,
      range: kind === "newRange" ? lineRange.newRange : lineRange.oldRange,
      oppositeRange: kind === "newRange" ? lineRange.oldRange : lineRange.newRange,
      hasChangedLines: kind === "newRange" ? hunk.additionLines > 0 : hunk.deletionLines > 0,
    };
  });
}

/** Suggest the nearest hunk range on one side using only line distance. */
function nearestHunkRange(ranges: HunkSideRange[], range: [number, number]) {
  return ranges
    .map((candidate) => ({
      candidate,
      distance: rangeDistanceToHunk(range, candidate.range),
    }))
    .sort(
      (left, right) =>
        left.distance - right.distance || left.candidate.index - right.candidate.index,
    )[0]?.candidate;
}

/** Validate one normalized annotation range against the current diff hunks. */
function validateAnnotationRange({
  filePath,
  annotationIndex,
  kind,
  range,
  file,
  issues,
}: {
  filePath: string;
  annotationIndex: number;
  kind: ChangeContextRangeKind;
  range: [number, number];
  file: DiffFile;
  issues: ChangeContextValidationIssue[];
}) {
  const ranges = hunkSideRanges(file, kind);
  const overlaps = ranges.filter((candidate) => rangesOverlap(range, candidate.range));

  if (overlaps.length === 0) {
    const suggested = nearestHunkRange(ranges, range);
    addIssue(issues, {
      severity: "error",
      code: "range-outside-hunks",
      file: filePath,
      annotationIndex,
      rangeKind: kind,
      range,
      message: `${kind} does not overlap any changed hunk on the ${kind === "newRange" ? "new" : "old"} side.`,
      suggestedRange: suggested?.range,
    });
    return;
  }

  if (overlaps.length > 1) {
    addIssue(issues, {
      severity: "error",
      code: "range-crosses-hunks",
      file: filePath,
      annotationIndex,
      rangeKind: kind,
      range,
      message: `${kind} crosses multiple hunks; split the annotation or narrow it to one hunk.`,
      suggestedRange: overlaps[0]?.range,
    });
    return;
  }

  const matched = overlaps[0]!;
  if (!matched.hasChangedLines) {
    addIssue(issues, {
      severity: "error",
      code: "range-side-mismatch",
      file: filePath,
      annotationIndex,
      rangeKind: kind,
      range,
      message:
        kind === "newRange"
          ? "newRange cannot target a deleted-only hunk."
          : "oldRange cannot target an added-only hunk.",
      suggestedRange: matched.oppositeRange,
    });
    return;
  }

  if (!rangeContainsLine(matched.range, range[0])) {
    addIssue(issues, {
      severity: "error",
      code: "range-start-outside-hunk",
      file: filePath,
      annotationIndex,
      rangeKind: kind,
      range,
      message: `${kind} starts outside the changed hunk it overlaps.`,
      suggestedRange: matched.range,
    });
  }
}

/** Validate normalized Change Context entries against a loaded changeset. */
export function validateChangeContextAgainstChangeset(
  document: ValidationDocument,
  changeset: Changeset,
  issues: ChangeContextValidationIssue[] = [],
) {
  for (const fileContext of document.files) {
    const file = findDiffFileByContextPath(changeset, fileContext.path);
    if (!file) {
      addIssue(issues, {
        severity: "error",
        code: "missing-file",
        file: fileContext.path,
        message: `${fileContext.path} does not match any file in the current changeset.`,
      });
      continue;
    }

    if (!fileContext.summary && fileContext.annotations.length === 0) {
      addIssue(issues, {
        severity: "warning",
        code: "empty-file-context",
        file: fileContext.path,
        message: `${fileContext.path} has neither summary nor annotations.`,
      });
    }

    fileContext.annotations.forEach((annotation, annotationIndex) => {
      if (
        !annotation.oldRange &&
        !annotation.newRange &&
        !annotation.sawOldRange &&
        !annotation.sawNewRange
      ) {
        addIssue(issues, {
          severity: "error",
          code: "missing-annotation-range",
          file: fileContext.path,
          annotationIndex,
          message: "Annotation must include at least one of oldRange or newRange.",
        });
      }

      if (annotation.oldRange) {
        validateAnnotationRange({
          filePath: fileContext.path,
          annotationIndex,
          kind: "oldRange",
          range: annotation.oldRange,
          file,
          issues,
        });
      }

      if (annotation.newRange) {
        validateAnnotationRange({
          filePath: fileContext.path,
          annotationIndex,
          kind: "newRange",
          range: annotation.newRange,
          file,
          issues,
        });
      }
    });
  }

  return issues;
}

/** Render concise human validation output. */
export function renderChangeContextValidationText(result: ChangeContextValidationResult) {
  const path = result.path ?? "<unresolved>";
  if (result.ok) {
    return `Change Context validation passed: ${path}\n`;
  }

  const lines = [`Change Context validation failed: ${path}`];
  for (const issue of result.issues) {
    const location = [
      issue.file,
      issue.annotationIndex !== undefined ? `annotation ${issue.annotationIndex}` : undefined,
      issue.rangeKind,
      issue.range ? formatRange(issue.range) : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    const suggestion = issue.suggestedRange
      ? `; suggested ${formatRange(issue.suggestedRange)}.`
      : "";
    const message = suggestion ? issue.message.replace(/[.]$/, "") : issue.message;
    lines.push(`- ${location ? `${location} ` : ""}${message}${suggestion}`);
  }

  return `${lines.join("\n")}\n`;
}

/** Build a jj-backed review input used only for validation changeset loading. */
function createValidationReviewInput(
  input: ChangeContextValidateCommandInput,
  options: CommonOptions,
) {
  const rev = input.rev ?? "@";
  const safeOptions = {
    ...options,
    vcs: "jj" as const,
    agentContext: undefined,
    changeContextKey: "none" as const,
  };

  if (input.commandKind === "show") {
    return {
      kind: "show" as const,
      ref: rev,
      options: safeOptions,
    };
  }

  return {
    kind: "vcs" as const,
    range: rev,
    staged: false,
    options: safeOptions,
  };
}

/** Validate the conventional Change Context File for a helper command invocation. */
export async function validateChangeContextCommand(
  input: ChangeContextValidateCommandInput,
  { cwd = process.cwd(), env = process.env }: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ChangeContextValidationResult> {
  const configured = resolveConfiguredChangeContextOptions({
    cwd,
    env,
    commandKind: input.commandKind,
  });
  const status = resolveChangeContextPathStatus({
    rev: input.rev,
    options: configured.options,
    cwd,
  });
  const issues: ChangeContextValidationIssue[] = [];

  if (!status.path) {
    addIssue(issues, {
      severity: "error",
      code: "path-unresolved",
      message: status.reason ?? "Could not resolve a Change Context File path.",
    });
    return { ok: false, changeId: status.changeId, issues };
  }

  if (!status.exists) {
    addIssue(issues, {
      severity: "error",
      code: "missing-context-file",
      message: "Referenced Change Context File does not exist.",
    });
    return { ok: false, path: status.path, changeId: status.changeId, issues };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(status.path, "utf8"));
  } catch (error) {
    addIssue(issues, {
      severity: "error",
      code: "malformed-json",
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, path: status.path, changeId: status.changeId, issues };
  }

  const document = normalizeValidationDocument(parsed, status.changeId, issues);
  if (document) {
    try {
      const bootstrap = await loadAppBootstrap(
        createValidationReviewInput(input, configured.options),
        { cwd },
      );
      validateChangeContextAgainstChangeset(document, bootstrap.changeset, issues);
    } catch (error) {
      addIssue(issues, {
        severity: "error",
        code: "changeset-unresolved",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const hasFailures = issues.some(
    (issue) =>
      issue.severity === "error" ||
      (input.strict && issue.severity === "warning" && issue.code !== "empty-file-context"),
  );
  return {
    ok: !hasFailures,
    path: status.path,
    changeId: status.changeId,
    issues,
  };
}
