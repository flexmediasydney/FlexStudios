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
import Analytics from './pages/Analytics';
import NotificationsPage from './pages/NotificationsPage';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { canAccessRoute } from '@/components/lib/routeAccess';
import { AlertCircle } from 'lucide-react';
import InstallPrompt from '@/components/pwa/InstallPrompt';

// Lazy-loaded heavy pages (code-split into separate chunks)
const TonomoIntegrationDashboard = React.lazy(() => import('./pages/TonomoIntegrationDashboard'));
const TonomoPulse = React.lazy(() => import('./pages/TonomoPulse'));
const SettingsTonomoIntegration = React.lazy(() => import('./pages/SettingsTonomoIntegration'));
const SettingsTonomoMappings = React.lazy(() => import('./pages/SettingsTonomoMappings'));
const SettingsSystemHealth = React.lazy(() => import('./pages/SettingsSystemHealth'));
const SettingsAutomationRules = React.lazy(() => import('./pages/SettingsAutomationRules'));
const SettingsNotifications = React.lazy(() => import('./pages/SettingsNotifications'));
const NotificationsPulse = React.lazy(() => import('./pages/NotificationsPulse'));
const TeamPulsePage = React.lazy(() => import('./pages/TeamPulsePage'));
const BusinessIntelligence = React.lazy(() => import('./pages/BusinessIntelligence'));
const Reports = React.lazy(() => import('./pages/Reports'));

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
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  // Render the main app
  return (
    <Suspense fallback={<LazyFallback />}>
    <Routes>
      <Route path="/login" element={<Login />} />
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
      <Route 
       path="/TonomoIntegrationDashboard" 
       element={
         <LayoutWrapper currentPageName="TonomoIntegrationDashboard">
           <RouteGuard routeName="TonomoIntegrationDashboard">
             <ErrorBoundary fallbackLabel="Tonomo Integration Dashboard">
               <TonomoIntegrationDashboard />
             </ErrorBoundary>
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route
       path="/TonomoPulse"
       element={
         <LayoutWrapper currentPageName="TonomoPulse">
           <RouteGuard routeName="TonomoPulse">
             <ErrorBoundary fallbackLabel="Tonomo Pulse">
               <TonomoPulse />
             </ErrorBoundary>
           </RouteGuard>
         </LayoutWrapper>
       }
      />
      <Route
       path="/Analytics"
       element={
         <LayoutWrapper currentPageName="Analytics">
           <RouteGuard routeName="Analytics">
             <ErrorBoundary fallbackLabel="Analytics">
               <Analytics />
             </ErrorBoundary>
           </RouteGuard>
         </LayoutWrapper>
       }
      />
      <Route 
       path="/SettingsTonomoIntegration" 
       element={
         <LayoutWrapper currentPageName="SettingsTonomoIntegration">
           <RouteGuard routeName="SettingsTonomoIntegration">
             <ErrorBoundary fallbackLabel="Tonomo Integration Settings">
               <SettingsTonomoIntegration />
             </ErrorBoundary>
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route 
       path="/SettingsAutomationRules" 
       element={
         <LayoutWrapper currentPageName="SettingsAutomationRules">
           <RouteGuard routeName="SettingsAutomationRules">
             <ErrorBoundary fallbackLabel="Automation Rules">
               <SettingsAutomationRules />
             </ErrorBoundary>
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route 
       path="/NotificationsPage" 
       element={
         <LayoutWrapper currentPageName="NotificationsPage">
           <RouteGuard routeName="NotificationsPage">
             <ErrorBoundary fallbackLabel="Notifications">
               <NotificationsPage />
             </ErrorBoundary>
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route 
       path="/SettingsNotifications" 
       element={
         <LayoutWrapper currentPageName="SettingsNotifications">
           <RouteGuard routeName="SettingsNotifications">
             <ErrorBoundary fallbackLabel="Notification Settings">
               <SettingsNotifications />
             </ErrorBoundary>
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route 
       path="/NotificationsPulse" 
       element={
         <LayoutWrapper currentPageName="NotificationsPulse">
           <RouteGuard routeName="NotificationsPulse">
             <ErrorBoundary fallbackLabel="Notifications Pulse">
               <NotificationsPulse />
             </ErrorBoundary>
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route 
       path="/TeamPulsePage" 
       element={
         <LayoutWrapper currentPageName="TeamPulsePage">
           <RouteGuard routeName="TeamPulsePage">
             <ErrorBoundary fallbackLabel="Team Pulse">
               <TeamPulsePage />
             </ErrorBoundary>
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route 
       path="/BusinessIntelligence" 
       element={
         <LayoutWrapper currentPageName="BusinessIntelligence">
           <RouteGuard routeName="BusinessIntelligence">
             <ErrorBoundary fallbackLabel="Business Intelligence">
               <BusinessIntelligence />
             </ErrorBoundary>
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route 
       path="/Reports" 
       element={
         <LayoutWrapper currentPageName="Reports">
           <RouteGuard routeName="Reports">
             <ErrorBoundary fallbackLabel="Reports">
               <Reports />
             </ErrorBoundary>
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route
       path="/SettingsTonomoMappings"
       element={
         <LayoutWrapper currentPageName="SettingsTonomoMappings">
           <RouteGuard routeName="SettingsTonomoMappings">
             <ErrorBoundary fallbackLabel="Tonomo Mappings">
               <SettingsTonomoMappings />
             </ErrorBoundary>
           </RouteGuard>
         </LayoutWrapper>
       }
      />
      <Route
       path="/SettingsSystemHealth"
       element={
         <LayoutWrapper currentPageName="SettingsSystemHealth">
           <RouteGuard routeName="SettingsSystemHealth">
             <ErrorBoundary fallbackLabel="System Health">
               <SettingsSystemHealth />
             </ErrorBoundary>
           </RouteGuard>
         </LayoutWrapper>
       }
      />
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