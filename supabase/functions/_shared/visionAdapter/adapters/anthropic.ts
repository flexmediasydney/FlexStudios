/**
 * adapters/anthropic.ts — placeholder for the Anthropic adapter.
 *
 * The full implementation lands in the next commit (W11.8 commit 3/7). This
 * stub exists so the router (`../index.ts`) compiles cleanly when the types
 * + pricing land first. Calling it at runtime throws explicitly.
 *
 * Replaced wholesale in commit 3 with the tool-use + prompt-cache adapter.
 */

import type { VisionRequest, VisionResponse } from '../types.ts';
import { VendorCallError } from '../types.ts';

export async function callAnthropicVision(_req: VisionRequest): Promise<VisionResponse> {
  throw new VendorCallError(
    'anthropic',
    _req.model,
    'callAnthropicVision: stub — full adapter ships in W11.8 commit 3/7',
  );
}
