import React, { useState, useMemo, useEffect } from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

import { 
  LayoutDashboard, 
  Camera, 
  Users, 
  Calendar as CalendarIcon, 
  Menu,
  X,
  Mail,
  LogOut,
  Shield,
  UserCircle,
  Settings as SettingsIcon,
  Target,
  Zap,
  Bot,
  Activity,
  Bell,
  BarChart2,
  Search,
  TrendingUp,
  LineChart,
  FileBarChart,
  UserCheck,
  Clock,
  ChevronDown
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import GlobalSearch from "@/components/common/GlobalSearch";
import TopSearchBar from "@/components/common/TopSearchBar";

import { cn } from "@/lib/utils";
import { base44 } from "@/api/base44Client";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { canAccessRoute } from "@/components/lib/routeAccess";
import { useNotifications } from "@/components/notifications/NotificationContext";
import { useEntityList } from "@/components/hooks/useEntityData";

import { NotificationProvider } from "@/components/notifications/NotificationContext";
import GlobalNotificationBar, { NotificationBell } from "@/components/notifications/GlobalNotificationBar";
import NotificationToast from "@/components/notifications/NotificationToast";
import { ChatProvider, useChat } from "@/components/chat/ChatContext";
import ChatPanel from "@/components/chat/ChatPanel";
import { ActiveTimersProvider } from "@/components/utilization/ActiveTimersContext";


const roleColors = {
  master_admin: "bg-red-100 text-red-700",
  employee: "bg-blue-100 text-blue-700",
  contractor: "bg-amber-100 text-amber-700"
};

const roleLabels = {
  master_admin: "Admin",
  employee: "Employee",
  contractor: "Contractor"
};

export default function Layout({ children, currentPageName }) {
  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    }
  };

  return (
    <NotificationProvider>
      <ChatProvider>
        <LayoutContentWrapper currentPageName={currentPageName} children={children} onBack={handleBack} />
      </ChatProvider>
    </NotificationProvider>
  );
}

function LayoutContentWrapper({ currentPageName, children, onBack }) {
  const { data: user } = useCurrentUser();
  
  return (
    <ActiveTimersProvider currentUser={user || null}>
      <LayoutContent currentPageName={currentPageName} children={children} onBack={onBack} />
    </ActiveTimersProvider>
  );
}

function LayoutContent({ currentPageName, children, onBack }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { data: user } = useCurrentUser();
  const { openChats, activeChat, setActiveChat, closeChat } = useChat();
  
  // ── Live badge counts for nav ──────────────────────────────────────────
  const { unreadCount: notifUnread } = useNotifications();
  const { data: navEmails = [] } = useEntityList("EmailMessage", "-received_at", 500);
  const { data: navProjects = [] } = useEntityList("Project", null, 500);

  const navBadges = useMemo(() => {
    const inboxUnread = navEmails.filter(m => m.is_unread && !m.is_archived && !m.is_deleted).length;
    const pendingReview = navProjects.filter(p => p.status === 'pending_review').length;
    const overdueTasks = 0; // tasks already loaded elsewhere, keep nav light
    return {
      Inbox: inboxUnread,
      NotificationsPage: notifUnread,
      TonomoIntegrationDashboard: pendingReview,
    };
  }, [navEmails, navProjects, notifUnread]);
  const canGoBack = typeof window !== 'undefined' && window.history.length > 1;
  
  // Collapsible sections state — persisted to localStorage
  const [expandedSections, setExpandedSections] = useState(() => {
    try {
      const saved = localStorage.getItem('nav-expanded-sections');
      return saved ? JSON.parse(saved) : {
        workspace: true,
        operations: true,
        bookings: true,
        contacts: true,
        analytics: true,
        growth: false,
        settings: false
      };
    } catch {
      return { workspace: true, operations: true, bookings: true, contacts: true, analytics: true, growth: false, settings: false };
    }
  });

  // Persist expanded sections to localStorage
  useEffect(() => {
    localStorage.setItem('nav-expanded-sections', JSON.stringify(expandedSections));
  }, [expandedSections]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(v => !v);
      }
      // Esc closes sidebar on mobile
      if (e.key === "Escape" && sidebarOpen) {
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sidebarOpen]);

  // Navigation structure with sections — role-aware filtering
  const navigationSections = useMemo(() => {
    if (!user) return [];
    const role = user.role;
    const can = (route) => canAccessRoute(route, role);

    return [
      {
        id: 'workspace',
        label: 'Workspace',
        collapsible: true,
        items: [
          can("Dashboard") && { name: "Dashboard", href: "Dashboard", icon: LayoutDashboard },
          can("Calendar") && { name: "Calendar", href: "Calendar", icon: CalendarIcon },
          can("Inbox") && { name: "Inbox", href: "Inbox", icon: Mail, badge: navBadges.Inbox },
          can("NotificationsPage") && { name: "Notifications", href: "NotificationsPage", icon: Bell, badge: navBadges.NotificationsPage },
          can("NotificationsPulse") && { name: "Notification Pulse", href: "NotificationsPulse", icon: Activity, subItem: true },
        ].filter(Boolean)
      },
      {
        id: 'operations',
        label: 'Operations',
        collapsible: true,
        items: [
          can("Projects") && { name: "Projects", href: "Projects", icon: Camera },
          can("TonomoIntegrationDashboard") && { name: "Bookings Engine", href: "TonomoIntegrationDashboard", icon: Bot, badge: navBadges.TonomoIntegrationDashboard },
          can("TonomoPulse") && { name: "Live Feed", href: "TonomoPulse", subItem: true },
          can("ClientAgents") && { name: "Contacts", href: "ClientAgents", icon: Users },
          can("Organisations") && { name: "Organisations", href: "Organisations", subItem: true },
          can("Teams") && { name: "Teams", href: "Teams", subItem: true },
          can("People") && { name: "People", href: "People", subItem: true },
        ].filter(Boolean)
      },
      can("Analytics") && {
        id: 'analytics',
        label: 'Analytics',
        collapsible: true,
        items: [
          can("Analytics") && { name: "Analytics", href: "Analytics", icon: BarChart2 },
        ].filter(Boolean)
      },
      can("Prospecting") && {
        id: 'growth',
        label: 'Growth',
        collapsible: true,
        items: [
          can("Prospecting") && { name: "Prospecting", href: "Prospecting", icon: Target },
          can("ClientMonitor") && { name: "Client Monitor", href: "ClientMonitor", icon: UserCheck },
        ].filter(Boolean)
      },
      can("SettingsProductsPackages") && {
        id: 'settings',
        label: 'Settings',
        collapsible: true,
        items: [
          can("SettingsProductsPackages") && { name: "Products & Packages", href: "SettingsProductsPackages", subItem: true },
          can("SettingsPriceMatrix") && { name: "Price Matrix", href: "SettingsPriceMatrix", subItem: true },
          can("SettingsOrganisation") && { name: "Organisation", href: "SettingsOrganisation", subItem: true },
          can("SettingsAutomationRules") && { name: "Automation Rules", href: "SettingsAutomationRules", subItem: true },
          can("SettingsRevisionTemplates") && { name: "Request Templates", href: "SettingsRevisionTemplates", subItem: true },
          can("SettingsIntegrations") && { name: "Integrations", href: "SettingsIntegrations", subItem: true },
          can("EmailSyncSettings") && { name: "Email Sync", href: "EmailSyncSettings", subItem: true },
          can("SettingsTonomoIntegration") && { name: "Bookings Setup", href: "SettingsTonomoIntegration", subItem: true },
          can("SettingsTonomoMappings") && { name: "Mappings", href: "SettingsTonomoMappings", subItem: true },
          can("SettingsNotifications") && { name: "Notifications", href: "SettingsNotifications", subItem: true },
          can("BusinessRequirementsDocument") && { name: "BRD", href: "BusinessRequirementsDocument", subItem: true },
          can("SettingsSystemHealth") && { name: "System Diagnostics", href: "SettingsSystemHealth", subItem: true },
          can("SettingsTeamsUsers") && { name: "Teams & Users", href: "SettingsTeamsUsers", subItem: true },
        ].filter(Boolean)
      },
    ].filter(Boolean);
  }, [user?.role]);



  const toggleSection = (sectionId) => {
    setExpandedSections(prev => ({
      ...prev,
      [sectionId]: !prev[sectionId]
    }));
  };

  const NavLink = ({ item }) => {
    const isActive = currentPageName === item.href;
    
    return (
      <Link
        to={createPageUrl(item.href)}
        onClick={() => setSidebarOpen(false)}
        className={cn(
          "group flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 active:scale-95 min-h-10",
          isActive 
            ? "bg-primary text-primary-foreground font-semibold shadow-md" 
            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground font-medium",
          item.subItem && "ml-0 pl-3 text-xs py-2 opacity-90"
        )}
        title={item.name}
        aria-current={isActive ? "page" : undefined}
      >
        {item.icon && (
          <item.icon className={cn(
            "h-4 w-4 flex-shrink-0 transition-all duration-150", 
            isActive ? "drop-shadow-sm" : "group-hover:scale-110"
          )} />
        )}
        <span className="truncate flex-1">{item.name}</span>
        {item.badge > 0 && (
          <span className={cn(
            "ml-auto flex items-center justify-center text-[10px] font-bold rounded-full min-w-[20px] h-5 px-1.5 tabular-nums",
            isActive
              ? "bg-primary-foreground/20 text-primary-foreground"
              : "bg-red-100 text-red-700"
          )}>
            {item.badge > 99 ? '99+' : item.badge}
          </span>
        )}
      </Link>
    );
  };

  const NavSection = ({ section }) => {
    const isExpanded = expandedSections[section.id];
    const hasItems = section.items && section.items.length > 0;

    return (
      <div key={section.id} className="space-y-1">
        {section.collapsible ? (
          <button
            onClick={() => toggleSection(section.id)}
            className={cn(
              "w-full flex items-center gap-2 px-3 py-2.5 rounded-md font-semibold text-xs transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group",
              isExpanded 
                ? "bg-primary/10 text-primary hover:bg-primary/15" 
                : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/40"
            )}
            title={`${isExpanded ? 'Collapse' : 'Expand'} ${section.label}`}
            aria-expanded={isExpanded}
          >
            <ChevronDown className={cn(
              "h-4 w-4 transition-transform duration-200 flex-shrink-0",
              isExpanded ? "rotate-180 text-primary" : "text-muted-foreground/50"
            )} />
            <span className="flex-1 text-left uppercase tracking-wide">{section.label}</span>
          </button>
        ) : (
          <div className="pt-4 pb-2 px-3 first:pt-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/50">
              {section.label}
            </p>
          </div>
        )}
        
        {hasItems && isExpanded && (
          <div className={cn(
            "space-y-0.5 ml-1 pl-2 border-l-2 border-primary/20 overflow-hidden transition-all duration-200",
            "animate-in fade-in slide-in-from-left-2"
          )}>
            {section.items.map(item => (
              <NavLink key={item.name} item={item} />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <GlobalNotificationBar />
      <NotificationToast />
      <div className="min-h-screen bg-background">
        {/* Desktop Top Bar with Search */}
         <header className="hidden lg:block fixed top-0 left-64 right-0 h-16 bg-card border-b z-40 px-6 shadow-xs backdrop-blur-sm bg-card/97">
           <div className="h-full flex items-center justify-between gap-4">
             {canGoBack && (
               <button onClick={onBack} className="text-muted-foreground hover:text-foreground transition-colors p-2 hover:bg-muted/50 rounded-lg" title="Go back">
                 <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                 </svg>
               </button>
             )}
             <TopSearchBar />
             <div className="flex items-center gap-1.5">
               <span className="text-[10px] text-muted-foreground/50 font-medium hidden xl:inline">Quick: <kbd className="bg-muted/50 px-1.5 py-0.5 rounded text-[9px] border border-border/40">Ctrl+K</kbd></span>
               <Button
                 variant="ghost"
                 size="icon"
                 onClick={() => setSearchOpen(true)}
                 title="Global search (Ctrl+K)"
                 className="flex-shrink-0 hover:bg-muted/50 transition-colors duration-200 h-9 w-9"
                 aria-label="Global search"
               >
                 <Search className="h-4 w-4" />
               </Button>
               <NotificationBell />
             </div>
           </div>
         </header>

         {/* Mobile Header */}
         <header className="lg:hidden fixed top-0 left-0 right-0 h-16 bg-card border-b z-40 shadow-xs backdrop-blur-sm bg-card/97">
           <div className="h-full flex items-center justify-between px-3 gap-2">
             <Button 
              variant="ghost" 
              size="icon"
              onClick={() => setSidebarOpen(true)}
              title="Open menu"
              aria-label="Open navigation menu"
              className="hover:bg-muted/60 transition-all duration-200 h-9 w-9"
             >
               <Menu className="h-4 w-4 transition-transform duration-150" />
             </Button>
             <div className="flex-1 min-w-0">
               <TopSearchBar />
             </div>
             <Button
               variant="ghost"
               size="icon"
               onClick={() => setSearchOpen(true)}
               title="Global search (Ctrl+K)"
               className="hover:bg-muted/60 transition-all duration-200 h-9 w-9"
               aria-label="Global search"
             >
               <Search className="h-4 w-4" />
             </Button>
             <NotificationBell />
           </div>
         </header>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 backdrop-blur-xs z-40 lg:hidden animate-in fade-in duration-150"
          onClick={() => setSidebarOpen(false)}
          role="presentation"
        />
      )}

      {/* Sidebar */}
      <aside className={cn(
        "fixed top-0 left-0 h-full w-64 bg-card border-r z-50 transform transition-all duration-300 lg:translate-x-0 shadow-xl lg:shadow-none",
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="flex flex-col h-full backdrop-blur-sm bg-card/95">
          {/* Logo */}
          <div className="h-16 flex items-center justify-between px-3 border-b bg-gradient-to-b from-primary/5 to-transparent">
            <Link
              to={createPageUrl("Dashboard")}
              onClick={() => setSidebarOpen(false)}
              className="flex items-center gap-2.5 hover:opacity-85 transition-all active:scale-95 focus:outline-none focus:ring-2 focus:ring-primary rounded-lg px-1.5 py-1"
              title="Dashboard (Home)"
              aria-label="Flex Studios home"
           >
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-md">
                <Camera className="h-4 w-4 text-primary-foreground" />
              </div>
              <div className="min-w-0 hidden sm:block">
                <h1 className="font-bold text-sm leading-tight">Flex</h1>
                <p className="text-[10px] text-muted-foreground font-semibold">CRM</p>
              </div>
            </Link>
            <Button 
              variant="ghost" 
              size="icon"
              className="lg:hidden hover:bg-muted/80 transition-colors duration-200 h-9 w-9"
              onClick={() => setSidebarOpen(false)}
              title="Close menu (Esc)"
              aria-label="Close navigation menu"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 p-3 space-y-1 overflow-y-auto scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent">
            {navigationSections.map(section => (
              <NavSection key={section.id} section={section} />
            ))}
          </nav>

          {/* Divider */}
          <div className="px-4 py-1">
            <div className="h-px bg-border/30" />
          </div>

          {/* Footer */}
          <div className="p-3 border-t bg-muted/10 space-y-1.5">
            {user && (
              <div className="px-2.5 py-2 rounded-lg bg-muted/50 border border-border/40 shadow-xs">
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-6 h-6 rounded-full bg-gradient-to-br from-primary/30 to-primary/10 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-bold text-primary">{user.full_name?.charAt(0).toUpperCase() || '?'}</span>
                  </div>
                  <p className="text-xs font-semibold truncate leading-tight" title={user.full_name}>{user.full_name}</p>
                </div>
                <Badge variant="secondary" className={`text-[10px] font-bold ${roleColors[user.role]} w-full justify-center py-0`}>
                  {roleLabels[user.role]}
                </Badge>
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all duration-200 h-9 px-2 text-xs"
              onClick={() => setSearchOpen(true)}
              title="Global search (Ctrl+K)"
            >
              <Search className="h-3.5 w-3.5 flex-shrink-0" />
              <span>Search</span>
              <kbd className="ml-auto text-[8px] bg-muted/40 px-1 py-0.5 rounded border border-border/30">⌘K</kbd>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground hover:bg-destructive/10 transition-all duration-200 h-9 px-2 text-xs"
              onClick={async () => {
                if (confirm("Sign out?")) {
                  try {
                    await base44.auth.logout('/login');
                  } catch {
                    // Fallback: redirect even if signOut call fails
                    window.location.href = '/login';
                  }
                }
              }}
              title="Sign out"
            >
              <LogOut className="h-3.5 w-3.5 flex-shrink-0" />
              <span>Sign Out</span>
            </Button>
          </div>
        </div>
      </aside>

        {/* Main Content */}
        <main className="lg:ml-64 min-h-screen pt-16">
          {children}
        </main>

        <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />

        {/* Chat Panel */}
        {activeChat && openChats.length > 0 && user && (
          <ChatPanel
            openChats={openChats}
            activeChat={activeChat}
            onSetActiveChat={setActiveChat}
            onClose={() => {
              const [type, id] = activeChat.split(':');
              closeChat(type, id);
            }}
            currentUserEmail={user.email}
          />
        )}
      </div>
    </>
  );
}