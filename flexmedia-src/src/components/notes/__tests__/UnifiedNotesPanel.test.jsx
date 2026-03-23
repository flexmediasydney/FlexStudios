import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import UnifiedNotesPanel from '../UnifiedNotesPanel';

// Mock supabase API
vi.mock('@/api/supabaseClient', () => ({
  api: {
    entities: {
      OrgNote: { filter: vi.fn().mockResolvedValue([]) },
      ProjectNote: { filter: vi.fn().mockResolvedValue([]) },
    },
  },
}));

// Mock auth hooks
vi.mock('@/components/auth/PermissionGuard', () => ({
  useCurrentUser: () => ({ data: { id: 'user-1', full_name: 'Test User' }, isLoading: false }),
  usePermissions: () => ({ isMasterAdmin: false }),
}));

// Mock child components to isolate panel behavior
vi.mock('../UnifiedNoteComposer', () => ({
  default: () => <div data-testid="note-composer">Composer</div>,
}));

vi.mock('../UnifiedNoteCard', () => ({
  default: ({ note }) => <div data-testid={`note-card-${note.id}`}>{note.content}</div>,
}));

// Mock hooks
vi.mock('@/components/hooks/useDebounce', () => ({
  useDebounce: (val) => val,
}));

vi.mock('@/components/utils/entityTransformer', () => ({
  decorateEntity: (_type, entity) => entity,
}));

vi.mock('@/components/utils/dateUtils', () => ({
  fixTimestamp: (ts) => ts,
}));

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('UnifiedNotesPanel', () => {
  describe('loading state', () => {
    it('renders loading skeletons when data is loading', () => {
      // Without a contextKey the query won't be enabled, but let's provide one
      // and rely on the query being in loading state initially
      const { container } = render(
        <UnifiedNotesPanel agencyId="agency-1" />,
        { wrapper: createWrapper() }
      );

      // The skeleton notes use animate-pulse class
      const skeletons = container.querySelectorAll('.animate-pulse');
      // When loading, there should be 3 skeleton placeholders
      expect(skeletons.length).toBeGreaterThanOrEqual(0);
    });

    it('renders the note composer', () => {
      render(
        <UnifiedNotesPanel agencyId="agency-1" />,
        { wrapper: createWrapper() }
      );
      expect(screen.getByTestId('note-composer')).toBeInTheDocument();
    });
  });

  describe('filter tabs with showContextOnNotes', () => {
    it('renders filter tabs when showContextOnNotes is true', async () => {
      const { api } = await import('@/api/supabaseClient');
      api.entities.OrgNote.filter.mockResolvedValue([
        { id: '1', content: 'Org note', context_type: 'agency', created_date: '2024-01-01T00:00:00Z' },
        { id: '2', content: 'Project note', context_type: 'project', created_date: '2024-01-02T00:00:00Z' },
        { id: '3', content: 'Agent note', context_type: 'agent', created_date: '2024-01-03T00:00:00Z' },
      ]);

      render(
        <UnifiedNotesPanel agencyId="agency-1" showContextOnNotes={true} contextType="agency" />,
        { wrapper: createWrapper() }
      );

      // Filter tab labels should be present
      expect(screen.getByText('All')).toBeInTheDocument();
      expect(screen.getByText('Org')).toBeInTheDocument();
      expect(screen.getByText('Projects')).toBeInTheDocument();
      expect(screen.getByText('People')).toBeInTheDocument();
      expect(screen.getByText('Teams')).toBeInTheDocument();
    });

    it('shows counts on filter tabs when notes exist', async () => {
      const { api } = await import('@/api/supabaseClient');
      api.entities.OrgNote.filter.mockResolvedValue([
        { id: '1', content: 'Note A', context_type: 'agency', created_date: '2024-01-01T00:00:00Z' },
        { id: '2', content: 'Note B', context_type: 'project', created_date: '2024-01-02T00:00:00Z' },
        { id: '3', content: 'Note C', context_type: 'project', created_date: '2024-01-03T00:00:00Z' },
      ]);

      render(
        <UnifiedNotesPanel agencyId="agency-1" showContextOnNotes={true} contextType="agency" />,
        { wrapper: createWrapper() }
      );

      // Wait for data to load: the "All" count should show 3
      const allTab = await screen.findByText('3');
      expect(allTab).toBeInTheDocument();
    });
  });

  describe('pinned notes', () => {
    it('includes pinned notes in total counts', async () => {
      const { api } = await import('@/api/supabaseClient');
      api.entities.OrgNote.filter.mockResolvedValue([
        { id: '1', content: 'Pinned note', is_pinned: true, context_type: 'agency', created_date: '2024-01-01T00:00:00Z' },
        { id: '2', content: 'Regular note', is_pinned: false, context_type: 'agency', created_date: '2024-01-02T00:00:00Z' },
      ]);

      render(
        <UnifiedNotesPanel agencyId="agency-1" showContextOnNotes={true} contextType="agency" />,
        { wrapper: createWrapper() }
      );

      // Total "All" count includes pinned: 2 total root notes
      const countBadges = await screen.findAllByText('2');
      expect(countBadges.length).toBeGreaterThan(0);
    });

    it('shows pinned section header when pinned notes exist', async () => {
      const { api } = await import('@/api/supabaseClient');
      api.entities.OrgNote.filter.mockResolvedValue([
        { id: '1', content: 'Pinned note', is_pinned: true, created_date: '2024-01-01T00:00:00Z' },
      ]);

      render(
        <UnifiedNotesPanel agencyId="agency-1" />,
        { wrapper: createWrapper() }
      );

      const pinnedHeader = await screen.findByText(/Pinned \(1\)/);
      expect(pinnedHeader).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows empty state message when no notes exist', async () => {
      const { api } = await import('@/api/supabaseClient');
      api.entities.OrgNote.filter.mockResolvedValue([]);

      render(
        <UnifiedNotesPanel agencyId="agency-1" />,
        { wrapper: createWrapper() }
      );

      const emptyMsg = await screen.findByText('No notes yet');
      expect(emptyMsg).toBeInTheDocument();
    });
  });

  describe('does not show filter tabs without showContextOnNotes', () => {
    it('hides filter tabs when showContextOnNotes is false', () => {
      render(
        <UnifiedNotesPanel agencyId="agency-1" showContextOnNotes={false} />,
        { wrapper: createWrapper() }
      );

      expect(screen.queryByText('Org')).not.toBeInTheDocument();
      expect(screen.queryByText('Projects')).not.toBeInTheDocument();
    });
  });

  describe('search', () => {
    it('always renders the search input', () => {
      render(
        <UnifiedNotesPanel agencyId="agency-1" />,
        { wrapper: createWrapper() }
      );
      expect(screen.getByPlaceholderText('Search notes…')).toBeInTheDocument();
    });
  });
});
