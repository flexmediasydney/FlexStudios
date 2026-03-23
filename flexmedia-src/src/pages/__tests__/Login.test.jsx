import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Login from '../Login';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSignInWithPassword = vi.fn();
const mockSignInWithGoogle = vi.fn();
const mockSendMagicLink = vi.fn();
const mockSendPhoneOTP = vi.fn();
const mockVerifyPhoneRegistered = vi.fn();
const mockResetPassword = vi.fn();

vi.mock('@/api/supabaseClient', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args) => mockSignInWithPassword(...args),
    },
  },
  api: {
    auth: {
      signInWithGoogle: (...args) => mockSignInWithGoogle(...args),
      sendMagicLink: (...args) => mockSendMagicLink(...args),
      sendPhoneOTP: (...args) => mockSendPhoneOTP(...args),
      verifyPhoneRegistered: (...args) => mockVerifyPhoneRegistered(...args),
      resetPassword: (...args) => mockResetPassword(...args),
    },
  },
}));

vi.mock('@/components/auth/GoogleIcon', () => ({
  default: () => <span data-testid="google-icon">G</span>,
}));

vi.mock('@/components/auth/PhoneInput', () => ({
  default: ({ value, onChange, disabled }) => (
    <input
      data-testid="phone-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder="Phone number"
    />
  ),
}));

vi.mock('@/components/auth/MagicLinkSent', () => ({
  default: ({ email, onBack }) => (
    <div data-testid="magic-link-sent">
      <span>Magic link sent to {email}</span>
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));

vi.mock('@/components/auth/PhoneOTPVerify', () => ({
  default: ({ phone, onBack, error }) => (
    <div data-testid="phone-otp-verify">
      <span>Verify {phone}</span>
      <button onClick={onBack}>Back</button>
      {error && <span>{error}</span>}
    </div>
  ),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderLogin(initialRoute = '/login') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <Login />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignInWithPassword.mockResolvedValue({ error: null });
    mockSignInWithGoogle.mockResolvedValue(undefined);
    mockSendMagicLink.mockResolvedValue(undefined);
    mockVerifyPhoneRegistered.mockResolvedValue(true);
    mockSendPhoneOTP.mockResolvedValue(undefined);
  });

  // ── Renders all key elements ─────────────────────────────────────────────
  it('renders the FlexStudios heading', () => {
    renderLogin();
    expect(screen.getByText('FlexStudios')).toBeInTheDocument();
  });

  it('renders the Google sign-in button', () => {
    renderLogin();
    expect(screen.getByText('Continue with Google')).toBeInTheDocument();
  });

  it('renders Email and Phone tab buttons', () => {
    renderLogin();
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('Phone')).toBeInTheDocument();
  });

  it('renders the magic link button (disabled when email is empty)', () => {
    renderLogin();
    const btn = screen.getByText('Send magic link').closest('button');
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it('renders password toggle text', () => {
    renderLogin();
    expect(screen.getByText('or sign in with password')).toBeInTheDocument();
  });

  it('renders Create Account link', () => {
    renderLogin();
    expect(screen.getByText('Create account')).toBeInTheDocument();
  });

  // ── Magic link button enabled with email ─────────────────────────────────
  it('enables magic link button when email is entered', async () => {
    renderLogin();
    const emailInput = screen.getByPlaceholderText('you@example.com');
    await userEvent.type(emailInput, 'test@example.com');
    const btn = screen.getByText('Send magic link').closest('button');
    expect(btn).not.toBeDisabled();
  });

  // ── Password section toggle ──────────────────────────────────────────────
  it('does not show password input initially', () => {
    renderLogin();
    expect(screen.queryByPlaceholderText('Enter your password')).not.toBeInTheDocument();
  });

  it('shows password input after clicking toggle', async () => {
    renderLogin();
    await userEvent.click(screen.getByText('or sign in with password'));
    expect(screen.getByPlaceholderText('Enter your password')).toBeInTheDocument();
  });

  it('shows Forgot password? link when password section is open', async () => {
    renderLogin();
    await userEvent.click(screen.getByText('or sign in with password'));
    expect(screen.getByText('Forgot password?')).toBeInTheDocument();
  });

  // ── Error banner on auth failure ─────────────────────────────────────────
  it('shows error banner when signInWithPassword returns error', async () => {
    mockSignInWithPassword.mockResolvedValue({
      error: { message: 'Invalid login credentials' },
    });

    renderLogin();
    const emailInput = screen.getByPlaceholderText('you@example.com');
    await userEvent.type(emailInput, 'test@example.com');
    await userEvent.click(screen.getByText('or sign in with password'));
    const passwordInput = screen.getByPlaceholderText('Enter your password');
    await userEvent.type(passwordInput, 'wrongpassword');
    await userEvent.click(screen.getByText('Sign in'));

    await waitFor(() => {
      expect(screen.getByText('Invalid email or password')).toBeInTheDocument();
    });
  });

  // ── Google sign-in ───────────────────────────────────────────────────────
  it('calls signInWithGoogle when Google button is clicked', async () => {
    renderLogin();
    await userEvent.click(screen.getByText('Continue with Google'));
    expect(mockSignInWithGoogle).toHaveBeenCalledTimes(1);
  });

  it('shows error when Google sign-in fails', async () => {
    mockSignInWithGoogle.mockRejectedValue(new Error('Google sign-in failed'));
    renderLogin();
    await userEvent.click(screen.getByText('Continue with Google'));
    await waitFor(() => {
      expect(screen.getByText('Google sign-in failed')).toBeInTheDocument();
    });
  });

  // ── Magic link flow ──────────────────────────────────────────────────────
  it('transitions to magic link sent view on success', async () => {
    renderLogin();
    const emailInput = screen.getByPlaceholderText('you@example.com');
    await userEvent.type(emailInput, 'test@example.com');
    await userEvent.click(screen.getByText('Send magic link').closest('button'));

    await waitFor(() => {
      expect(screen.getByTestId('magic-link-sent')).toBeInTheDocument();
    });
    expect(mockSendMagicLink).toHaveBeenCalledWith('test@example.com');
  });

  // ── Phone tab ────────────────────────────────────────────────────────────
  it('switches to phone tab and shows phone input', async () => {
    renderLogin();
    await userEvent.click(screen.getByText('Phone'));
    expect(screen.getByTestId('phone-input')).toBeInTheDocument();
    expect(screen.getByText('Send verification code')).toBeInTheDocument();
  });

  // ── Signups not allowed shows magic link screen (prevents enumeration) ──
  it('shows magic link sent screen even for signups-not-allowed error', async () => {
    mockSendMagicLink.mockRejectedValue(new Error('Signups not allowed'));
    renderLogin();
    const emailInput = screen.getByPlaceholderText('you@example.com');
    await userEvent.type(emailInput, 'unknown@example.com');
    await userEvent.click(screen.getByText('Send magic link').closest('button'));

    await waitFor(() => {
      expect(screen.getByTestId('magic-link-sent')).toBeInTheDocument();
    });
  });
});
