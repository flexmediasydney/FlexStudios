import React, { Suspense } from 'react';
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/components/lib/query-client'
import { pagesConfig } from './pages.config'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import { ThemeProvider } from '@/lib/ThemeContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import { clearEntityCache } from '@/components/hooks/useEntityData';
import Login from './pages/Login';
import AuthCallback from './pages/AuthCallback';
import ResetPassword from './pages/ResetPassword';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { canAccessRoute } from '@/components/lib/routeAccess';
import { AlertCircle } from 'lucide-react';
import InstallPrompt from '@/components/pwa/InstallPrompt';

const LazyFallback = () => (
  <div className="fixed inset-0 flex items-center justify-center">
    <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
  </div>
);

const { Pages, Layout, mainPage } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : <></>;

const LayoutWrapper = ({ children, currentPageName }) => Layout ?
  <ErrorBoundary>
    <Layout currentPageName={currentPageName}>{children}</Layout>
  </ErrorBoundary>
  : <ErrorBoundary>{children}</ErrorBoundary>;

function RouteGuard({ routeName, children }) {
  const { data: user, isLoading, error, refetch } = useCurrentUser();

  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  // Surface non-auth errors instead of showing a blank page
  if (error && !user) {
    const isAuthError = error.message?.includes('Not authenticated') ||
                        error.message?.includes('JWT') ||
                        error.message?.includes('session');
    if (!isAuthError) {
      return (
        <div className="flex items-center justify-center min-h-[60vh] p-8">
          <div className="bg-red-50 border border-red-200 rounded-xl p-8 max-w-md text-center">
            <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-red-900 mb-2">Something went wrong</h2>
            <p className="text-sm text-red-700 mb-4">
              {error.message || 'Failed to load user information.'}
            </p>
            <button
              onClick={() => refetch()}
              className="text-sm text-red-600 underline hover:text-red-800"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
  }

  if (!user) return null; // Auth redirect handled by AuthenticatedApp

  if (!canAccessRoute(routeName, user.role)) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] p-8">
        <div className="bg-red-50 border border-red-200 rounded-xl p-8 max-w-md text-center">
          <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-red-900 mb-2">Access denied</h2>
          <p className="text-sm text-red-700 mb-4">
            You don't have permission to access this page. Contact your admin if you need access.
          </p>
          <a href="/Dashboard" className="text-sm text-red-600 underline hover:text-red-800">
            Back to Dashboard
          </a>
        </div>
      </div>
    );
  }

  return children;
}

const AuthenticatedApp = () => {
  const { isLoadingAuth, isAuthenticated, authError } = useAuth();

  // Show loading spinner while checking auth session
  if (isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  // Handle authentication errors
  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    }
  }

  // Not authenticated — show login page
  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/auth/reset-password" element={<ResetPassword />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  // Render the main app
  return (
    <Suspense fallback={<LazyFallback />}>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/auth/reset-password" element={<ResetPassword />} />
      <Route path="/" element={
        <LayoutWrapper currentPageName={mainPageKey}>
          <RouteGuard routeName={mainPageKey}>
            <ErrorBoundary fallbackLabel={mainPageKey}>
              <MainPage />
            </ErrorBoundary>
          </RouteGuard>
        </LayoutWrapper>
      } />
      {Object.entries(Pages).map(([path, Page]) => (
        <Route
          key={path}
          path={`/${path}`}
          element={
            <LayoutWrapper currentPageName={path}>
              <RouteGuard routeName={path}>
                <ErrorBoundary fallbackLabel={path}>
                  <Page />
                </ErrorBoundary>
              </RouteGuard>
            </LayoutWrapper>
          }
        />
      ))}
      <Route path="*" element={<PageNotFound />} />
    </Routes>
    </Suspense>
  );
};


function App() {
  // Clear entity cache when window unloads (logout/close)
  React.useEffect(() => {
    const handleUnload = () => clearEntityCache();
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, []);

  return (
    <ThemeProvider>
      <AuthProvider>
        <QueryClientProvider client={queryClientInstance}>
          <Router>
            <AuthenticatedApp />
          </Router>
          <Toaster />
          <InstallPrompt />
        </QueryClientProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}

export default App