import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { jsonContent } from "./agent_tool_helpers.js";

/**
 * A single reviewer note attached to a file (and optionally a specific line).
 */
export interface ReviewNote {
  /** File path the note refers to. */
  path: string;
  /** Optional 1-based line number. */
  line?: number;
  /** The reviewer's comment. */
  comment: string;
}

/**
 * Input shape for the review_to_continuation tool.
 */
export interface ReviewToContinuationInput {
  /** Unified diff text the notes were written against. */
  diff: string;
  /** Reviewer notes, each scoped to a path (and optionally a line). */
  notes: ReviewNote[];
}

/**
 * Output shape for the review_to_continuation tool.
 */
export interface ReviewToContinuationOutput {
  /**
   * The structured continuation prompt the agent must follow, formatted
   * deterministically and reusing the same style as
   * supervisor_emit_continuation_prompt.
   */
  continuationPrompt: string;
  /**
   * Every note the prompt obliges the agent to handle, sorted by path then
   * line. This list is exhaustive: no note is silently dropped, even if its
   * path does not appear in the diff.
   */
  mustAddress: ReviewNote[];
}

/**
 * Sort notes deterministically by (path, line). Notes without a line number
 * sort before notes with one at the same path, then by comment as tiebreaker.
 */
function sortNotes(notes: ReviewNote[]): ReviewNote[] {
  return [...notes].sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    const aLine = a.line ?? -1;
    const bLine = b.line ?? -1;
    if (aLine !== bLine) return aLine - bLine;
    return a.comment.localeCompare(b.comment);
  });
}

/**
 * Build a structured continuation directive from a diff and reviewer notes.
 *
 * Every note appears in `mustAddress` regardless of whether its path exists
 * in the diff, so that a reviewer comment on a file the agent never touched
 * cannot be silently dropped.
 */
export function reviewToContinuation(input: ReviewToContinuationInput): ReviewToContinuationOutput {
  const sorted = sortNotes(input.notes);
  const diffLineCount = input.diff.split("\n").length;

  const mustAddressLines = sorted.map(
    (n, i) =>
      `  ${i + 1}. [${n.path}${n.line !== undefined ? `:${n.line}` : ""}] ${n.comment}`
  );

  const prompt = [
    "Review continuation directive:",
    "- task: address all reviewer notes against the provided diff",
    "- requirements:",
    "  - do not restart from scratch",
    "  - address every note in the mustAddress list below",
    "  - produce deterministic evidence for each fix",
    "  - if a note's path does not appear in the diff, the agent must still",
    "    address it (the reviewer identified a missing change)",
    `- diff (${diffLineCount} lines):`,
    input.diff,
    "- must-address notes:",
    ...mustAddressLines,
  ].join("\n");

  return { continuationPrompt: prompt, mustAddress: sorted };
}

export function registerReviewToContinuationTool(server: McpServer): void {
  server.tool(
    "review_to_continuation",
    "Transform a diff plus reviewer notes into a structured continuation directive",
    {
      diff: z.string().min(1).describe("Unified diff text the notes were written against"),
      notes: z
        .array(
          z.object({
            path: z.string().min(1).describe("File path the note refers to"),
            line: z.number().int().positive().optional().describe("Optional 1-based line number"),
            comment: z.string().min(1).describe("The reviewer's comment"),
          })
        )
        .min(1)
        .describe("Reviewer notes, each scoped to a path (and optionally a line)"),
    },
    async ({ diff, notes }) => {
      const result = reviewToContinuation({ diff, notes });
      return jsonContent(result);
    }
  );
}