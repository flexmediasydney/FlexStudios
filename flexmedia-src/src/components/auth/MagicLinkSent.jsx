import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Mail, ArrowLeft, Loader2 } from 'lucide-react';

export default function MagicLinkSent({ email, onResend, onBack }) {
  const [cooldown, setCooldown] = useState(60);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const handleResend = async () => {
    setResending(true);
    try {
      await onResend?.();
      setCooldown(60);
    } catch {
      // parent handles error
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="text-center space-y-4">
      <div className="mx-auto w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center">
        <Mail className="h-7 w-7 text-blue-600" />
      </div>
      <div>
        <h3 className="text-lg font-semibold">Check your email</h3>
        <p className="text-sm text-muted-foreground mt-1">
          We sent a sign-in link to
        </p>
        <p className="text-sm font-medium mt-0.5">{email}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Click the link in the email to sign in. The link expires in 1 hour.
      </p>
      <Button
        variant="outline"
        className="w-full h-11"
        onClick={handleResend}
        disabled={cooldown > 0 || resending}
      >
        {resending ? (
          <><Loader2 className="h-4 w-4 animate-spin mr-2" />Sending...</>
        ) : cooldown > 0 ? (
          `Resend in ${cooldown}s`
        ) : (
          'Resend link'
        )}
      </Button>
      <button
        onClick={onBack}
        className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mx-auto"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
      </button>
    </div>
  );
}
