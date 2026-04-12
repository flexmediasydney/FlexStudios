import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/api/supabaseClient';
import { api } from '@/api/supabaseClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AlertCircle, Loader2, ChevronDown, ChevronUp, Mail, ArrowLeft } from 'lucide-react';
import GoogleIcon from '@/components/auth/GoogleIcon';
import PhoneInput from '@/components/auth/PhoneInput';
import MagicLinkSent from '@/components/auth/MagicLinkSent';
import PhoneOTPVerify from '@/components/auth/PhoneOTPVerify';

// ─── State Machine ────────────────────────────────────────────────────────────
// MAIN            → Primary view with Google + Email/Phone tabs
// MAGIC_LINK_SENT → "Check your email" confirmation
// PHONE_OTP       → Enter 6-digit phone code
// FORGOT_PASSWORD → Enter email for reset link
// FORGOT_SENT     → "Check email for reset link"

export default function Login() {
  const [view, setView] = useState('MAIN');
  const [tab, setTab] = useState('email'); // 'email' | 'phone'
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Persistent brute force protection — survives page refresh
  const getLoginState = () => {
    try {
      const raw = localStorage.getItem('_login_protection');
      if (!raw) return { attempts: 0, lockedUntil: 0, lockCount: 0 };
      return JSON.parse(raw);
    } catch { return { attempts: 0, lockedUntil: 0, lockCount: 0 }; }
  };
  const saveLoginState = (state) => {
    try { localStorage.setItem('_login_protection', JSON.stringify(state)); } catch {}
  };
  const [loginState, setLoginState] = useState(getLoginState);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Validate redirect parameter — prevent open redirect attacks
  const rawRedirect = searchParams.get('redirect') || '/';
  const redirect = (() => {
    try {
      // Must start with / and not be protocol-relative (//)
      if (!rawRedirect.startsWith('/') || rawRedirect.startsWith('//')) return '/';
      // Parse against our origin to catch encoded attacks (%2F%2F, /\, etc.)
      const parsed = new URL(rawRedirect, window.location.origin);
      if (parsed.hostname !== window.location.hostname) return '/';
      // Only allow the pathname + search (strip any hash that could contain scripts)
      return parsed.pathname + parsed.search;
    } catch {
      return '/';
    }
  })();

  // Escalating brute force protection — persists across page refreshes via localStorage
  const MAX_ATTEMPTS = 5;
  const LOCKOUT_DURATIONS = [30_000, 60_000, 120_000, 300_000, 600_000]; // 30s, 1m, 2m, 5m, 10m

  const checkRateLimit = () => {
    const fresh = getLoginState(); // Read latest from localStorage (cross-tab sync)
    if (fresh.lockedUntil && Date.now() < fresh.lockedUntil) {
      const secs = Math.ceil((fresh.lockedUntil - Date.now()) / 1000);
      const mins = Math.floor(secs / 60);
      setError(mins > 0
        ? `Too many attempts. Try again in ${mins}m ${secs % 60}s.`
        : `Too many attempts. Try again in ${secs} seconds.`);
      setLoginState(fresh);
      return false;
    }
    return true;
  };

  const recordFailedAttempt = () => {
    const fresh = getLoginState();
    const next = fresh.attempts + 1;
    if (next >= MAX_ATTEMPTS) {
      const lockIdx = Math.min(fresh.lockCount, LOCKOUT_DURATIONS.length - 1);
      const duration = LOCKOUT_DURATIONS[lockIdx];
      const newState = { attempts: 0, lockedUntil: Date.now() + duration, lockCount: fresh.lockCount + 1 };
      saveLoginState(newState);
      setLoginState(newState);
    } else {
      const newState = { ...fresh, attempts: next };
      saveLoginState(newState);
      setLoginState(newState);
    }
  };

  const clearLoginProtection = () => {
    const newState = { attempts: 0, lockedUntil: 0, lockCount: 0 };
    saveLoginState(newState);
    setLoginState(newState);
  };

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const [googleLoading, setGoogleLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    setError(null);
    setGoogleLoading(true);
    try {
      await api.auth.signInWithGoogle(`${window.location.origin}/auth/callback?redirect=${encodeURIComponent(redirect)}`);
    } catch (err) {
      setError(err.message || 'Google sign-in failed');
      setGoogleLoading(false);
    }
  };

  const handleSendMagicLink = async (e) => {
    e?.preventDefault();
    if (!email.trim()) return;
    if (!checkRateLimit()) return;
    setError(null);
    setLoading(true);
    try {
      await api.auth.sendMagicLink(email.trim());
      setView('MAGIC_LINK_SENT');
    } catch (err) {
      // Don't reveal if email exists or not
      if (err.message?.includes('Signups not allowed')) {
        setView('MAGIC_LINK_SENT'); // Show same screen to prevent enumeration
      } else {
        setError(err.message || 'Failed to send magic link');
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSignIn = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    if (!checkRateLimit()) return;
    setError(null);
    setLoading(true);
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (authError) {
        recordFailedAttempt();
        setError(authError.message === 'Invalid login credentials'
          ? 'Invalid email or password'
          : authError.message);
        setLoading(false);
        return;
      }
      clearLoginProtection(); // Reset on success
      // Wait briefly for AuthContext.onAuthStateChange to fire and fetchAppUser to complete
      // This prevents navigating to a protected page before the user record is loaded
      await new Promise(r => setTimeout(r, 500));
      navigate(redirect, { replace: true });
    } catch (err) {
      setError(err.message || 'Sign in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSendPhoneOTP = async (e) => {
    e?.preventDefault();
    if (!checkRateLimit()) return;
    if (!phone || phone.length < 8) {
      setError('Please enter a valid phone number');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      // Pre-check if phone is registered
      const registered = await api.auth.verifyPhoneRegistered(phone);
      if (!registered) {
        setError('This phone number is not registered. Contact your admin.');
        setLoading(false);
        return;
      }
      await api.auth.sendPhoneOTP(phone);
      setView('PHONE_OTP');
    } catch (err) {
      setError(err.message || 'Failed to send verification code');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyPhoneOTP = async (code) => {
    try {
      const { session } = await api.auth.verifyPhoneOTP(phone, code);
      if (session) {
        navigate(redirect, { replace: true });
      } else {
        setError('Verification failed. Please try again.');
      }
    } catch (err) {
      setError(err.message || 'Failed to verify code');
    }
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setError(null);
    setLoading(true);
    try {
      await api.auth.resetPassword(email.trim());
      setView('FORGOT_SENT');
    } catch (err) {
      // Always show success to prevent enumeration
      setView('FORGOT_SENT');
    } finally {
      setLoading(false);
    }
  };

  const resetToMain = () => {
    setView('MAIN');
    setError(null);
    setLoading(false);
  };

  // ─── Render Views ─────────────────────────────────────────────────────────

  // Magic Link Sent
  if (view === 'MAGIC_LINK_SENT') {
    return (
      <Shell>
        <MagicLinkSent
          email={email}
          onResend={() => api.auth.sendMagicLink(email.trim())}
          onBack={resetToMain}
        />
      </Shell>
    );
  }

  // Phone OTP Verify
  if (view === 'PHONE_OTP') {
    return (
      <Shell>
        <PhoneOTPVerify
          phone={phone}
          onVerify={handleVerifyPhoneOTP}
          onResend={() => api.auth.sendPhoneOTP(phone)}
          onBack={resetToMain}
          error={error}
        />
      </Shell>
    );
  }

  // Forgot Password
  if (view === 'FORGOT_PASSWORD') {
    return (
      <Shell>
        <div className="space-y-4">
          <div className="text-center">
            <h3 className="text-lg font-semibold">Reset your password</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Enter your email and we'll send you a reset link
            </p>
          </div>
          {error && <ErrorBanner message={error} attemptsRemaining={MAX_ATTEMPTS - loginState.attempts} />}
          <form onSubmit={handleForgotPassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="forgot-email">Email</Label>
              <Input
                id="forgot-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                className="h-11"
                aria-label="Email address for password reset"
              />
            </div>
            <Button type="submit" className="w-full h-11" disabled={loading}>
              {loading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Sending...</> : 'Send reset link'}
            </Button>
          </form>
          <BackLink onClick={resetToMain} />
        </div>
      </Shell>
    );
  }

  // Forgot Sent
  if (view === 'FORGOT_SENT') {
    return (
      <Shell>
        <div className="text-center space-y-4">
          <div className="mx-auto w-14 h-14 rounded-full bg-green-50 flex items-center justify-center">
            <Mail className="h-7 w-7 text-green-600" />
          </div>
          <h3 className="text-lg font-semibold">Check your email</h3>
          <p className="text-sm text-muted-foreground">
            If an account exists for <span className="font-medium">{email}</span>,
            you'll receive a password reset link.
          </p>
          <BackLink onClick={resetToMain} />
        </div>
      </Shell>
    );
  }

  // ─── MAIN View ────────────────────────────────────────────────────────────

  return (
    <Shell>
      <div className="space-y-5">
        {/* Google Sign-In */}
        <Button
          variant="outline"
          className="w-full h-12 text-sm font-medium gap-3 border-border/80 hover:bg-muted/50"
          onClick={handleGoogleSignIn}
          disabled={googleLoading}
        >
          {googleLoading ? (
            <><Loader2 className="h-4 w-4 animate-spin" />Redirecting to Google...</>
          ) : (
            <><GoogleIcon className="h-5 w-5" />Continue with Google</>
          )}
        </Button>

        {/* Divider */}
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border/60" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-card px-3 text-muted-foreground">or</span>
          </div>
        </div>

        {/* Email / Phone Tab Switcher */}
        <div className="flex rounded-lg border border-border/60 p-1 bg-muted/30" role="tablist" aria-label="Sign in method">
          <button
            role="tab"
            aria-selected={tab === 'email'}
            aria-controls="tab-panel-email"
            id="tab-email"
            className={`flex-1 py-2 text-sm font-medium rounded-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 ${
              tab === 'email'
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setTab('email'); setError(null); }}
          >
            Email
          </button>
          <button
            role="tab"
            aria-selected={tab === 'phone'}
            aria-controls="tab-panel-phone"
            id="tab-phone"
            className={`flex-1 py-2 text-sm font-medium rounded-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 ${
              tab === 'phone'
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setTab('phone'); setError(null); }}
          >
            Phone
          </button>
        </div>

        {error && <ErrorBanner message={error} attemptsRemaining={MAX_ATTEMPTS - loginState.attempts} />}

        {/* Email Tab */}
        {tab === 'email' && (
          <div className="space-y-4" role="tabpanel" id="tab-panel-email" aria-labelledby="tab-email">
            <div className="space-y-2">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus
                className="h-11"
                aria-label="Email address"
              />
            </div>

            {/* Magic Link Button */}
            <Button
              className="w-full h-11"
              onClick={handleSendMagicLink}
              disabled={!email.trim() || loading}
            >
              {loading && !showPassword ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" />Sending...</>
              ) : (
                <><Mail className="h-4 w-4 mr-2" />Send magic link</>
              )}
            </Button>

            {/* Password Toggle */}
            <button
              type="button"
              className="w-full flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-2.5 min-h-[44px]"
              onClick={() => setShowPassword(p => !p)}
            >
              {showPassword ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              or sign in with password
            </button>

            {/* Password Section (expandable) */}
            {showPassword && (
              <form onSubmit={handlePasswordSignIn} className="space-y-3 animate-in slide-in-from-top-2 duration-200">
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    className="h-11"
                    aria-label="Password"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
                    onClick={() => { setView('FORGOT_PASSWORD'); setError(null); }}
                  >
                    Forgot password?
                  </button>
                  <Button type="submit" disabled={loading || !password} className="h-10 px-6">
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Sign in'}
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* Phone Tab */}
        {tab === 'phone' && (
          <form onSubmit={handleSendPhoneOTP} className="space-y-4" role="tabpanel" id="tab-panel-phone" aria-labelledby="tab-phone">
            <div className="space-y-2">
              <Label htmlFor="phone-input">Phone number</Label>
              <PhoneInput value={phone} onChange={setPhone} disabled={loading} />
            </div>
            <Button type="submit" className="w-full h-11" disabled={!phone || phone.length < 8 || loading}>
              {loading ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" />Sending code...</>
              ) : (
                'Send verification code'
              )}
            </Button>
            <p className="text-xs text-center text-muted-foreground">
              We'll send a 6-digit code to verify your phone number
            </p>
          </form>
        )}
        {/* Register link */}
        <p className="text-center text-xs text-muted-foreground/70 pt-2 border-t border-border/40">
          Have an invite code?{' '}
          <a href="/register" className="text-primary font-medium hover:underline">
            Register here
          </a>
        </p>
      </div>
    </Shell>
  );
}

// ─── Shared Components ────────────────────────────────────────────────────────

function Shell({ children }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 px-4">
      <Card className="w-full max-w-sm shadow-lg border-border/50">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto mb-2">
            <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center">
              <span className="text-white font-bold text-lg">F</span>
            </div>
          </div>
          <h1 className="text-xl font-bold tracking-tight">FlexStudios</h1>
          <p className="text-sm text-muted-foreground">Sign in to your account</p>
        </CardHeader>
        <CardContent className="pt-2">
          {children}
        </CardContent>
      </Card>
      <p className="fixed bottom-4 left-0 right-0 text-center text-xs text-muted-foreground/40 px-4">
        FlexStudios
      </p>
    </div>
  );
}

function ErrorBanner({ message, attemptsRemaining }) {
  return (
    <div role="alert" aria-live="assertive" className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-400 animate-in slide-in-from-left-1 duration-200">
      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
      <div>
        <span>{message}</span>
        {attemptsRemaining != null && attemptsRemaining > 0 && attemptsRemaining <= 3 && (
          <div className="text-xs mt-1 opacity-75">
            {attemptsRemaining} attempt{attemptsRemaining !== 1 ? 's' : ''} remaining before lockout
          </div>
        )}
      </div>
    </div>
  );
}

function BackLink({ onClick }) {
  return (
    <button
      onClick={onClick}
      className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mx-auto transition-colors"
      aria-label="Go back to sign in"
    >
      <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
    </button>
  );
}
