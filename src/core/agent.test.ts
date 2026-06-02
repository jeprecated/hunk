import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAgentFileContext, loadAgentContext } from "./agent";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("agent context", () => {
  test("returns null when no sidecar path is provided", async () => {
    await expect(loadAgentContext()).resolves.toBeNull();
  });

  test("loads and matches annotations by current or previous path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-agent-"));
    tempDirs.push(dir);

    const contextPath = join(dir, "agent.json");
    writeFileSync(
      contextPath,
      JSON.stringify({
        version: 1,
        summary: "Agent summary",
        files: [
          {
            path: "src/example.ts",
            summary: "Explains the file change",
            annotations: [
              {
                newRange: [4, 8],
                summary: "Added a helper",
                confidence: "high",
                tags: ["review", 7],
              },
            ],
          },
        ],
      }),
    );

    const context = await loadAgentContext(contextPath);

    expect(context?.summary).toBe("Agent summary");
    expect(findAgentFileContext(context, "src/example.ts")?.annotations).toHaveLength(1);
    expect(findAgentFileContext(context, "src/example.ts")?.annotations[0]?.tags).toEqual([
      "review",
    ]);
    expect(findAgentFileContext(context, "src/renamed.ts", "src/example.ts")?.summary).toBe(
      "Explains the file change",
    );
  });

  test("loads review attention and warns without dropping annotations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-agent-review-attention-"));
    tempDirs.push(dir);
    const warnings: string[] = [];

    const contextPath = join(dir, "context.json");
    writeFileSync(
      contextPath,
      JSON.stringify({
        version: 1,
        summary: "Agent summary",
        change: { vcs: "jj", key: "jj-change-id", id: "different" },
        reviewAttention: { level: "high", summary: "New feature" },
        files: [{ path: "src/example.ts", annotations: [{ summary: "Keep this" }] }],
      }),
    );

    const context = await loadAgentContext(contextPath, {
      expectedChangeId: "expected",
      warn: (message) => warnings.push(message),
    });

    expect(context?.reviewAttention).toEqual({ level: "high", summary: "New feature" });
    expect(context?.change?.id).toBe("different");
    expect(context?.files[0]?.annotations).toHaveLength(1);
    expect(warnings[0]).toContain("does not match resolved jj change expected");

    const malformedPath = join(dir, "malformed.json");
    writeFileSync(
      malformedPath,
      JSON.stringify({
        version: 1,
        reviewAttention: { level: "urgent", summary: "Bad" },
        files: [{ path: "src/example.ts", annotations: [{ summary: "Still loads" }] }],
      }),
    );

    const malformed = await loadAgentContext(malformedPath, {
      warn: (message) => warnings.push(message),
    });

    expect(malformed?.reviewAttention).toBeUndefined();
    expect(malformed?.files[0]?.annotations).toHaveLength(1);
  });

  test("rejects malformed file and range entries in the sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-agent-invalid-"));
    tempDirs.push(dir);

    const invalidFilePath = join(dir, "invalid-file.json");
    writeFileSync(
      invalidFilePath,
      JSON.stringify({
        version: 1,
        files: [{ summary: "Missing path", annotations: [] }],
      }),
    );

    await expect(loadAgentContext(invalidFilePath)).rejects.toThrow(
      "Agent context file entries require a non-empty path.",
    );

    const invalidRangePath = join(dir, "invalid-range.json");
    writeFileSync(
      invalidRangePath,
      JSON.stringify({
        version: 1,
        files: [
          {
            path: "src/example.ts",
            annotations: [{ summary: "Bad range", newRange: [1, "two"] }],
          },
        ],
      }),
    );

    await expect(loadAgentContext(invalidRangePath)).rejects.toThrow(
      "Annotation ranges must be integer tuples.",
    );

    const negativeRangePath = join(dir, "negative-range.json");
    writeFileSync(
      negativeRangePath,
      JSON.stringify({
        version: 1,
        files: [
          {
            path: "src/example.ts",
            annotations: [{ summary: "Bad range", newRange: [0, 2] }],
          },
        ],
      }),
    );

    await expect(loadAgentContext(negativeRangePath)).rejects.toThrow(
      "Annotation ranges must use positive 1-based line numbers.",
    );

    const reversedRangePath = join(dir, "reversed-range.json");
    writeFileSync(
      reversedRangePath,
      JSON.stringify({
        version: 1,
        files: [
          {
            path: "src/example.ts",
            annotations: [{ summary: "Bad range", newRange: [4, 2] }],
          },
        ],
      }),
    );

    await expect(loadAgentContext(reversedRangePath)).rejects.toThrow(
      "Annotation ranges must be ordered start..end tuples.",
    );
  });
});
