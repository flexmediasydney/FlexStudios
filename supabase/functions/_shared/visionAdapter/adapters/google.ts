/**
 * adapters/google.ts — placeholder for the Google (Gemini) adapter.
 *
 * The full implementation lands in W11.8 commit 4/7. This stub exists so the
 * router (`../index.ts`) compiles cleanly when the types + pricing land first.
 * Calling it at runtime throws explicitly.
 *
 * Replaced wholesale in commit 4 with the generateContent + responseSchema
 * adapter.
 */

import type { VisionRequest, VisionResponse } from '../types.ts';
import { VendorCallError } from '../types.ts';

export async function callGoogleVision(_req: VisionRequest): Promise<VisionResponse> {
  throw new VendorCallError(
    'google',
    _req.model,
    'callGoogleVision: stub — full adapter ships in W11.8 commit 4/7',
  );
}
