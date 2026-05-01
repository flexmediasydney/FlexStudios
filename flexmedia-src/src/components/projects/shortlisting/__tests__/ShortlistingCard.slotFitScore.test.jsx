/**
 * W11.6.15 — ShortlistingCard slot_fit_score render tests.
 *
 * Run: npx vitest run flexmedia-src/src/components/projects/shortlisting/__tests__/ShortlistingCard.slotFitScore.test.jsx
 *
 * Covers:
 *  1. Card renders the existing Quality (avg=) line — backstop so the legacy
 *     UX survives the W11.6.15 addition.
 *  2. Card renders a NEW "Slot fit: X.X" line under the Quality line when the
 *     ShortlistingOverride row has slot_fit_score populated.
 *  3. Slot-fit row gets the amber-highlight class when delta > 2.0
 *     (slot_fit_score - combined_score > 2.0). Joseph's foyer case:
 *     combined=6.05, slot_fit=9.0 -> delta=2.95 -> amber.
 *  4. Slot-fit row stays muted (NO amber class) when slot_fit_score <= combined
 *     or delta <= 2.0.
 *  5. Card renders ONLY the Quality line when slot_fit_score is null
 *     (legacy / pre-W11.6.15 rounds).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockOverrideFilter = vi.fn();
const mockCompositionGroupFilter = vi.fn();

vi.mock('@/api/supabaseClient', () => ({
  api: {
    entities: {
      ShortlistingOverride: { filter: (...args) => mockOverrideFilter(...args) },
      CompositionGroup: { filter: (...args) => mockCompositionGroupFilter(...args) },
    },
  },
  supabase: {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
                then: (resolve) => resolve({ data: [], error: null }),
              };
            },
          };
        },
      };
    },
  },
}));

vi.mock('@/components/drone/DroneThumbnail', () => ({
  default: function DroneThumbnailStub({ alt }) {
    return <div data-testid="drone-thumb-stub">{alt}</div>;
  },
}));

import ShortlistingCard from '../ShortlistingCard';

const ROUND_ID = 'round-uuid-001';
const GROUP_ID = 'group-uuid-001';
const SLOT_ID = 'entry_hero';

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function makeComposition({ combined_score = 6.05 } = {}) {
  return {
    id: GROUP_ID,
    round_id: ROUND_ID,
    delivery_reference_stem: 'IMG_034A7961',
    best_bracket_stem: 'IMG_034A7961',
    dropbox_preview_path: '/preview/IMG_034A7961.jpg',
    classification: {
      combined_score,
      technical_score: 6.0,
      lighting_score: 5.0,
      composition_score: 7.0,
      aesthetic_score: 6.5,
      room_type: 'hallway',
      analysis: 'corner shot of foyer-as-subject',
    },
    slot: { slot_id: SLOT_ID, phase: 1, rank: 1 },
  };
}

async function flushAsync() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  mockOverrideFilter.mockReset();
  mockCompositionGroupFilter.mockReset().mockResolvedValue([]);
});

describe('ShortlistingCard - W11.6.15 slot_fit_score', () => {
  it('renders the existing Quality (avg=) line', async () => {
    mockOverrideFilter.mockResolvedValue([]);
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <ShortlistingCard composition={makeComposition()} column="proposed" />
      </Wrapper>,
    );
    await flushAsync();
    expect(await screen.findByText(/avg=6\.0/)).toBeTruthy();
  });

  it('renders a Slot fit row when slot_fit_score is present', async () => {
    mockOverrideFilter.mockResolvedValue([
      {
        id: 'override-1',
        round_id: ROUND_ID,
        ai_proposed_group_id: GROUP_ID,
        ai_proposed_slot_id: SLOT_ID,
        ai_proposed_score: 6.05,
        slot_fit_score: 9.0,
        human_action: 'ai_proposed',
      },
    ]);
    const Wrapper = createWrapper();
    const { container } = render(
      <Wrapper>
        <ShortlistingCard composition={makeComposition()} column="proposed" />
      </Wrapper>,
    );
    await flushAsync();
    expect(await screen.findByText(/Slot fit/i)).toBeTruthy();
    expect(await screen.findByText(/9\.0/)).toBeTruthy();
    const fitRow = container.querySelector('[data-slot-fit-score]');
    expect(fitRow).toBeTruthy();
    expect(fitRow.getAttribute('data-slot-fit-score')).toBe('9');
  });

  it('amber highlight when slot_fit > combined by > 2.0', async () => {
    mockOverrideFilter.mockResolvedValue([
      {
        id: 'override-1',
        round_id: ROUND_ID,
        ai_proposed_group_id: GROUP_ID,
        ai_proposed_slot_id: SLOT_ID,
        ai_proposed_score: 6.05,
        slot_fit_score: 9.0,
        human_action: 'ai_proposed',
      },
    ]);
    const Wrapper = createWrapper();
    const { container } = render(
      <Wrapper>
        <ShortlistingCard
          composition={makeComposition({ combined_score: 6.05 })}
          column="proposed"
        />
      </Wrapper>,
    );
    await flushAsync();
    const fitRow = container.querySelector('[data-slot-fit-score]');
    expect(fitRow).toBeTruthy();
    expect(fitRow.getAttribute('data-slot-fit-amber')).toBe('true');
  });

  it('NO amber when slot_fit_score is comparable to combined (delta <= 2.0)', async () => {
    mockOverrideFilter.mockResolvedValue([
      {
        id: 'override-1',
        round_id: ROUND_ID,
        ai_proposed_group_id: GROUP_ID,
        ai_proposed_slot_id: SLOT_ID,
        ai_proposed_score: 6.05,
        slot_fit_score: 7.0,
        human_action: 'ai_proposed',
      },
    ]);
    const Wrapper = createWrapper();
    const { container } = render(
      <Wrapper>
        <ShortlistingCard
          composition={makeComposition({ combined_score: 6.05 })}
          column="proposed"
        />
      </Wrapper>,
    );
    await flushAsync();
    const fitRow = container.querySelector('[data-slot-fit-score]');
    expect(fitRow).toBeTruthy();
    expect(fitRow.getAttribute('data-slot-fit-amber')).toBe('false');
  });

  it('does NOT render Slot fit row when slot_fit_score is null (legacy)', async () => {
    mockOverrideFilter.mockResolvedValue([
      {
        id: 'override-1',
        round_id: ROUND_ID,
        ai_proposed_group_id: GROUP_ID,
        ai_proposed_slot_id: SLOT_ID,
        ai_proposed_score: 6.05,
        slot_fit_score: null,
        human_action: 'ai_proposed',
      },
    ]);
    const Wrapper = createWrapper();
    const { container } = render(
      <Wrapper>
        <ShortlistingCard composition={makeComposition()} column="proposed" />
      </Wrapper>,
    );
    await flushAsync();
    expect(container.querySelector('[data-slot-fit-score]')).toBeNull();
    expect(screen.queryByText(/Slot fit/i)).toBeNull();
    expect(screen.getByText(/avg=6\.0/)).toBeTruthy();
  });
});
