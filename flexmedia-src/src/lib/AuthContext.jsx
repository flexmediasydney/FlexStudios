import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import { supabase, supabaseAdmin } from '@/api/supabaseClient';

const AuthContext = createContext();

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ─── Helpers that bypass Supabase client entirely ────────────────────────────

function getSessionFromStorage() {
  try {
    const key = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
    if (!key) return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const session = parsed?.session || parsed;
    if (session?.user?.email) return session;
    return null;
  } catch {
    return null;
  }
}

async function fetchUserByEmailDirect(email, accessToken) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const headers = { 'apikey': SUPABASE_ANON_KEY, 'Accept': 'application/vnd.pgrst.object+json' };
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=*`,
      { headers, signal: controller.signal }
    );
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── Auth Provider ───────────────────────────────────────────────────────────

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState(null);
  const fetchingRef = useRef(false);
  const initDoneRef = useRef(false);

  // Fetch app user via direct REST ONLY (no Supabase client queries during init)
  const fetchAppUser = useCallback(async (authUser, accessToken) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    try {
      const appUser = await fetchUserByEmailDirect(authUser.email, accessToken);

      if (!appUser?.id) {
        setAuthError({ type: 'user_not_registered', message: 'User not registered for this app' });
        setIsAuthenticated(false);
      } else if (!appUser.is_active) {
        setAuthError({ type: 'user_deactivated', message: 'Your account has been deactivated.' });
        setIsAuthenticated(false);
        supabase.auth.signOut({ scope: 'local' }).catch(() => {});
      } else {
        setUser(appUser);
        setIsAuthenticated(true);
        setAuthError(null);
        // Update last_login_at (fire-and-forget via REST)
        fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${appUser.id}`, {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ last_login_at: new Date().toISOString() }),
        }).catch(() => {});
      }
    } catch (err) {
      console.error('User fetch failed:', err);
      setAuthError({ type: 'unknown', message: err.message || 'Failed to load user profile' });
      setIsAuthenticated(false);
    } finally {
      fetchingRef.current = false;
      initDoneRef.current = true;
      setIsLoadingAuth(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    // ─── ABSOLUTE SAFETY NET ────────────────────────────────────────
    // If NOTHING resolves within 8 seconds, force show login page.
    // This catches ALL possible hang scenarios.
    const safetyTimer = setTimeout(() => {
      if (!initDoneRef.current && !cancelled) {
        console.warn('Auth safety timeout — forcing login page');
        setIsLoadingAuth(false);
      }
    }, 8000);

    const init = async () => {
      // Step 1: Try getSession() with a 4-second timeout
      let session = null;
      try {
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('SESSION_TIMEOUT')), 4000)
        );
        const result = await Promise.race([supabase.auth.getSession(), timeout]);
        session = result?.data?.session;
      } catch {
        // getSession hung or threw — fall through to localStorage
      }

      if (cancelled) return;

      // Step 2: If getSession worked and has a session, use it
      if (session?.user?.email) {
        await fetchAppUser(session.user, session.access_token);
        return;
      }

      // Step 3: No session from client — try localStorage
      const stored = getSessionFromStorage();
      if (stored?.user?.email) {
        await fetchAppUser(stored.user, stored.access_token);
        return;
      }

      // Step 4: No session anywhere — show login
      if (!cancelled) {
        initDoneRef.current = true;
        setIsLoadingAuth(false);
      }
    };

    init();

    // Listen for auth state changes (login, logout, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (cancelled) return;
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          if (session?.user) {
            await fetchAppUser(session.user, session.access_token);
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
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  }, [fetchAppUser]);

  const logout = async (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
    if (shouldRedirect) window.location.href = '/login';
  };

  const navigateToLogin = () => {
    window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
  };

  return (
    <AuthContext.Provider value={{
      user, isAuthenticated, isLoadingAuth,
      isLoadingPublicSettings: false,
      authError, appPublicSettings: null,
      logout, navigateToLogin,
      checkAppState: () => window.location.reload(),
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};
