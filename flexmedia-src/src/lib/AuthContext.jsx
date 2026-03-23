import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
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
      } else if (!appUser.is_active) {
        setAuthError({ type: 'user_deactivated', message: 'Your account has been deactivated. Contact your admin.' });
        setIsAuthenticated(false);
        await supabase.auth.signOut({ scope: 'local' });
      } else {
        setUser(appUser);
        setIsAuthenticated(true);
        setAuthError(null);
        // Update last_login_at
        dbClient.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', appUser.id).then(() => {});
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
        } else if (event === 'PASSWORD_RECOVERY') {
          // User clicked a password reset link — redirect to reset page
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
