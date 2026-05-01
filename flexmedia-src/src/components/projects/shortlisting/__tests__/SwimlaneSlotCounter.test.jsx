/**
 * SwimlaneSlotCounter — W11.6.1-hotfix-2 BUG #1 tests
 *
 * Verifies the slot counter banner reads `proposedSlotIds` (a Set of slot_ids
 * derived in the parent from `shortlisting_overrides` ai_proposed rows) and
 * renders the correct Phase 1/2/3 filled-vs-expected badges.
 *
 * Pre-fix behaviour (regression we guard against): the parent built
 * `proposedSlotIds` from legacy `slotEvents` (pass2 events) which Shape D
 * never emits; Shape D rounds rendered `0/5 · 0/13 · 0/0` even with 8 valid
 * ai_proposed override rows. Post-fix, the parent reads from
 * `shortlisting_overrides`; this component just trusts the Set it gets.
 *
 * We test the COMPONENT contract here.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// SwimlaneToolbar imports from supabaseClient — stub it so the test bootstrap
// doesn't blow up on missing env vars. SwimlaneSlotCounter itself doesn't
// touch the client; only the toolbar's elapsed-timer hook does.
vi.mock('@/api/supabaseClient', () => ({
  api: {
    entities: {
      ShortlistingJob: { filter: vi.fn().mockResolvedValue([]) },
    },
    functions: { invoke: vi.fn().mockResolvedValue({ data: {} }) },
  },
}));

import { SwimlaneSlotCounter } from '../SwimlaneToolbar';

describe('SwimlaneSlotCounter', () => {
  it('renders zeros when no slots are filled', () => {
    render(<SwimlaneSlotCounter proposedSlotIds={new Set()} packageCeiling={10} />);
    expect(screen.getByTestId('slot-counter-phase-1-filled').textContent).toBe('0');
    expect(screen.getByTestId('slot-counter-phase-2-filled').textContent).toBe('0');
    expect(screen.getByTestId('slot-counter-phase-3-filled').textContent).toBe('0');
  });

  it('renders Rainbow Cres ai_proposed slots correctly (BUG #1 regression guard)', () => {
    // The 8 ai_proposed rows on Rainbow Cres:
    //   bathroom_main (P2), entry_hero (P2), exterior_facade_hero (P1),
    //   exterior_rear (P2), games_room (P3), kitchen_hero (P1),
    //   living_hero (P1), master_bedroom_hero (P1)
    const proposedSlotIds = new Set([
      'bathroom_main',
      'entry_hero',
      'exterior_facade_hero',
      'exterior_rear',
      'games_room',
      'kitchen_hero',
      'living_hero',
      'master_bedroom_hero',
    ]);

    render(
      <SwimlaneSlotCounter
        proposedSlotIds={proposedSlotIds}
        packageCeiling={10}
      />,
    );

    // Phase 1: 4 filled (exterior_facade_hero, kitchen_hero, living_hero,
    // master_bedroom_hero) of 5 expected.
    expect(screen.getByTestId('slot-counter-phase-1-filled').textContent).toBe('4');
    expect(screen.getByTestId('slot-counter-phase-1-expected').textContent).toBe('5');

    // Phase 2: 3 filled (bathroom_main, entry_hero, exterior_rear) of 13.
    expect(screen.getByTestId('slot-counter-phase-2-filled').textContent).toBe('3');
    expect(screen.getByTestId('slot-counter-phase-2-expected').textContent).toBe('13');

    // Phase 3: 1 filled (games_room). Phase 3 expected is capped at 0
    // because packageCeiling - phase1 - phase2 = 10 - 5 - 13 = -8.
    expect(screen.getByTestId('slot-counter-phase-3-filled').textContent).toBe('1');
    expect(screen.getByTestId('slot-counter-phase-3-expected').textContent).toBe('0');
  });

  it('counts ai_recommended sentinel under Phase 3', () => {
    render(
      <SwimlaneSlotCounter
        proposedSlotIds={new Set(['ai_recommended'])}
        packageCeiling={24}
      />,
    );
    expect(screen.getByTestId('slot-counter-phase-3-filled').textContent).toBe('1');
  });

  it('exposes data-testid on the banner for live debugging', () => {
    render(<SwimlaneSlotCounter proposedSlotIds={new Set()} packageCeiling={10} />);
    expect(screen.getByTestId('swimlane-slot-counter')).toBeTruthy();
  });
});
