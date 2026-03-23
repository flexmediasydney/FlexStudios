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
// MAIN           → Primary view with Google + Email/Phone tabs
// MAGIC_LINK_SENT → "Check your email" confirmation
// PHONE_OTP      → Enter 6-digit phone code
// PASSWORD       → Email + password form (expanded from email tab)
// FORGOT_PASSWORD → Enter email for reset link
// FORGOT_SENT    → "Check email for reset link"

export default function Login() {
  const [view, setView] = useState('MAIN');
  const [tab, setTab] = useState('email'); // 'email' | 'phone'
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect') || '/';

  // Client-side brute force protection
  const isLocked = lockedUntil && Date.now() < lockedUntil;
  const checkRateLimit = () => {
    if (isLocked) {
      const secs = Math.ceil((lockedUntil - Date.now()) / 1000);
      setError(`Too many attempts. Try again in ${secs} seconds.`);
      return false;
    }
    return true;
  };
  const recordFailedAttempt = () => {
    const next = attempts + 1;
    setAttempts(next);
    if (next >= 5) {
      setLockedUntil(Date.now() + 30000); // 30 second lockout
      setAttempts(0);
    }
  };

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const handleGoogleSignIn = async () => {
    setError(null);
    try {
      await api.auth.signInWithGoogle(`${window.location.origin}/auth/callback?redirect=${encodeURIComponent(redirect)}`);
    } catch (err) {
      setError(err.message || 'Google sign-in failed');
    }
  };

  const handleSendMagicLink = async (e) => {
    e?.preventDefault();
    if (!email.trim()) return;
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
      setAttempts(0); // Reset on success
      navigate(redirect, { replace: true });
    } catch (err) {
      setError(err.message || 'Sign in failed');
      setLoading(false);
    }
  };

  const handleSendPhoneOTP = async (e) => {
    e?.preventDefault();
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
    const { session } = await api.auth.verifyPhoneOTP(phone, code);
    if (session) {
      navigate(redirect, { replace: true });
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
          {error && <ErrorBanner message={error} />}
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
        >
          <GoogleIcon className="h-5 w-5" />
          Continue with Google
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
        <div className="flex rounded-lg border border-border/60 p-1 bg-muted/30">
          <button
            className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
              tab === 'email'
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setTab('email'); setError(null); }}
          >
            Email
          </button>
          <button
            className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
              tab === 'phone'
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setTab('phone'); setError(null); }}
          >
            Phone
          </button>
        </div>

        {error && <ErrorBanner message={error} />}

        {/* Email Tab */}
        {tab === 'email' && (
          <div className="space-y-4">
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
              className="w-full flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
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
          <form onSubmit={handleSendPhoneOTP} className="space-y-4">
            <div className="space-y-2">
              <Label>Phone number</Label>
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
        {/* Create Account Link */}
        <div className="text-center pt-2 border-t border-border/40">
          <p className="text-xs text-muted-foreground">
            Don't have an account?{' '}
            <a href="/register" className="text-blue-600 hover:text-blue-700 font-medium hover:underline">
              Create account
            </a>
          </p>
        </div>
      </div>
    </Shell>
  );
}

// ─── Shared Components ────────────────────────────────────────────────────────

function Shell({ children }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 px-4">
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
      <p className="fixed bottom-4 text-xs text-muted-foreground/50">
        FlexMedia Sydney
      </p>
    </div>
  );
}

function ErrorBanner({ message }) {
  return (
    <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function BackLink({ onClick }) {
  return (
    <button
      onClick={onClick}
      className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mx-auto"
    >
      <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
    </button>
  );
}
