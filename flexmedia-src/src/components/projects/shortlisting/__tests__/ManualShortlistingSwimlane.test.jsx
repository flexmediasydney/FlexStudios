/**
 * ManualShortlistingSwimlane — Wave 7 P1-19 (W7.13) tests
 *
 * Renders the manual-mode swimlane with a fixture project + round and asserts:
 *   1. The two-column "Files to review" / "Approved" layout is present
 *   2. The Lock button is DISABLED when no files are approved (matches the
 *      spec: "Lock button is enabled whenever the approved set is non-empty")
 *   3. The manual-mode banner surfaces with the right reason text
 *   4. No engine-mode controls leak in (no "Run round" / Pass-X status)
 *
 * Drag-drop interaction is intentionally NOT tested here — @hello-pangea/dnd's
 * drag simulation in jsdom is fragile (HTML5 DataTransfer doesn't exist), and
 * the shipped engine-mode swimlane doesn't test drags either. We test the
 * resolve/lock contract via the backend manualModeResolver.test.ts.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock supabase API — listDropboxFiles is the network call manual mode makes
// at mount; we control its return value to drive the test fixtures.
const mockListFiles = vi.fn();
const mockGetPreview = vi.fn();
const mockShortlistLock = vi.fn();

vi.mock('@/api/supabaseClient', () => ({
  api: {
    functions: {
      invoke: (fnName, params) => {
        if (fnName === 'listDropboxFiles') return mockListFiles(params);
        if (fnName === 'getDropboxFilePreview') return mockGetPreview(params);
        if (fnName === 'shortlist-lock') return mockShortlistLock(params);
        return Promise.resolve({ data: {} });
      },
    },
  },
}));

// Mock toast — no UI to render, just collect calls if needed.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

// LockProgressDialog renders nothing in tests — we only care about the
// swimlane's own render contract. Stub it out.
vi.mock('../LockProgressDialog', () => ({
  default: () => null,
}));

import ManualShortlistingSwimlane from '../ManualShortlistingSwimlane';

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const FIXTURE_PROJECT = {
  id: 'project-uuid-001',
  dropbox_root_path: '/Acme/Projects/abc-lot-45',
  // project_type_id intentionally points at a manual-mode type — but the
  // swimlane itself doesn't read project_type (the parent ProjectShortlistingTab
  // does, then dispatches to ManualShortlistingSwimlane). The test fixture
  // shape mirrors what the parent passes through.
  project_type_id: 'pt-uuid-manual',
};

const FIXTURE_ROUND_PROJECT_TYPE_UNSUPPORTED = {
  id: 'round-uuid-001',
  round_number: 1,
  status: 'manual',
  manual_mode_reason: 'project_type_unsupported',
};

const FIXTURE_ROUND_NO_PHOTO_PRODUCTS = {
  id: 'round-uuid-002',
  round_number: 1,
  status: 'manual',
  manual_mode_reason: 'no_photo_products',
};

const FIXTURE_ROUND_LOCKED = {
  id: 'round-uuid-003',
  round_number: 2,
  status: 'locked',
  manual_mode_reason: 'project_type_unsupported',
};

beforeEach(() => {
  mockListFiles.mockReset();
  mockGetPreview.mockReset();
  mockShortlistLock.mockReset();
  // Default: empty source folder. Individual tests override.
  mockListFiles.mockResolvedValue({ files: [] });
  // Preview mock — return null so the FileImage fallback renders deterministically.
  mockGetPreview.mockResolvedValue({ data: { url: null } });
});

describe('ManualShortlistingSwimlane', () => {
  it('renders the two-column "Files to review" / "Approved" layout', async () => {
    mockListFiles.mockResolvedValue({
      files: [
        { name: 'IMG_1.jpg', path: '/Acme/Projects/abc-lot-45/Photos/Raws/Shortlist Proposed/IMG_1.jpg' },
      ],
    });
    render(
      <ManualShortlistingSwimlane
        roundId={FIXTURE_ROUND_PROJECT_TYPE_UNSUPPORTED.id}
        round={FIXTURE_ROUND_PROJECT_TYPE_UNSUPPORTED}
        projectId={FIXTURE_PROJECT.id}
        project={FIXTURE_PROJECT}
      />,
      { wrapper: createWrapper() },
    );

    // Wait for the file list query to resolve + render.
    await screen.findByText('Files to review');
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('renders the manual-mode banner with project_type_unsupported reason', async () => {
    render(
      <ManualShortlistingSwimlane
        roundId={FIXTURE_ROUND_PROJECT_TYPE_UNSUPPORTED.id}
        round={FIXTURE_ROUND_PROJECT_TYPE_UNSUPPORTED}
        projectId={FIXTURE_PROJECT.id}
        project={FIXTURE_PROJECT}
      />,
      { wrapper: createWrapper() },
    );

    // Banner header
    await screen.findByText('Manual mode');
    // Reason-specific copy: "AI shortlisting is disabled for this project type"
    expect(
      screen.getByText(/AI shortlisting is disabled for this project type/i),
    ).toBeInTheDocument();
  });

  it('renders the manual-mode banner with no_photo_products reason', async () => {
    render(
      <ManualShortlistingSwimlane
        roundId={FIXTURE_ROUND_NO_PHOTO_PRODUCTS.id}
        round={FIXTURE_ROUND_NO_PHOTO_PRODUCTS}
        projectId={FIXTURE_PROJECT.id}
        project={FIXTURE_PROJECT}
      />,
      { wrapper: createWrapper() },
    );
    await screen.findByText('Manual mode');
    expect(
      screen.getByText(/no photo deliverables/i),
    ).toBeInTheDocument();
  });

  it('does NOT render engine-mode controls (no Run round, no Pass-X status)', async () => {
    render(
      <ManualShortlistingSwimlane
        roundId={FIXTURE_ROUND_PROJECT_TYPE_UNSUPPORTED.id}
        round={FIXTURE_ROUND_PROJECT_TYPE_UNSUPPORTED}
        projectId={FIXTURE_PROJECT.id}
        project={FIXTURE_PROJECT}
      />,
      { wrapper: createWrapper() },
    );

    await screen.findByText('Files to review');

    // No "Run round" / "Run shortlist" copy from engine swimlane.
    expect(screen.queryByText(/run round/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/run shortlist/i)).not.toBeInTheDocument();
    // No engine column headers.
    expect(screen.queryByText(/AI PROPOSED/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/REJECTED/i)).not.toBeInTheDocument();
  });

  it('Lock button is disabled when no files are approved (empty approved set)', async () => {
    mockListFiles.mockResolvedValue({
      files: [
        { name: 'IMG_1.jpg', path: '/Acme/Projects/abc-lot-45/Photos/Raws/Shortlist Proposed/IMG_1.jpg' },
        { name: 'IMG_2.jpg', path: '/Acme/Projects/abc-lot-45/Photos/Raws/Shortlist Proposed/IMG_2.jpg' },
      ],
    });
    render(
      <ManualShortlistingSwimlane
        roundId={FIXTURE_ROUND_PROJECT_TYPE_UNSUPPORTED.id}
        round={FIXTURE_ROUND_PROJECT_TYPE_UNSUPPORTED}
        projectId={FIXTURE_PROJECT.id}
        project={FIXTURE_PROJECT}
      />,
      { wrapper: createWrapper() },
    );
    const lockBtn = await screen.findByTestId('manual-shortlisting-lock');
    // Empty approved set → button is disabled (per spec § "Manual mode":
    // "Lock button is enabled whenever the approved set is non-empty").
    expect(lockBtn).toBeDisabled();
    // Title prop spells out why so the operator gets a hover hint.
    expect(lockBtn).toHaveAttribute(
      'title',
      'Drag at least one file to Approved before locking',
    );
  });

  it('Lock button shows "Locked" + disabled when round is already locked', async () => {
    render(
      <ManualShortlistingSwimlane
        roundId={FIXTURE_ROUND_LOCKED.id}
        round={FIXTURE_ROUND_LOCKED}
        projectId={FIXTURE_PROJECT.id}
        project={FIXTURE_PROJECT}
      />,
      { wrapper: createWrapper() },
    );
    const lockBtn = await screen.findByTestId('manual-shortlisting-lock');
    expect(lockBtn).toBeDisabled();
    expect(lockBtn.textContent).toContain('Locked');
  });

  it('renders an unprovisioned-project warning when dropbox_root_path is missing', async () => {
    const projectWithoutRoot = { ...FIXTURE_PROJECT, dropbox_root_path: null };
    render(
      <ManualShortlistingSwimlane
        roundId={FIXTURE_ROUND_PROJECT_TYPE_UNSUPPORTED.id}
        round={FIXTURE_ROUND_PROJECT_TYPE_UNSUPPORTED}
        projectId={FIXTURE_PROJECT.id}
        project={projectWithoutRoot}
      />,
      { wrapper: createWrapper() },
    );
    expect(
      await screen.findByText(/Project Dropbox folder not provisioned/i),
    ).toBeInTheDocument();
  });

  it('shows file count + approved count in the action bar', async () => {
    mockListFiles.mockResolvedValue({
      files: [
        { name: 'IMG_1.jpg', path: '/Acme/Projects/abc-lot-45/Photos/Raws/Shortlist Proposed/IMG_1.jpg' },
        { name: 'IMG_2.jpg', path: '/Acme/Projects/abc-lot-45/Photos/Raws/Shortlist Proposed/IMG_2.jpg' },
        { name: 'IMG_3.jpg', path: '/Acme/Projects/abc-lot-45/Photos/Raws/Shortlist Proposed/IMG_3.jpg' },
      ],
    });
    render(
      <ManualShortlistingSwimlane
        roundId={FIXTURE_ROUND_PROJECT_TYPE_UNSUPPORTED.id}
        round={FIXTURE_ROUND_PROJECT_TYPE_UNSUPPORTED}
        projectId={FIXTURE_PROJECT.id}
        project={FIXTURE_PROJECT}
      />,
      { wrapper: createWrapper() },
    );
    expect(
      await screen.findByText(/3 files in source folder/i),
    ).toBeInTheDocument();
    expect(screen.getByText('0 approved')).toBeInTheDocument();
  });
});
