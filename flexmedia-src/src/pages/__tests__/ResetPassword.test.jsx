import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ResetPassword from '../ResetPassword';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockUpdateUser = vi.fn();

vi.mock('@/api/supabaseClient', () => ({
  supabase: {
    auth: {
      updateUser: (...args) => mockUpdateUser(...args),
    },
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderResetPassword() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ResetPassword />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ResetPassword', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateUser.mockResolvedValue({ error: null });
  });

  // ── Renders form elements ────────────────────────────────────────────────
  it('renders the heading', () => {
    renderResetPassword();
    expect(screen.getByText('Set new password')).toBeInTheDocument();
  });

  it('renders the description', () => {
    renderResetPassword();
    expect(screen.getByText('Enter your new password below')).toBeInTheDocument();
  });

  it('renders new password input', () => {
    renderResetPassword();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
  });

  it('renders confirm password input', () => {
    renderResetPassword();
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
  });

  it('renders submit button', () => {
    renderResetPassword();
    expect(screen.getByText('Update password')).toBeInTheDocument();
  });

  // ── Validation: passwords do not match ───────────────────────────────────
  it('shows error when passwords do not match', async () => {
    renderResetPassword();
    await userEvent.type(screen.getByLabelText('New password'), 'password123');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'different456');
    await userEvent.click(screen.getByText('Update password'));

    await waitFor(() => {
      expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  // ── Validation: min length ───────────────────────────────────────────────
  it('shows error when password is too short', async () => {
    renderResetPassword();
    await userEvent.type(screen.getByLabelText('New password'), '12345');
    await userEvent.type(screen.getByLabelText('Confirm password'), '12345');
    await userEvent.click(screen.getByText('Update password'));

    await waitFor(() => {
      expect(screen.getByText('Password must be at least 6 characters')).toBeInTheDocument();
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  // ── Successful submission ────────────────────────────────────────────────
  it('calls updateUser with the password on valid submit', async () => {
    renderResetPassword();
    await userEvent.type(screen.getByLabelText('New password'), 'securepass');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'securepass');
    await userEvent.click(screen.getByText('Update password'));

    await waitFor(() => {
      expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'securepass' });
    });
  });

  it('shows success message after successful update', async () => {
    renderResetPassword();
    await userEvent.type(screen.getByLabelText('New password'), 'securepass');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'securepass');
    await userEvent.click(screen.getByText('Update password'));

    await waitFor(() => {
      expect(screen.getByText('Password updated successfully')).toBeInTheDocument();
    });
  });

  // ── API error ────────────────────────────────────────────────────────────
  it('shows error message from supabase on failure', async () => {
    mockUpdateUser.mockResolvedValue({ error: { message: 'Session expired' } });

    renderResetPassword();
    await userEvent.type(screen.getByLabelText('New password'), 'securepass');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'securepass');
    await userEvent.click(screen.getByText('Update password'));

    await waitFor(() => {
      expect(screen.getByText('Session expired')).toBeInTheDocument();
    });
  });

  it('shows generic error when updateUser throws', async () => {
    mockUpdateUser.mockRejectedValue(new Error('Network error'));

    renderResetPassword();
    await userEvent.type(screen.getByLabelText('New password'), 'securepass');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'securepass');
    await userEvent.click(screen.getByText('Update password'));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });
});
