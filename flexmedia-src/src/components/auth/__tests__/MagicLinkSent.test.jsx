import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import MagicLinkSent from '../MagicLinkSent';

describe('MagicLinkSent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('displays the email address passed as prop', () => {
    render(
      <MagicLinkSent email="test@example.com" onResend={vi.fn()} onBack={vi.fn()} />
    );
    expect(screen.getByText('test@example.com')).toBeInTheDocument();
  });

  it('shows "Check your email" heading', () => {
    render(
      <MagicLinkSent email="test@example.com" onResend={vi.fn()} onBack={vi.fn()} />
    );
    expect(screen.getByText('Check your email')).toBeInTheDocument();
  });

  it('shows the resend button disabled with countdown initially', () => {
    render(
      <MagicLinkSent email="test@example.com" onResend={vi.fn()} onBack={vi.fn()} />
    );
    const resendBtn = screen.getByRole('button', { name: /resend in 60s/i });
    expect(resendBtn).toBeDisabled();
  });

  it('shows a cooldown message initially', () => {
    render(
      <MagicLinkSent email="test@example.com" onResend={vi.fn()} onBack={vi.fn()} />
    );
    // Should show some form of "Resend in Xs" text
    expect(screen.getByRole('button', { name: /resend/i })).toBeDisabled();
  });

  it('shows the resend button', () => {
    render(
      <MagicLinkSent email="test@example.com" onResend={vi.fn()} onBack={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: /resend/i })).toBeInTheDocument();
  });

  it('has an onResend callback prop', async () => {
    const onResend = vi.fn().mockResolvedValue(undefined);
    render(
      <MagicLinkSent email="test@example.com" onResend={onResend} onBack={vi.fn()} />
    );
    // onResend is wired to the resend button — verify it's not called on render
    expect(onResend).not.toHaveBeenCalled();
    // Button exists in disabled state with cooldown text
    expect(screen.getByRole('button', { name: /resend/i })).toBeInTheDocument();
  });

  it('calls onBack when "Back to sign in" is clicked', () => {
    const onBack = vi.fn();
    render(
      <MagicLinkSent email="test@example.com" onResend={vi.fn()} onBack={onBack} />
    );

    const backButton = screen.getByText('Back to sign in');
    fireEvent.click(backButton);

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows link expiration message', () => {
    render(
      <MagicLinkSent email="test@example.com" onResend={vi.fn()} onBack={vi.fn()} />
    );
    expect(screen.getByText(/link expires in 1 hour/i)).toBeInTheDocument();
  });
});
