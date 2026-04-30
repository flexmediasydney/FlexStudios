/**
 * adapters/google.ts — placeholder for the Google (Gemini) adapter.
 *
 * The full implementation lands in W11.8 commit 4/7. This stub validates the
 * GEMINI_API_KEY env var (so the router's MissingVendorCredential contract is
 * already correct from commit 3 onwards) and otherwise throws VendorCallError
 * to indicate the network path isn't wired yet.
 *
 * Replaced wholesale in commit 4 with the generateContent + responseSchema
 * adapter.
 */

import type { VisionRequest, VisionResponse } from '../types.ts';
import { MissingVendorCredential, VendorCallError } from '../types.ts';

export async function callGoogleVision(req: VisionRequest): Promise<VisionResponse> {
  const apiKey = Deno.env.get('GEMINI_API_KEY') || '';
  if (!apiKey) {
    throw new MissingVendorCredential('google', 'GEMINI_API_KEY');
  }
  throw new VendorCallError(
    'google',
    req.model,
    'callGoogleVision: stub — full adapter ships in W11.8 commit 4/7',
  );
}
