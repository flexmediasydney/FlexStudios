import React, { createContext, useState, useContext, useEffect } from 'react';
import { supabase } from '@/api/base44Client';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState(null);

  useEffect(() => {
    // Check existing session on mount
    checkSession();

    // Safety net: if auth check takes more than 10 seconds, stop loading
    const timeout = setTimeout(() => {
      setIsLoadingAuth((current) => {
        if (current) {
          console.warn('Auth check timed out — clearing session');
          supabase.auth.signOut().catch(() => {});
          setIsAuthenticated(false);
          return false;
        }
        return current;
      });
    }, 10000);

    // Listen for auth state changes (sign in, sign out, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          if (session?.user) {
            await fetchAppUser(session.user);
          }
        } else if (event === 'SIGNED_OUT') {
          setUser(null);
          setIsAuthenticated(false);
          setAuthError(null);
        }
      }
    );

    return () => {
      clearTimeout(timeout);
      subscription.unsubscribe();
    };
  }, []);

  const checkSession = async () => {
    try {
      setIsLoadingAuth(true);
      setAuthError(null);

      const { data: { session }, error } = await supabase.auth.getSession();

      if (error) {
        console.error('Session check failed:', error);
        // Clear corrupt session to prevent infinite spinner
        await supabase.auth.signOut().catch(() => {});
        setIsLoadingAuth(false);
        setIsAuthenticated(false);
        return;
      }

      if (session?.user) {
        await fetchAppUser(session.user);
      } else {
        // No session — user needs to log in
        setIsLoadingAuth(false);
        setIsAuthenticated(false);
      }
    } catch (error) {
      console.error('Unexpected auth error:', error);
      // Clear corrupt session to prevent infinite spinner
      await supabase.auth.signOut().catch(() => {});
      setAuthError({
        type: 'unknown',
        message: error.message || 'An unexpected error occurred',
      });
      setIsLoadingAuth(false);
    }
  };

  /**
   * Fetch the app-level user record from the users table.
   * This gives us the role, full_name, and other app-specific fields.
   */
  const fetchAppUser = async (authUser) => {
    try {
      const { data: appUser, error } = await supabase
        .from('users')
        .select('*')
        .eq('email', authUser.email)
        .single();

      if (error || !appUser) {
        // User exists in Supabase Auth but not in our users table
        setAuthError({
          type: 'user_not_registered',
          message: 'User not registered for this app',
        });
        setIsLoadingAuth(false);
        setIsAuthenticated(false);
        return;
      }

      setUser(appUser);
      setIsAuthenticated(true);
      setIsLoadingAuth(false);
      setAuthError(null);
    } catch (error) {
      console.error('User fetch failed:', error);
      setAuthError({
        type: 'unknown',
        message: error.message || 'Failed to load user profile',
      });
      setIsLoadingAuth(false);
    }
  };

  const logout = async (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    await supabase.auth.signOut();
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
      // Keep these for backward compat — consumers may reference them
      isLoadingPublicSettings: false,
      authError,
      appPublicSettings: null,
      logout,
      navigateToLogin,
      checkAppState: checkSession,
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
