/**
 * assemble.ts — Wave 7 P1-10 (W7.6): typed assembly API for vision prompts.
 *
 * Joins ordered lists of `BlockEntry` fragments (system + user) into the
 * `AssembledPrompt` shape consumed by `shortlisting-shape-d` (formerly the
 * sunset `shortlisting-pass1` / `shortlisting-pass2` pair) — system message
 * + userPrefix + provenance map of block versions.
 *
 * The API is intentionally explicit:
 *   - Caller passes `BlockEntry[]` (name + version + rendered text).
 *   - `name` becomes the key in `blockVersions`, `version` the value.
 *   - Order is preserved — block order is part of the prompt contract.
 *
 * Why explicit BlockEntry[] over auto-detection from imports? It makes the
 * order and provenance visible at the call site (greppable, auditable). Wave
 * 11 will swap blocks in/out by editing one array literal — a dynamic-import
 * approach would hide that surface area.
 *
 * Pure function: deterministic, no IO, no Date.now().
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BlockEntry {
  /** Block identity — also the key persisted in `prompt_block_versions` JSONB. */
  name: string;
  /** Version stamp — bumps when the block's text changes. */
  version: string;
  /** The rendered text fragment from the block's pure builder function. */
  text: string;
}

export interface AssembledPrompt {
  /** System message — sets role and the reasoning-first STEP 1/STEP 2 contract. */
  system: string;
  /** User-message text part. Caller appends image content part after this for Pass 1. */
  userPrefix: string;
  /** Map of block name → version. Persist this on the run row for provenance. */
  blockVersions: Record<string, string>;
}

export interface AssembleInput {
  /** Ordered system-message blocks. Joined with `separator` (default '\n\n'). */
  systemBlocks: BlockEntry[];
  /** Ordered user-message blocks. Joined with `separator` (default '\n\n'). */
  userBlocks: BlockEntry[];
  /** Separator between blocks. Defaults to `\n\n`. */
  separator?: string;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Assemble a prompt from ordered system + user block entries.
 *
 * `blockVersions` aggregates every entry across both lists. If two blocks
 * share a `name` (intentional or accidental), the later one wins — callers
 * should keep names unique within a single assemble call.
 */
export function assemble(input: AssembleInput): AssembledPrompt {
  const sep = input.separator ?? '\n\n';

  const system = input.systemBlocks.map((b) => b.text).join(sep);
  const userPrefix = input.userBlocks.map((b) => b.text).join(sep);

  const blockVersions: Record<string, string> = {};
  for (const b of input.systemBlocks) blockVersions[b.name] = b.version;
  for (const b of input.userBlocks) blockVersions[b.name] = b.version;

  return { system, userPrefix, blockVersions };
}
