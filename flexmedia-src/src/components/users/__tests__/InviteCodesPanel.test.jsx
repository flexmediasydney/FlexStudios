import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InviteCodesPanel from '../InviteCodesPanel';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockListInviteCodes = vi.fn();
const mockCreateInviteCode = vi.fn();

vi.mock('@/api/supabaseClient', () => ({
  api: {
    entities: {
      InviteCode: {
        list: (...args) => mockListInviteCodes(...args),
        create: (...args) => mockCreateInviteCode(...args),
        delete: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
      },
    },
  },
}));

vi.mock('@/components/auth/PermissionGuard', () => ({
  useCurrentUser: () => ({
    data: { id: 'user-1', full_name: 'Test Admin' },
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <InviteCodesPanel />
    </QueryClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InviteCodesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListInviteCodes.mockResolvedValue([]);
    mockCreateInviteCode.mockResolvedValue({ id: 'new-1' });
  });

  // ── Empty state ──────────────────────────────────────────────────────────
  it('renders the heading', async () => {
    renderPanel();
    expect(screen.getByText('Invite Codes')).toBeInTheDocument();
  });

  it('renders empty state when no codes exist', async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/No invite codes yet/)).toBeInTheDocument();
    });
  });

  it('renders Generate Code button', () => {
    renderPanel();
    expect(screen.getByText('Generate Code')).toBeInTheDocument();
  });

  // ── Code generation format ───────────────────────────────────────────────
  it('opens create dialog when Generate Code is clicked', async () => {
    renderPanel();
    await userEvent.click(screen.getByText('Generate Code'));
    await waitFor(() => {
      expect(screen.getByText('Generate Invite Code')).toBeInTheDocument();
    });
  });

  it('pre-fills code input with FLEX-XXXXXX format', async () => {
    renderPanel();
    await userEvent.click(screen.getByText('Generate Code'));

    await waitFor(() => {
      const codeInputs = screen.getAllByDisplayValue(/^FLEX-/);
      expect(codeInputs.length).toBeGreaterThan(0);
      const codeValue = codeInputs[0].value;
      expect(codeValue).toMatch(/^FLEX-[A-Z2-9]{6}$/);
    });
  });

  it('generated codes only contain unambiguous characters (no I/O/0/1)', async () => {
    renderPanel();
    await userEvent.click(screen.getByText('Generate Code'));

    await waitFor(() => {
      const codeInputs = screen.getAllByDisplayValue(/^FLEX-/);
      const suffix = codeInputs[0].value.replace('FLEX-', '');
      expect(suffix).not.toMatch(/[IO01]/);
    });
  });

  // ── Code validation (tested via handleCreate logic) ──────────────────────
  it('shows create dialog with role selector defaulting to Contractor', async () => {
    renderPanel();
    await userEvent.click(screen.getByText('Generate Code'));

    await waitFor(() => {
      expect(screen.getByText('Contractor')).toBeInTheDocument();
    });
  });

  it('shows cancel and create buttons in dialog', async () => {
    renderPanel();
    await userEvent.click(screen.getByText('Generate Code'));

    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.getByText('Create Code')).toBeInTheDocument();
    });
  });

  // ── Codes list rendering ─────────────────────────────────────────────────
  it('renders codes in a table when codes exist', async () => {
    mockListInviteCodes.mockResolvedValue([
      {
        id: '1',
        code: 'FLEX-ABC123',
        role: 'contractor',
        max_uses: 5,
        use_count: 2,
        is_active: true,
        created_at: '2026-03-01T00:00:00Z',
        created_by_name: 'Admin',
        note: 'For photographers',
      },
    ]);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('FLEX-ABC123')).toBeInTheDocument();
    });
    expect(screen.getByText('Contractor')).toBeInTheDocument();
    expect(screen.getByText('2/5')).toBeInTheDocument();
    expect(screen.getByText('For photographers')).toBeInTheDocument();
  });

  it('shows active/expired counts in subtitle', async () => {
    mockListInviteCodes.mockResolvedValue([
      { id: '1', code: 'FLEX-AAA111', role: 'contractor', max_uses: 1, use_count: 0, is_active: true, created_at: '2026-03-01T00:00:00Z' },
      { id: '2', code: 'FLEX-BBB222', role: 'employee', max_uses: 1, use_count: 1, is_active: false, created_at: '2026-02-01T00:00:00Z' },
    ]);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('1 active, 1 expired/disabled')).toBeInTheDocument();
    });
  });

  it('shows Active badge for active codes', async () => {
    mockListInviteCodes.mockResolvedValue([
      { id: '1', code: 'FLEX-ACT111', role: 'contractor', max_uses: 5, use_count: 0, is_active: true, created_at: '2026-03-01T00:00:00Z' },
    ]);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
  });
});
