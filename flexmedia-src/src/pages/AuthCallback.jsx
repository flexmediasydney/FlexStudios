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
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Completing sign in...</p>
    </div>
  );
}
