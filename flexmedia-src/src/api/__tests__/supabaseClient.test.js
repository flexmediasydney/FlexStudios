/**
 * Smoke tests for supabaseClient.js — focused on the entity-name → table-name
 * pluraliser. The full Supabase client is shimmed because we don't need a real
 * connection to validate the mapper.
 *
 * Bug context (W15b QC fix wave): the default pluraliser appended `es` to
 * names ending in `s` and `s` otherwise, producing wrong table names for
 *   PulseListingVisionExtracts → pulse_listing_vision_extractses
 *   PulseListingMissedOpportunity → pulse_listing_missed_opportunities
 * Both pages 404'd in prod. The override map in supabaseClient.js fixes this;
 * these tests guard against regression.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

// Stub @supabase/supabase-js BEFORE importing supabaseClient — the real
// createClient throws "supabaseUrl is required" when env vars are absent in
// the vitest environment, which would crash the module-level evaluation.
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(),
    auth: { getUser: vi.fn(), signOut: vi.fn() },
    functions: { invoke: vi.fn() },
    channel: vi.fn(),
    removeChannel: vi.fn(),
    storage: { from: vi.fn() },
    rpc: vi.fn(),
  })),
}));

let entityNameToTable;

beforeAll(async () => {
  // Dynamic import so the mock above takes effect before module evaluation.
  const mod = await import('../supabaseClient');
  entityNameToTable = mod.entityNameToTable;
});

describe('entityNameToTable — pluraliser overrides', () => {
  // ─── W15b QC fix: explicit overrides for tables ending in `s` ──────────────
  it('maps PulseListingVisionExtracts → pulse_listing_vision_extracts (override)', () => {
    expect(entityNameToTable('PulseListingVisionExtracts')).toBe(
      'pulse_listing_vision_extracts'
    );
  });

  it('maps PulseListingMissedOpportunity → pulse_listing_missed_opportunity (singular by design)', () => {
    expect(entityNameToTable('PulseListingMissedOpportunity')).toBe(
      'pulse_listing_missed_opportunity'
    );
  });

  // ─── Standard pluralisation should still work for normal entities ──────────
  it('maps Project → projects (standard pluralisation)', () => {
    expect(entityNameToTable('Project')).toBe('projects');
  });

  it('maps ProjectTask → project_tasks (PascalCase + standard pluralisation)', () => {
    expect(entityNameToTable('ProjectTask')).toBe('project_tasks');
  });

  it('maps Agency → agencies (y → ies override)', () => {
    expect(entityNameToTable('Agency')).toBe('agencies');
  });

  // ─── Pre-existing overrides should not regress ─────────────────────────────
  it('maps DronePoisCache → drone_pois_cache (singular cache override)', () => {
    expect(entityNameToTable('DronePoisCache')).toBe('drone_pois_cache');
  });

  it('maps ShortlistingQuarantine → shortlisting_quarantine (singular bucket override)', () => {
    expect(entityNameToTable('ShortlistingQuarantine')).toBe(
      'shortlisting_quarantine'
    );
  });

  // ─── W12.B: Object Registry overrides — without these the admin page 404s ──
  it('maps ObjectRegistry → object_registry (W12.B singular override)', () => {
    expect(entityNameToTable('ObjectRegistry')).toBe('object_registry');
  });

  it('maps ObjectRegistryCandidate → object_registry_candidates (default plural is correct)', () => {
    expect(entityNameToTable('ObjectRegistryCandidate')).toBe(
      'object_registry_candidates'
    );
  });

  it('maps RawAttributeObservation → raw_attribute_observations (default plural is correct)', () => {
    expect(entityNameToTable('RawAttributeObservation')).toBe(
      'raw_attribute_observations'
    );
  });

  // ─── W12.7-12.8: shortlisting suggestion entities ──────────────────────────
  it('maps ShortlistingSlotSuggestion → shortlisting_slot_suggestions', () => {
    expect(entityNameToTable('ShortlistingSlotSuggestion')).toBe(
      'shortlisting_slot_suggestions'
    );
  });

  it('maps ShortlistingRoomTypeSuggestion → shortlisting_room_type_suggestions', () => {
    expect(entityNameToTable('ShortlistingRoomTypeSuggestion')).toBe(
      'shortlisting_room_type_suggestions'
    );
  });

  // ─── W14: calibration session entities (mig 407) ──────────────────────────
  it('maps CalibrationSession → calibration_sessions', () => {
    expect(entityNameToTable('CalibrationSession')).toBe('calibration_sessions');
  });

  it('maps CalibrationEditorShortlist → calibration_editor_shortlists', () => {
    expect(entityNameToTable('CalibrationEditorShortlist')).toBe(
      'calibration_editor_shortlists'
    );
  });

  it('maps CalibrationDecision → calibration_decisions', () => {
    expect(entityNameToTable('CalibrationDecision')).toBe('calibration_decisions');
  });
});
