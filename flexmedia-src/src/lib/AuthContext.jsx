import React, { createContext, useState, useContext, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase } from '@/api/supabaseClient';

const AuthContext = createContext();

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const SIM_STORAGE_KEY = 'flexstudios_simulation_user';

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

  // ── Simulation / Impersonation ──────────────────────────────────────────
  // NOTE: Do NOT restore from sessionStorage in useState initializer.
  // The real user hasn't been authenticated yet at that point, so we can't
  // verify the master_admin guard. Instead, defer restore to a useEffect
  // that runs after auth completes.
  const [simulatedUser, setSimulatedUser] = useState(null);

  // Restore simulation from sessionStorage ONLY after real user is confirmed master_admin.
  // This prevents: (a) race conditions where simulated user loads before auth,
  // (b) simulation persisting across different user logins.
  useEffect(() => {
    if (!user || !isAuthenticated) return;
    if (user.role !== 'master_admin') {
      // Non-owner logged in — clear any leftover simulation
      sessionStorage.removeItem(SIM_STORAGE_KEY);
      setSimulatedUser(null);
      return;
    }
    // Owner logged in — restore simulation if one was active
    try {
      const stored = sessionStorage.getItem(SIM_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed?.id && parsed?.role) {
          setSimulatedUser(parsed);
        } else {
          sessionStorage.removeItem(SIM_STORAGE_KEY);
        }
      }
    } catch {
      sessionStorage.removeItem(SIM_STORAGE_KEY);
    }
  }, [user?.id, isAuthenticated]); // Only re-run when the real user changes

  // Race condition fix: track pending fetch as a promise so concurrent callers
  // (e.g. two TOKEN_REFRESHED events) coalesce onto the same request instead of racing.
  const pendingFetchRef = useRef(null);

  // Fetch app user via direct REST ONLY (no Supabase client queries during init)
  const fetchAppUser = useCallback(async (authUser, accessToken) => {
    // If a fetch is already in flight, wait for it instead of starting a second one
    if (pendingFetchRef.current) return pendingFetchRef.current;
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    const doFetch = async () => {
      try {
        const appUser = await fetchUserByEmailDirect(authUser.email, accessToken);

        if (!appUser?.id) {
          setAuthError({ type: 'user_not_registered', message: 'User not registered for this app' });
          setIsAuthenticated(false);
        } else if (!appUser.is_active) {
          setAuthError({ type: 'user_deactivated', message: 'Your account has been deactivated.' });
          setIsAuthenticated(false);
          // BUG FIX: defer signOut so it doesn't re-enter onAuthStateChange
          // and clear the deactivated error via the SIGNED_OUT handler
          setTimeout(() => supabase.auth.signOut({ scope: 'local' }).catch(() => {}), 0);
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
        pendingFetchRef.current = null;
        initDoneRef.current = true;
        setIsLoadingAuth(false);
      }
    };

    pendingFetchRef.current = doFetch();
    return pendingFetchRef.current;
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
      let sessionTimeoutId = null;
      try {
        const timeout = new Promise((_, reject) => {
          sessionTimeoutId = setTimeout(() => reject(new Error('SESSION_TIMEOUT')), 4000);
        });
        const result = await Promise.race([supabase.auth.getSession(), timeout]);
        clearTimeout(sessionTimeoutId);
        session = result?.data?.session;
      } catch {
        // getSession hung or threw — fall through to localStorage
        // BUG FIX: clear the timeout so it doesn't fire after we've moved on
        if (sessionTimeoutId) clearTimeout(sessionTimeoutId);
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
          // Always clear simulation on sign out
          setSimulatedUser(null);
          sessionStorage.removeItem(SIM_STORAGE_KEY);
          // BUG FIX: preserve deactivation error so the UI keeps showing
          // the "account deactivated" message instead of the login form
          setAuthError(prev => prev?.type === 'user_deactivated' ? prev : null);
        }
      }
    );

    // ─── PROACTIVE TOKEN REFRESH ──────────────────────────────────────
    // Supabase auto-refresh can silently fail on flaky networks.
    // Check every 4 minutes; if the token expires within 5 minutes,
    // proactively call refreshSession so the user never hits a 401
    // mid-workflow (e.g. while saving a project or sending an email).
    const tokenRefreshInterval = setInterval(async () => {
      if (cancelled) return;
      try {
        const { data: { session: s } } = await supabase.auth.getSession();
        if (!s?.expires_at) return;
        const expiresInMs = s.expires_at * 1000 - Date.now();
        if (expiresInMs < 5 * 60 * 1000) {
          await supabase.auth.refreshSession();
        }
      } catch {
        // Refresh failed — onAuthStateChange will handle SIGNED_OUT if needed
      }
    }, 4 * 60 * 1000);

    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
      clearInterval(tokenRefreshInterval);
      subscription.unsubscribe();
    };
  }, [fetchAppUser]);

  const logout = useCallback(async (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    // Always clear simulation on logout
    setSimulatedUser(null);
    sessionStorage.removeItem(SIM_STORAGE_KEY);
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
    if (shouldRedirect) {
      window.location.href = '/login';
    }
  }, []);

  const navigateToLogin = useCallback(() => {
    // Only encode the pathname (no query/hash) to prevent injection
    const safePath = window.location.pathname.replace(/[^a-zA-Z0-9/_\-?.=&]/g, '');
    window.location.href = `/login?redirect=${encodeURIComponent(safePath)}`;
  }, []);

  // Allow manual retry of user fetch — clears the error state and re-fetches
  const retryFetchUser = useCallback(async () => {
    setAuthError(null);
    setIsLoadingAuth(true);
    fetchingRef.current = false; // Reset guard so fetchAppUser can run again
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        await fetchAppUser(session.user);
      } else {
        setIsLoadingAuth(false);
        setAuthError({ type: 'no_session', message: 'No active session. Please log in.' });
      }
    } catch (err) {
      setIsLoadingAuth(false);
      setAuthError({ type: 'unknown', message: err.message || 'Retry failed' });
    }
  }, [fetchAppUser]);

  // ── Simulation methods ───────────────────────────────────────────────────
  const startSimulation = useCallback(async (userId) => {
    // Only master_admin (owner) can impersonate
    if (user?.role !== 'master_admin') return 'not_authorized';
    // Cannot impersonate yourself
    if (userId === user.id) return 'self';
    try {
      // Use authenticated request (Bearer token) for proper RLS enforcement
      let accessToken = '';
      try {
        const { data: { session } } = await supabase.auth.getSession();
        accessToken = session?.access_token || '';
      } catch { /* fallback to anon */ }

      const headers = { 'apikey': SUPABASE_ANON_KEY, 'Accept': 'application/vnd.pgrst.object+json' };
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/users?id=eq.${encodeURIComponent(userId)}&select=*`,
        { headers }
      );
      if (!res.ok) return 'fetch_failed';
      const targetUser = await res.json();
      if (!targetUser?.id) return 'not_found';
      if (!targetUser.is_active) return 'deactivated';

      setSimulatedUser(targetUser);
      sessionStorage.setItem(SIM_STORAGE_KEY, JSON.stringify(targetUser));
      return 'ok';
    } catch (err) {
      console.error('Failed to start simulation:', err);
      return 'error';
    }
  }, [user]);

  const endSimulation = useCallback(() => {
    setSimulatedUser(null);
    sessionStorage.removeItem(SIM_STORAGE_KEY);
  }, []);

  // The effective user: simulated user overrides real user for all permission checks
  const effectiveUser = simulatedUser || user;

  // Memoize context value to prevent unnecessary re-renders of all consumers
  // when AuthProvider re-renders but none of the auth state actually changed.
  const contextValue = useMemo(() => ({
    user: effectiveUser,
    realUser: user,
    isSimulating: !!simulatedUser,
    simulatedUser,
    startSimulation,
    endSimulation,
    isAuthenticated,
    isLoadingAuth,
    isLoadingPublicSettings: false,
    authError,
    appPublicSettings: null,
    logout,
    navigateToLogin,
    retryFetchUser,
    checkAppState: () => window.location.reload(),
  }), [effectiveUser, user, simulatedUser, startSimulation, endSimulation, isAuthenticated, isLoadingAuth, authError, logout, navigateToLogin, retryFetchUser]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};
