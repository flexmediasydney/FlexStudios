import React, { createContext, useState, useContext, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase, supabaseAdmin } from '@/api/supabaseClient';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState(null);
  const fetchingRef = useRef(false);

  // Use admin client for users table query to bypass RLS issues
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
      } else if (appUser.is_active === false) {
        setAuthError({ type: 'user_deactivated', message: 'Your account has been deactivated. Please contact your administrator.' });
        setIsAuthenticated(false);
      } else {
        setUser(appUser);
        setIsAuthenticated(true);
        setAuthError(null);
      }
    } catch (err) {
      console.error('User fetch failed:', err);
      // Don't sign out — just show the error
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

  const logout = useCallback(async (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    await supabase.auth.signOut();
    if (shouldRedirect) {
      window.location.href = '/login';
    }
  }, []);

  const navigateToLogin = useCallback(() => {
    window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
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

  // Memoize context value to prevent unnecessary re-renders of all consumers
  // when AuthProvider re-renders but none of the auth state actually changed.
  const contextValue = useMemo(() => ({
    user,
    isAuthenticated,
    isLoadingAuth,
    isLoadingPublicSettings: false,
    authError,
    appPublicSettings: null,
    logout,
    navigateToLogin,
    retryFetchUser,
    checkAppState: () => window.location.reload(),
  }), [user, isAuthenticated, isLoadingAuth, authError, logout, navigateToLogin, retryFetchUser]);

  return (
    <AuthContext.Provider value={contextValue}>
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
