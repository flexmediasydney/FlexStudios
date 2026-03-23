import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import { supabase, supabaseAdmin } from '@/api/supabaseClient';

const AuthContext = createContext();

// Read session directly from localStorage when Web Locks are stuck
function getSessionFromStorage() {
  try {
    const key = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
    if (!key) return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Handle both formats: direct object or nested under session
    const session = parsed?.session || parsed;
    if (session?.user?.email) return session;
    return null;
  } catch {
    return null;
  }
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState(null);
  const fetchingRef = useRef(false);

  // Use admin client for user lookup to bypass RLS timing issues
  // (token may not be ready when fetchAppUser runs on initial load)
  const dbClient = supabaseAdmin || supabase;

  const fetchAppUser = useCallback(async (authUser) => {
    // Prevent concurrent fetches
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    try {
      const { data: appUser, error } = await dbClient
        .from('users')
        .select('*')
        .eq('email', authUser.email)
        .single();

      if (error || !appUser) {
        setAuthError({ type: 'user_not_registered', message: 'User not registered for this app' });
        setIsAuthenticated(false);
      } else if (!appUser.is_active) {
        setAuthError({ type: 'user_deactivated', message: 'Your account has been deactivated. Contact your admin.' });
        setIsAuthenticated(false);
        await supabase.auth.signOut({ scope: 'local' });
      } else {
        setUser(appUser);
        setIsAuthenticated(true);
        setAuthError(null);
        // Update last_login_at (fire-and-forget)
        dbClient.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', appUser.id).then(() => {});
      }
    } catch (err) {
      console.error('User fetch failed:', err);
      setAuthError({ type: 'unknown', message: err.message || 'Failed to load user profile' });
      setIsAuthenticated(false);
    } finally {
      fetchingRef.current = false;
      setIsLoadingAuth(false);
    }
  }, [dbClient]);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (cancelled) return;

        if (session?.user) {
          await fetchAppUser(session.user);
        } else {
          setIsLoadingAuth(false);
        }
      } catch (err) {
        // Web Locks AbortError — the session IS in localStorage, just can't
        // access it through the locked Supabase client. Read it directly.
        if (err?.name === 'AbortError') {
          console.warn('Auth lock contention — reading session from storage fallback');
          const storedSession = getSessionFromStorage();
          if (!cancelled && storedSession?.user) {
            await fetchAppUser(storedSession.user);
            return;
          }
        }
        console.error('Auth init error:', err);
        if (!cancelled) setIsLoadingAuth(false);
      }
    };

    init();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (cancelled) return;
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          if (session?.user) {
            await fetchAppUser(session.user);
          }
        } else if (event === 'PASSWORD_RECOVERY') {
          window.location.href = '/auth/reset-password';
        } else if (event === 'SIGNED_OUT') {
          setUser(null);
          setIsAuthenticated(false);
          setIsLoadingAuth(false);
          setAuthError(null);
        }
      }
    );

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [fetchAppUser]);

  const logout = async (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    await supabase.auth.signOut({ scope: 'local' });
    if (shouldRedirect) {
      window.location.href = '/login';
    }
  };

  const navigateToLogin = () => {
    window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
  };

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated,
      isLoadingAuth,
      isLoadingPublicSettings: false,
      authError,
      appPublicSettings: null,
      logout,
      navigateToLogin,
      checkAppState: () => window.location.reload(),
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
