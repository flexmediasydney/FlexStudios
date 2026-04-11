import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Loader2, Phone } from 'lucide-react';
import OTPInput from '@/components/common/OTPInput';

export default function PhoneOTPVerify({ phone, onVerify, onResend, onBack, error: externalError }) {
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(null);
  const [cooldown, setCooldown] = useState(60);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const handleComplete = async (code) => {
    setVerifying(true);
    setError(null);
    try {
      await onVerify(code);
    } catch (err) {
      setError(err.message || 'Invalid code. Please try again.');
    } finally {
      setVerifying(false);
    }
  };

  const handleResend = async () => {
    try {
      await onResend?.();
      setCooldown(60);
      setError(null);
    } catch {
      // parent handles
    }
  };

  const displayError = externalError || error;

  return (
    <div className="text-center space-y-4">
      <div className="mx-auto w-14 h-14 rounded-full bg-green-50 flex items-center justify-center">
        <Phone className="h-7 w-7 text-green-600" />
      </div>
      <div>
        <h3 className="text-lg font-semibold">Verify your phone</h3>
        <p className="text-sm text-muted-foreground mt-1">
          We sent a 6-digit code to <span className="font-medium">{phone}</span>
        </p>
      </div>

      {displayError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {displayError}
        </div>
      )}

      <div className="flex justify-center py-2">
        <OTPInput length={6} onComplete={handleComplete} />
      </div>

      {verifying && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Verifying...
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={handleResend}
        disabled={cooldown > 0}
        className="h-9"
      >
        {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
      </Button>

      <div>
        <button
          onClick={onBack}
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mx-auto"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
        </button>
      </div>
    </div>
  );
}
