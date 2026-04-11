import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

export default function AuthCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    // Supabase automatically processes the URL hash/params via onAuthStateChange
    // in AuthContext. We just need to wait for that to fire, then redirect.
    const redirect = searchParams.get('redirect') || '/';
    const timer = setTimeout(() => {
      navigate(redirect, { replace: true });
    }, 2000);
    return () => clearTimeout(timer);
  }, [navigate, searchParams]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-4">
      <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center mb-2">
        <span className="text-white font-bold text-lg">F</span>
      </div>
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      <div className="text-center">
        <p className="text-sm font-medium text-foreground">Completing sign in...</p>
        <p className="text-xs text-muted-foreground mt-1">You will be redirected automatically</p>
      </div>
    </div>
  );
}
