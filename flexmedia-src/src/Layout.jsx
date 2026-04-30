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
  Target,
  Bot,
  Activity,
  Bell,
  Search,
  UserCheck,
  ChevronRight,
  ChevronLeft,
  Sun,
  Moon,
  Monitor,
  Building2,
  UserRound,
  UsersRound,
  Home,
  Rss,
  Heart,
  Sparkles,
  MapPin,
  Crosshair,
  ListChecks,
  Briefcase,
  Gauge,
  ClipboardList,
  ShieldCheck,
  Upload,
  MessageSquareWarning,
  Plane,
  Palette,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import GlobalSearch from "@/components/common/GlobalSearch";
import TopSearchBar from "@/components/common/TopSearchBar";

import { cn } from "@/lib/utils";
import { api } from "@/api/supabaseClient";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { useAuth } from "@/lib/AuthContext";
import { canAccessRoute } from "@/components/lib/routeAccess";
import { useNotifications, NotificationProvider } from "@/components/notifications/NotificationContext";
import { useEntityList } from "@/components/hooks/useEntityData";
import { useTheme } from "@/lib/ThemeContext";

import GlobalNotificationBar, { NotificationBell } from "@/components/notifications/GlobalNotificationBar";
import NotificationToast from "@/components/notifications/NotificationToast";
import { ActiveTimersProvider } from "@/components/utilization/ActiveTimersContext";
import CalendarConnectBanner from "@/components/calendar/CalendarConnectBanner";
import QuickLogTouchpoint from "@/components/nurturing/QuickLogTouchpoint";
import FeedbackFloatingButton from "@/components/feedback/FeedbackFloatingButton";
import { Eye, XCircle } from "lucide-react";

// ── Simulation Banner ─────────────────────────────────────────────────────
// Shows globally when an owner is impersonating another user's session.
// Pushes all layout content down by its height (h-9 = 36px).
function SimulationBanner() {
  const { isSimulating, simulatedUser, realUser, endSimulation } = useAuth();
  if (!isSimulating) return null;

  const roleBadge = {
    master_admin: 'Owner',
    admin: 'Admin',
    manager: 'Manager',
    employee: 'Staff',
    contractor: 'Contractor',
  }[simulatedUser?.role] || simulatedUser?.role || '?';

  return (
    <div className="fixed top-0 left-0 right-0 z-[200] bg-amber-500 dark:bg-amber-600 text-amber-950 h-9 flex items-center justify-center gap-3 text-xs font-bold shadow-lg select-none">
      <Eye className="h-3.5 w-3.5 flex-shrink-0" />
      <span>
        Viewing as <span className="font-black">{simulatedUser?.name || simulatedUser?.email || '?'}</span>
        <span className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-700/20 text-[10px] uppercase tracking-wide">{roleBadge}</span>
      </span>
      <button
        onClick={endSimulation}
        className="ml-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-800/25 hover:bg-amber-800/40 text-amber-950 text-[10px] font-bold uppercase tracking-wide transition-colors"
      >
        <XCircle className="h-3 w-3" />
        End Simulation
      </button>
    </div>
  );
}


function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  const cycleTheme = () => {
    const order = ["light", "dark", "system"];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
  };

  const icon = theme === "system"
    ? <Monitor className="h-3.5 w-3.5 flex-shrink-0" />
    : resolvedTheme === "dark"
      ? <Moon className="h-3.5 w-3.5 flex-shrink-0" />
      : <Sun className="h-3.5 w-3.5 flex-shrink-0" />;

  const label = theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light";

  return (
    <Button
      variant="ghost"
      size="sm"
      className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all duration-200 h-9 px-2 text-xs"
      onClick={cycleTheme}
      title={`Theme: ${label} (click to cycle)`}
      aria-label={`Switch theme, currently ${label}`}
    >
      {icon}
      <span>{label}</span>
    </Button>
  );
}

const roleColors = {
  master_admin: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  admin: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  manager: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  employee: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  contractor: "bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-400",
};

const roleLabels = {
  master_admin: "Owner",
  admin: "Admin",
  manager: "Manager",
  employee: "Staff",
  contractor: "Contractor",
};

export default function Layout({ children, currentPageName }) {
  return (
    <NotificationProvider>
      <LayoutContentWrapper currentPageName={currentPageName} children={children} />
    </NotificationProvider>
  );
}

function LayoutContentWrapper({ currentPageName, children }) {
  const { data: user } = useCurrentUser();

  return (
    <ActiveTimersProvider currentUser={user || null}>
      <LayoutContent currentPageName={currentPageName} children={children} />
    </ActiveTimersProvider>
  );
}

function LayoutContent({ currentPageName, children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickLogOpen, setQuickLogOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true');
  const toggleCollapsed = () => setCollapsed(prev => {
    const next = !prev;
    localStorage.setItem('sidebar-collapsed', String(next));
    return next;
  });
  const { data: user } = useCurrentUser();
  
  // ── Live badge counts for nav ──────────────────────────────────────────
  const { unreadCount: notifUnread } = useNotifications();
  const { data: navEmails = [] } = useEntityList("EmailMessage", "-received_at", 500);
  const { data: navProjects = [] } = useEntityList("Project", null, 500);

  const navBadges = useMemo(() => {
    const inboxUnread = navEmails.filter(m => m.is_unread && !m.is_archived && !m.is_deleted).length;
    const pendingReview = navProjects.filter(p => p.status === 'pending_review').length;
    return {
      Inbox: inboxUnread,
      NotificationsPage: notifUnread,
      TonomoIntegrationDashboard: pendingReview,
    };
  }, [navEmails, navProjects, notifUnread]);
  // Track in-app navigation depth so back button only shows when there is a
  // real in-app page to go back to (not an external site or first load).
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => {
    const depth = parseInt(sessionStorage.getItem('nav-depth') || '0', 10);
    const next = depth + 1;
    sessionStorage.setItem('nav-depth', String(next));
    setCanGoBack(next > 1);
  }, [currentPageName]);
  
  // Collapsible sections state — persisted to localStorage
  const [expandedSections, setExpandedSections] = useState(() => {
    try {
      const saved = localStorage.getItem('nav-expanded-sections');
      return saved ? JSON.parse(saved) : {
        workspace: true,
        operations: true,
        bookings: true,
        contacts: true,
        social: true,
        growth: false,
        settings: false
      };
    } catch {
      return { workspace: true, operations: true, bookings: true, contacts: true, social: true, growth: false, settings: false };
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
      // Ctrl/Cmd+Shift+L: Quick log touchpoint
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "L") {
        e.preventDefault();
        setQuickLogOpen(v => !v);
      }
      // Esc closes sidebar on mobile, or search dialog
      if (e.key === "Escape") {
        if (searchOpen) {
          setSearchOpen(false);
        } else if (sidebarOpen) {
          setSidebarOpen(false);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sidebarOpen, searchOpen]);

  // Navigation structure — role-aware, with parent/child nesting
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
          can("NotificationsPage") && {
            name: "Notifications", href: "NotificationsPage", icon: Bell, badge: navBadges.NotificationsPage,
            children: [
              can("NotificationsPulse") && { name: "Pulse", href: "NotificationsPulse", icon: Activity },
            ].filter(Boolean)
          },
          can("Feedback2") && { name: "Feedback", href: "Feedback2", icon: MessageSquareWarning },
        ].filter(Boolean)
      },
      {
        id: 'operations',
        label: 'Operations',
        collapsible: true,
        items: [
          can("Projects") && { name: "Projects", href: "Projects", icon: Camera },
          can("Tasks") && { name: "Tasks", href: "Tasks", icon: ListChecks },
          can("Goals") && { name: "Goals", href: "Goals", icon: Target },
          can("TonomoIntegrationDashboard") && {
            name: "Bookings Engine", href: "TonomoIntegrationDashboard", icon: Bot, badge: navBadges.TonomoIntegrationDashboard,
            children: [
              can("TonomoPulse") && { name: "Live Feed", href: "TonomoPulse", icon: Rss },
            ].filter(Boolean)
          },
          can("DroneCommandCenter") && {
            name: "Drones", href: "DroneCommandCenter", icon: Plane,
            children: [
              can("AdminDroneThemes") && { name: "System Themes", href: "AdminDroneThemes", icon: Palette },
            ].filter(Boolean),
          },
          can("ShortlistingCommandCenter") && {
            name: "Shortlisting", href: "ShortlistingCommandCenter", icon: Sparkles,
          },
        ].filter(Boolean)
      },
      (can("ClientAgents") || can("Organisations") || can("People") || can("Teams")) && {
        id: 'contacts',
        label: 'Contacts',
        collapsible: true,
        items: [
          can("ClientAgents") && { name: "Overview", href: "ClientAgents", icon: Users },
          can("Organisations") && { name: "Organisations", href: "Organisations", icon: Building2 },
          can("Teams") && { name: "Teams", href: "Teams", icon: UsersRound },
          can("People") && { name: "People", href: "People", icon: UserRound },
          can("Properties") && { name: "Properties", href: "Properties", icon: Home },
        ].filter(Boolean)
      },
      can("SocialMedia") && {
        id: 'social',
        label: 'Social Media',
        collapsible: true,
        items: [
          can("SocialMedia") && { name: "Favorites", href: "SocialMedia", icon: Heart },
        ].filter(Boolean)
      },
      can("Prospecting") && {
        id: 'growth',
        label: 'Growth',
        collapsible: true,
        items: [
          can("SalesCommand") && { name: "Sales Command", href: "SalesCommand", icon: Crosshair },
          can("IndustryPulse") && { name: "Industry Pulse", href: "IndustryPulse", icon: Rss },
          can("Prospecting") && { name: "Pipeline", href: "Prospecting", icon: Target },
          can("PropertyProspects") && { name: "Property Prospects", href: "PropertyProspects", icon: Target },
          can("SalesMap") && { name: "Sales Map", href: "SalesMap", icon: MapPin },
          can("ClientMonitor") && { name: "Client Retention", href: "ClientMonitor", icon: UserCheck },
          can("TalentPulse") && { name: "Talent Pulse", href: "TalentPulse", icon: Briefcase },
        ].filter(Boolean)
      },
      can("SettingsProductsPackages") && {
        id: 'settings',
        label: 'Settings',
        collapsible: true,
        items: [
          can("SettingsProductsPackages") && { name: "Products & Packages", href: "SettingsProductsPackages" },
          can("SettingsPriceMatrix") && { name: "Price Matrix", href: "SettingsPriceMatrix" },
          can("SettingsOrganisation") && { name: "Organisation", href: "SettingsOrganisation" },
          can("SettingsAutomationRules") && { name: "Automation Rules", href: "SettingsAutomationRules" },
          can("SettingsRevisionTemplates") && { name: "Request Templates", href: "SettingsRevisionTemplates" },
          // Integrations removed — use Tonomo Integration page instead
          can("EmailSyncSettings") && { name: "Email Sync", href: "EmailSyncSettings" },
          can("SettingsEmailSyncHealth") && { name: "Email Sync Health", href: "SettingsEmailSyncHealth" },
          can("SettingsDataConsistency") && { name: "Data Consistency", href: "SettingsDataConsistency", icon: ShieldCheck },
          can("SettingsLegacyPackageMapping") && { name: "Legacy Package Mapping", href: "SettingsLegacyPackageMapping" },
          can("SettingsLegacyImport") && { name: "Legacy Import", href: "SettingsLegacyImport", icon: Upload },
          can("SettingsLegacyCrmReconciliation") && { name: "Legacy Pulse Reconciliation", href: "SettingsLegacyCrmReconciliation" },
          can("EdgeFunctionHealth") && { name: "Edge Function Health", href: "EdgeFunctionHealth", icon: Gauge },
          can("EdgeFunctionAuditLog") && { name: "Edge Function Audit Log", href: "EdgeFunctionAuditLog", icon: ClipboardList },
          can("SettingsOperationsHealth") && { name: "Operations Health", href: "SettingsOperationsHealth", icon: Activity },
          can("SettingsTonomoIntegration") && { name: "Bookings Setup", href: "SettingsTonomoIntegration" },
          can("SettingsTonomoMappings") && { name: "Mappings", href: "SettingsTonomoMappings" },
          can("SettingsNotifications") && { name: "Notifications", href: "SettingsNotifications" },
          can("BusinessRequirementsDocument") && { name: "BRD", href: "BusinessRequirementsDocument" },
          can("SettingsTeamsUsers") && { name: "Teams & Users", href: "SettingsTeamsUsers" },
          can("SettingsAI") && { name: "AI Settings", href: "SettingsAI", icon: Sparkles },
          can("AIAuditLog") && { name: "AI Audit", href: "AIAuditLog", icon: Activity },
          can("SettingsShortlistingSlots") && { name: "Shortlist · Slots", href: "SettingsShortlistingSlots", icon: Sparkles },
          can("SettingsShortlistingStandards") && { name: "Shortlist · Standards", href: "SettingsShortlistingStandards", icon: Sparkles },
          can("SettingsShortlistingSignals") && { name: "Shortlist · Signals", href: "SettingsShortlistingSignals", icon: Sparkles },
          can("ShortlistingCalibration") && { name: "Shortlist · Calibration", href: "ShortlistingCalibration", icon: Sparkles },
          can("SettingsShortlistingTraining") && { name: "Shortlist · Training", href: "SettingsShortlistingTraining", icon: Sparkles },
          can("SettingsShortlistingOverrides") && { name: "Shortlist · Overrides", href: "SettingsShortlistingOverrides", icon: Sparkles },
          can("SettingsShortlistingPrompts") && { name: "Shortlist · Prompts", href: "SettingsShortlistingPrompts", icon: Sparkles },
          can("SettingsEngineSettings") && { name: "Shortlist · Engine Settings", href: "SettingsEngineSettings", icon: Sparkles },
          can("SettingsPackageTierMapping") && { name: "Shortlist · Tier Mapping", href: "SettingsPackageTierMapping", icon: Sparkles },
          can("SettingsVendorComparison") && { name: "Shortlist · Vendor Comparison", href: "SettingsVendorComparison", icon: Sparkles },
        ].filter(Boolean)
      },
    ].filter(Boolean);
  }, [user?.role, navBadges]);

  // Track which parent items have their children expanded (must be before auto-expand effect)
  const [expandedParents, setExpandedParents] = useState({});

  // Auto-expand the section containing the current active page
  // BUG FIX: use functional updaters to read current state, avoiding stale closure
  // over expandedSections (which was missing from the dependency array and would
  // cause the effect to always read the initial value on subsequent page navigations)
  useEffect(() => {
    if (!currentPageName || navigationSections.length === 0) return;
    for (const section of navigationSections) {
      if (!section.items) continue;
      const isInSection = section.items.some(item =>
        item.href === currentPageName ||
        (item.children && item.children.some(c => c.href === currentPageName))
      );
      if (isInSection) {
        setExpandedSections(prev => {
          if (prev[section.id]) return prev; // already expanded, no-op
          return { ...prev, [section.id]: true };
        });
        for (const item of section.items) {
          if (item.children && item.children.some(c => c.href === currentPageName)) {
            setExpandedParents(prev => ({ ...prev, [item.name]: true }));
          }
        }
        break;
      }
    }
  }, [currentPageName, navigationSections]);

  const toggleSection = (sectionId) => {
    setExpandedSections(prev => ({
      ...prev,
      [sectionId]: !prev[sectionId]
    }));
  };

  const toggleParent = (name, forceOpen) => setExpandedParents(prev => ({ ...prev, [name]: forceOpen === true ? true : !prev[name] }));

  const NavLink = ({ item, isChild }) => {
    const isActive = currentPageName === item.href;
    const hasChildren = item.children && item.children.length > 0;
    const isParentExpanded = expandedParents[item.name];
    // A parent is "active" if it or any of its children is active
    const isChildActive = hasChildren && item.children.some(c => currentPageName === c.href);
    const isEffectivelyActive = isActive || isChildActive;

    return (
      <div>
        <div className="flex items-center">
          <Link
            to={createPageUrl(item.href)}
            onClick={() => {
              setSidebarOpen(false);
              // If collapsed and item has children, expand sidebar so children are visible
              if (collapsed && hasChildren) {
                const next = false;
                setCollapsed(next);
                localStorage.setItem('sidebar-collapsed', String(next));
                toggleParent(item.name, true);
              }
            }}
            className={cn(
              "group flex items-center gap-2.5 rounded-md text-sm transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 active:scale-[0.98] flex-1",
              collapsed ? "relative justify-center px-1.5 py-1.5" : "px-3 py-1.5",
              isActive
                ? "bg-primary/10 text-primary font-semibold ring-1 ring-primary/20"
                : isChildActive
                  ? "bg-muted/60 text-foreground font-medium"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground font-medium",
              isChild && "text-[13px] py-1 pl-2"
            )}
            title={item.name}
            aria-current={isActive ? "page" : undefined}
          >
            {item.icon ? (
              <item.icon className={cn(
                "h-4 w-4 flex-shrink-0 transition-all duration-150",
                isChild && "h-3.5 w-3.5",
                isActive ? "drop-shadow-sm" : "group-hover:scale-110"
              )} />
            ) : collapsed ? (
              <span className="text-[10px] font-bold uppercase leading-none">{item.name?.charAt(0) || '·'}</span>
            ) : null}
            {!collapsed && <span className="truncate flex-1">{item.name}</span>}
            {!collapsed && item.badge > 0 && (
              <span className="ml-auto flex items-center justify-center text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 tabular-nums bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400">
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            )}
            {/* Collapsed badge dot indicator */}
            {collapsed && item.badge > 0 && (
              <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-red-500" />
            )}
          </Link>
          {hasChildren && !collapsed && (
            <button
              onClick={(e) => { e.stopPropagation(); toggleParent(item.name); }}
              className={cn(
                "p-1.5 rounded-md transition-colors flex-shrink-0 mr-1",
                isEffectivelyActive
                  ? "text-primary hover:bg-primary/10"
                  : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/40"
              )}
              aria-expanded={isParentExpanded}
              aria-label={`${isParentExpanded ? 'Collapse' : 'Expand'} ${item.name} sub-items`}
              title={`${isParentExpanded ? 'Hide' : 'Show'} ${item.name} sub-items`}
            >
              <ChevronRight className={cn(
                "h-3.5 w-3.5 transition-transform duration-200",
                isParentExpanded && "rotate-90"
              )} />
            </button>
          )}
        </div>
        {hasChildren && isParentExpanded && !collapsed && (
          <div className="ml-4 pl-2 mt-0.5 space-y-0.5 border-l border-border/50">
            {item.children.map(child => (
              <NavLink key={child.name} item={child} isChild />
            ))}
          </div>
        )}
      </div>
    );
  };

  const NavSection = ({ section }) => {
    const isExpanded = expandedSections[section.id];
    const hasItems = section.items && section.items.length > 0;

    // When collapsed, show a thin separator line instead of section headers,
    // and always show items (no expand/collapse for sections in icon mode)
    if (collapsed) {
      return (
        <div key={section.id} className="space-y-0.5">
          <div className="mx-2 my-1 border-t border-border/30" title={section.label} />
          {hasItems && section.items.map(item => (
            <NavLink key={item.name} item={item} />
          ))}
        </div>
      );
    }

    return (
      <div key={section.id} className="space-y-1">
        {section.collapsible ? (
          <button
            onClick={() => toggleSection(section.id)}
            className={cn(
              "w-full flex items-center gap-1.5 px-3 py-1.5 rounded-md font-semibold text-[11px] transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 group",
              isExpanded
                ? "text-foreground/80 hover:bg-muted/40"
                : "text-muted-foreground/50 hover:text-foreground hover:bg-muted/40"
            )}
            title={`${isExpanded ? 'Collapse' : 'Expand'} ${section.label}`}
            aria-expanded={isExpanded}
          >
            <ChevronRight className={cn(
              "h-3 w-3 transition-transform duration-200 flex-shrink-0",
              isExpanded && "rotate-90"
            )} />
            <span className="flex-1 text-left uppercase tracking-wider">{section.label}</span>
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
            "space-y-0.5 ml-1 pl-2 border-l border-border/50 overflow-hidden transition-all duration-200",
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

  const { isSimulating } = useAuth();

  return (
    <>
      <SimulationBanner />
      <GlobalNotificationBar />
      <NotificationToast />
      {/* Global Quick Log Touchpoint (Ctrl+Shift+L) */}
      <QuickLogTouchpoint open={quickLogOpen} onClose={() => setQuickLogOpen(false)} />
      {/* Global Feedback "Report" button — hidden on /Feedback2 to avoid redundancy */}
      <FeedbackFloatingButton />
      {/* Skip to content link for keyboard navigation */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-md focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:text-sm focus:font-medium"
      >
        Skip to content
      </a>
      <div className="min-h-screen bg-background">
        {/* Desktop Top Bar with Search */}
         <header className={cn("hidden lg:block fixed right-0 h-12 bg-card border-b z-40 px-4 shadow-xs backdrop-blur-sm bg-card/97 transition-all duration-200", collapsed ? "left-14" : "left-56", isSimulating ? "top-9" : "top-0")}>
           <div className="h-full flex items-center justify-between gap-3">
             {canGoBack && (
               <button onClick={() => window.history.back()} className="text-muted-foreground hover:text-foreground transition-colors p-1.5 hover:bg-muted/50 rounded-lg" title="Go back" aria-label="Go back to previous page">
                 <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                 </svg>
               </button>
             )}
             <TopSearchBar />
             <div className="flex items-center gap-1.5">
               <span className="text-[9px] text-muted-foreground/50 font-medium hidden xl:inline">Search: <kbd className="bg-muted/50 px-1 py-0.5 rounded text-[9px] border border-border/40">{navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl+'}K</kbd> Log: <kbd className="bg-muted/50 px-1 py-0.5 rounded text-[9px] border border-border/40">{navigator.platform?.includes('Mac') ? '⌘⇧' : 'Ctrl+Shift+'}L</kbd></span>
               <Button
                 variant="ghost"
                 size="icon"
                 onClick={() => setSearchOpen(true)}
                 title="Global search (Ctrl+K)"
                 className="flex-shrink-0 hover:bg-muted/50 transition-colors duration-200 h-8 w-8"
                 aria-label="Global search"
               >
                 <Search className="h-3.5 w-3.5" />
               </Button>
               <NotificationBell />
             </div>
           </div>
         </header>

         {/* Mobile Header */}
         <header className={cn("lg:hidden fixed left-0 right-0 h-14 bg-card border-b z-40 shadow-xs backdrop-blur-sm bg-card/97", isSimulating ? "top-9" : "top-0")}>
           <div className="h-full flex items-center justify-between px-2 gap-1.5">
             <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(true)}
              title="Open menu"
              aria-label="Open navigation menu"
              className="hover:bg-muted/60 transition-all duration-200 min-h-[44px] min-w-[44px] h-11 w-11"
             >
               <Menu className="h-5 w-5 transition-transform duration-150" />
             </Button>
             <div className="flex-1 min-w-0">
               <TopSearchBar />
             </div>
             <Button
               variant="ghost"
               size="icon"
               onClick={() => setSearchOpen(true)}
               title="Global search (Ctrl+K)"
               className="hover:bg-muted/60 transition-all duration-200 min-h-[44px] min-w-[44px] h-11 w-11"
               aria-label="Global search"
             >
               <Search className="h-5 w-5" />
             </Button>
             <NotificationBell />
           </div>
         </header>

      {/* Mobile Sidebar Overlay */}
      <div
        className={cn(
          "fixed inset-0 bg-black/50 backdrop-blur-xs z-40 lg:hidden transition-opacity duration-300",
          sidebarOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        )}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />

      {/* Sidebar */}
      <aside
        aria-label="Main navigation"
        className={cn(
        "fixed left-0 h-full bg-card border-r z-50 transform transition-all duration-200 ease-out lg:translate-x-0 shadow-xl lg:shadow-none will-change-transform",
        // Mobile: always full-width overlay; Desktop: collapsed = w-14, expanded = w-56
        "w-[280px] max-w-[85vw]",
        collapsed ? "lg:w-14" : "lg:w-56",
            isSimulating ? "top-9" : "top-0",
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="flex flex-col h-full backdrop-blur-sm bg-card/95">
          {/* Logo */}
          <div className={cn("h-12 flex items-center justify-between border-b bg-gradient-to-b from-primary/5 to-transparent", collapsed ? "px-1.5" : "px-3")}>
            <Link
              to={createPageUrl("Dashboard")}
              onClick={() => setSidebarOpen(false)}
              className={cn("flex items-center hover:opacity-85 transition-all active:scale-95 focus:outline-none focus:ring-2 focus:ring-primary rounded-lg py-1", collapsed ? "justify-center px-0.5" : "gap-2.5 px-1.5")}
              title="Dashboard (Home)"
              aria-label="Flex Studios home"
           >
              <div className={cn("rounded-lg bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-md", collapsed ? "w-8 h-8" : "w-8 h-8")}>
                <Camera className="h-4 w-4 text-primary-foreground" />
              </div>
              {!collapsed && (
                <div className="min-w-0 hidden sm:block">
                  <span className="font-bold text-sm leading-tight block">Flex</span>
                  <span className="text-[10px] text-muted-foreground font-semibold block">CRM</span>
                </div>
              )}
            </Link>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden hover:bg-muted/80 transition-colors duration-200 min-h-[44px] min-w-[44px] h-11 w-11"
              onClick={() => setSidebarOpen(false)}
              title="Close menu (Esc)"
              aria-label="Close navigation menu"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>

          {/* Navigation */}
          <nav aria-label="Sidebar navigation" className={cn("flex-1 space-y-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent", collapsed ? "p-1" : "p-3")}>
            {navigationSections.map(section => (
              <NavSection key={section.id} section={section} />
            ))}
          </nav>

          {/* Footer */}
          <div className={cn("border-t border-border/40 space-y-1.5", collapsed ? "p-1" : "p-3")}>
            {user && !collapsed && (
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
            {user && collapsed && (
              <div className="flex justify-center py-1" title={`${user.full_name} (${roleLabels[user.role]})`}>
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary/30 to-primary/10 flex items-center justify-center">
                  <span className="text-xs font-bold text-primary">{user.full_name?.charAt(0).toUpperCase() || '?'}</span>
                </div>
              </div>
            )}
            {!collapsed && <ThemeToggle />}
            {collapsed ? (
              <Button
                variant="ghost"
                size="icon"
                className="w-full h-8 text-muted-foreground hover:text-foreground hover:bg-destructive/10 transition-all duration-200"
                onClick={async () => {
                  if (confirm("Sign out?")) {
                    try {
                      await api.auth.logout('/login');
                    } catch {
                      window.location.href = '/login';
                    }
                  }
                }}
                title="Sign out"
                aria-label="Sign out of your account"
              >
                <LogOut className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground hover:bg-destructive/10 transition-all duration-200 h-9 px-2 text-xs"
                onClick={async () => {
                  if (confirm("Sign out?")) {
                    try {
                      await api.auth.logout('/login');
                    } catch {
                      window.location.href = '/login';
                    }
                  }
                }}
                title="Sign out"
                aria-label="Sign out of your account"
              >
                <LogOut className="h-3.5 w-3.5 flex-shrink-0" />
                <span>Sign Out</span>
              </Button>
            )}
            {/* Collapse/Expand toggle — desktop only */}
            <button
              onClick={toggleCollapsed}
              className="hidden lg:flex w-full items-center justify-center h-8 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-all duration-200"
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </aside>

        {/* Main Content */}
        <main id="main-content" role="main" className={cn("min-h-screen transition-all duration-200", collapsed ? "lg:ml-14" : "lg:ml-56", isSimulating ? "pt-[calc(3.5rem+36px)] lg:pt-[calc(3rem+36px)]" : "pt-14 lg:pt-12")} style={{ scrollbarGutter: 'stable' }}>
          <CalendarConnectBanner />
          {children}
        </main>

        <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />

      </div>
    </>
  );
}