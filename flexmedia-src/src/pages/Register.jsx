import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase, supabaseAdmin } from '@/api/supabaseClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AlertCircle, Loader2, CheckCircle2, ArrowLeft, KeyRound } from 'lucide-react';

export default function Register() {
  const [step, setStep] = useState('CODE'); // CODE → DETAILS → SUCCESS
  const [inviteCode, setInviteCode] = useState('');
  const [codeData, setCodeData] = useState(null);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const dbClient = supabaseAdmin || supabase;

  const handleValidateCode = async (e) => {
    e.preventDefault();
    const code = inviteCode.trim().toUpperCase();
    if (!code) return;
    setError(null);
    setLoading(true);

    try {
      const { data, error: fetchErr } = await dbClient
        .from('invite_codes')
        .select('*')
        .eq('code', code)
        .eq('is_active', true)
        .single();

      if (fetchErr || !data) {
        setError('Invalid invite code. Please check and try again.');
        setLoading(false);
        return;
      }

      // Check expiry
      if (data.expires_at && new Date(data.expires_at) < new Date()) {
        setError('This invite code has expired.');
        setLoading(false);
        return;
      }

      // Check uses
      if (data.max_uses && data.use_count >= data.max_uses) {
        setError('This invite code has reached its maximum uses.');
        setLoading(false);
        return;
      }

      setCodeData(data);
      setStep('DETAILS');
    } catch (err) {
      setError(err.message || 'Failed to validate code');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError(null);

    if (!fullName.trim()) {
      setError('Please enter your name');
      return;
    }
    if (!email.trim()) {
      setError('Please enter your email');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      // 1. Create auth user
      const { data: authData, error: authErr } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          data: { full_name: fullName.trim(), role: codeData.role },
        },
      });

      if (authErr) {
        if (authErr.message?.includes('already registered')) {
          setError('An account with this email already exists. Try signing in instead.');
        } else {
          setError(authErr.message);
        }
        setLoading(false);
        return;
      }

      const userId = authData.user?.id;
      if (!userId) {
        setError('Account created but no user ID returned. Please try signing in.');
        setLoading(false);
        return;
      }

      // 2. Create users table record
      const { error: userErr } = await dbClient
        .from('users')
        .insert({
          id: userId,
          email: email.trim().toLowerCase(),
          full_name: fullName.trim(),
          role: codeData.role,
          is_active: true,
          auth_provider: 'email',
        });

      if (userErr && userErr.code !== '23505') {
        // 23505 = unique violation (user already exists)
        console.error('Users table insert error:', userErr);
      }

      // 3. Increment use count on invite code
      await dbClient
        .from('invite_codes')
        .update({ use_count: (codeData.use_count || 0) + 1 })
        .eq('id', codeData.id);

      setStep('SUCCESS');
    } catch (err) {
      setError(err.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const roleLabel = {
    master_admin: 'Administrator',
    admin: 'Admin',
    employee: 'Employee',
    contractor: 'Contractor',
  };

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
          <p className="text-sm text-muted-foreground">Create your account</p>
        </CardHeader>
        <CardContent className="pt-2">

          {/* Step 1: Enter Invite Code */}
          {step === 'CODE' && (
            <form onSubmit={handleValidateCode} className="space-y-4">
              <div className="mx-auto w-14 h-14 rounded-full bg-amber-50 flex items-center justify-center">
                <KeyRound className="h-7 w-7 text-amber-600" />
              </div>
              <div className="text-center">
                <h3 className="text-base font-semibold">Enter invite code</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  You need an invite code from your admin to create an account
                </p>
              </div>

              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="invite-code">Invite code</Label>
                <Input
                  id="invite-code"
                  placeholder="e.g. FLEX-A7K2M9"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                  required
                  autoFocus
                  className="h-11 text-center text-lg tracking-wider font-mono"
                  maxLength={20}
                />
              </div>

              <Button type="submit" className="w-full h-11" disabled={!inviteCode.trim() || loading}>
                {loading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Validating...</> : 'Continue'}
              </Button>

              <div className="text-center">
                <Link to="/login" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                  <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
                </Link>
              </div>
            </form>
          )}

          {/* Step 2: Account Details */}
          {step === 'DETAILS' && (
            <form onSubmit={handleRegister} className="space-y-4">
              <div className="text-center">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-50 text-green-700 text-xs font-medium">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Code valid — {roleLabel[codeData.role] || codeData.role} access
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="reg-name">Full name</Label>
                <Input
                  id="reg-name"
                  placeholder="John Smith"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  autoFocus
                  className="h-11"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="reg-email">Email</Label>
                <Input
                  id="reg-email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="h-11"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="reg-password">Password</Label>
                <Input
                  id="reg-password"
                  type="password"
                  placeholder="Minimum 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  className="h-11"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="reg-confirm">Confirm password</Label>
                <Input
                  id="reg-confirm"
                  type="password"
                  placeholder="Re-enter your password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={6}
                  className="h-11"
                />
              </div>

              <Button type="submit" className="w-full h-11" disabled={loading}>
                {loading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Creating account...</> : 'Create account'}
              </Button>

              <button
                type="button"
                onClick={() => { setStep('CODE'); setError(null); }}
                className="w-full text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 justify-center"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Use a different code
              </button>
            </form>
          )}

          {/* Step 3: Success */}
          {step === 'SUCCESS' && (
            <div className="text-center space-y-4">
              <div className="mx-auto w-14 h-14 rounded-full bg-green-50 flex items-center justify-center">
                <CheckCircle2 className="h-7 w-7 text-green-600" />
              </div>
              <h3 className="text-lg font-semibold">Account created</h3>
              <p className="text-sm text-muted-foreground">
                Welcome to FlexStudios, {fullName.split(' ')[0]}! You can now sign in.
              </p>
              <Button className="w-full h-11" onClick={() => navigate('/login', { replace: true })}>
                Go to sign in
              </Button>
            </div>
          )}

        </CardContent>
      </Card>
      <p className="fixed bottom-4 text-xs text-muted-foreground/50">FlexMedia Sydney</p>
    </div>
  );
}
