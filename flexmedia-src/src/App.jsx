import React from 'react';
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/components/lib/query-client'
import { pagesConfig } from './pages.config'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import { clearEntityCache } from '@/components/hooks/useEntityData';
import Login from './pages/Login';
import TonomoIntegrationDashboard from './pages/TonomoIntegrationDashboard';
import TonomoPulse from './pages/TonomoPulse';
import Analytics from './pages/Analytics';
import SettingsTonomoIntegration from './pages/SettingsTonomoIntegration';
import SettingsTonomoMappings from './pages/SettingsTonomoMappings';
import SettingsSystemHealth from './pages/SettingsSystemHealth';
import SettingsAutomationRules from './pages/SettingsAutomationRules';
import NotificationsPage from './pages/NotificationsPage';
import SettingsNotifications from './pages/SettingsNotifications';
import NotificationsPulse from './pages/NotificationsPulse';
import TeamPulsePage from './pages/TeamPulsePage';
import BusinessIntelligence from './pages/BusinessIntelligence';
import Reports from './pages/Reports';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { canAccessRoute } from '@/components/lib/routeAccess';
import { AlertCircle } from 'lucide-react';

const { Pages, Layout, mainPage } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : <></>;

const LayoutWrapper = ({ children, currentPageName }) => Layout ?
  <ErrorBoundary>
    <Layout currentPageName={currentPageName}>{children}</Layout>
  </ErrorBoundary>
  : <ErrorBoundary>{children}</ErrorBoundary>;

function RouteGuard({ routeName, children }) {
  const { data: user, isLoading } = useCurrentUser();

  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
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
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={
        <LayoutWrapper currentPageName={mainPageKey}>
          <RouteGuard routeName={mainPageKey}>
            <MainPage />
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
                <Page />
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
             <TonomoIntegrationDashboard />
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route
       path="/TonomoPulse"
       element={
         <LayoutWrapper currentPageName="TonomoPulse">
           <RouteGuard routeName="TonomoPulse">
             <TonomoPulse />
           </RouteGuard>
         </LayoutWrapper>
       }
      />
      <Route
       path="/Analytics"
       element={
         <LayoutWrapper currentPageName="Analytics">
           <RouteGuard routeName="Analytics">
             <Analytics />
           </RouteGuard>
         </LayoutWrapper>
       }
      />
      <Route 
       path="/SettingsTonomoIntegration" 
       element={
         <LayoutWrapper currentPageName="SettingsTonomoIntegration">
           <RouteGuard routeName="SettingsTonomoIntegration">
             <SettingsTonomoIntegration />
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route 
       path="/SettingsAutomationRules" 
       element={
         <LayoutWrapper currentPageName="SettingsAutomationRules">
           <RouteGuard routeName="SettingsAutomationRules">
             <SettingsAutomationRules />
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route 
       path="/NotificationsPage" 
       element={
         <LayoutWrapper currentPageName="NotificationsPage">
           <RouteGuard routeName="NotificationsPage">
             <NotificationsPage />
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route 
       path="/SettingsNotifications" 
       element={
         <LayoutWrapper currentPageName="SettingsNotifications">
           <RouteGuard routeName="SettingsNotifications">
             <SettingsNotifications />
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route 
       path="/NotificationsPulse" 
       element={
         <LayoutWrapper currentPageName="NotificationsPulse">
           <RouteGuard routeName="NotificationsPulse">
             <NotificationsPulse />
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route 
       path="/TeamPulsePage" 
       element={
         <LayoutWrapper currentPageName="TeamPulsePage">
           <RouteGuard routeName="TeamPulsePage">
             <TeamPulsePage />
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route 
       path="/BusinessIntelligence" 
       element={
         <LayoutWrapper currentPageName="BusinessIntelligence">
           <RouteGuard routeName="BusinessIntelligence">
             <BusinessIntelligence />
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route 
       path="/Reports" 
       element={
         <LayoutWrapper currentPageName="Reports">
           <RouteGuard routeName="Reports">
             <Reports />
           </RouteGuard>
         </LayoutWrapper>
       } 
      />
      <Route
       path="/SettingsTonomoMappings"
       element={
         <LayoutWrapper currentPageName="SettingsTonomoMappings">
           <RouteGuard routeName="SettingsTonomoMappings">
             <SettingsTonomoMappings />
           </RouteGuard>
         </LayoutWrapper>
       }
      />
      <Route
       path="/SettingsSystemHealth"
       element={
         <LayoutWrapper currentPageName="SettingsSystemHealth">
           <RouteGuard routeName="SettingsSystemHealth">
             <SettingsSystemHealth />
           </RouteGuard>
         </LayoutWrapper>
       }
      />
      <Route path="*" element={<PageNotFound />} />
    </Routes>
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
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App