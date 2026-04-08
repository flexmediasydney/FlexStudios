/**
 * Route access control matrix.
 * Single source of truth for which roles can access which pages.
 * Used by RouteGuard (App.jsx) and Layout.jsx nav filtering.
 * 
 * If a page is NOT listed here, defaults to master_admin only.
 */

const ALL_ROLES = ['master_admin', 'employee'];
const ADMIN_EMPLOYEE = ['master_admin', 'employee'];
const ADMIN_ONLY = ['master_admin'];

export const ROUTE_ACCESS = {
  // ── WORKSPACE ─────────────────────────────────────────────
  Dashboard: ALL_ROLES,
  Calendar: ALL_ROLES,
  Inbox: ALL_ROLES,
  NotificationsPage: ALL_ROLES,
  UserSettings: ALL_ROLES,

  // ── PROJECTS ──────────────────────────────────────────────────
  Projects: ALL_ROLES,
  ProjectDetails: ALL_ROLES,

  // ── CONTACTS & CRM ────────────────────────────────────────
  ClientAgents: ADMIN_EMPLOYEE,
  Organisations: ADMIN_EMPLOYEE,
  Teams: ADMIN_EMPLOYEE,
  People: ADMIN_EMPLOYEE,
  PersonDetails: ADMIN_EMPLOYEE,
  OrgDetails: ADMIN_EMPLOYEE,
  TeamDetails: ADMIN_EMPLOYEE,
  Prospecting: ADMIN_EMPLOYEE,
  ProspectDetails: ADMIN_EMPLOYEE,
  ClientMonitor: ADMIN_EMPLOYEE,

  // ── SOCIAL MEDIA ──────────────────────────────────────────
  SocialMedia: ALL_ROLES,

  // ── ANALYTICS ─────────────────────────────────────────────
  Analytics: ADMIN_EMPLOYEE,
  Reports: ADMIN_EMPLOYEE,
  BusinessIntelligence: ADMIN_ONLY,
  EmployeeUtilization: ADMIN_ONLY,

  // ── PRODUCTS & PRICING ────────────────────────────────────
  Products: ADMIN_EMPLOYEE,
  Packages: ADMIN_EMPLOYEE,
  PriceMatrix: ADMIN_EMPLOYEE,
  SettingsProductsPackages: ADMIN_EMPLOYEE,
  SettingsPriceMatrix: ADMIN_EMPLOYEE,

  // ── TONOMO / BOOKINGS ─────────────────────────────────────
  TonomoIntegrationDashboard: ADMIN_EMPLOYEE,
  TonomoPulse: ADMIN_EMPLOYEE,

  // ── PUBLIC / GALLERY ──────────────────────────────────────
  ClientGallery: ALL_ROLES,
  MarketingWithFlex: ALL_ROLES,
  SoldWithFlex: ALL_ROLES,
  BountyBoard: ALL_ROLES,
  InternalRoadmap: ALL_ROLES,

  // ── SETTINGS ──────────────────────────────────────────────
  Settings: ADMIN_EMPLOYEE,
  SettingsOrganisation: ADMIN_EMPLOYEE,
  SettingsAutomationRules: ADMIN_EMPLOYEE,
  SettingsRevisionTemplates: ADMIN_EMPLOYEE,
  SettingsIntegrations: ADMIN_EMPLOYEE,
  EmailSyncSettings: ADMIN_EMPLOYEE,
  SettingsTonomoIntegration: ADMIN_EMPLOYEE,
  SettingsTonomoMappings: ADMIN_EMPLOYEE,
  SettingsNotifications: ADMIN_EMPLOYEE,
  SettingsClients: ADMIN_EMPLOYEE,
  SettingsProjectRulebook: ADMIN_EMPLOYEE,
  SettingsTonomoWebhooks: ADMIN_EMPLOYEE,
  BusinessRequirementsDocument: ADMIN_EMPLOYEE,
  HierarchyVisualization: ADMIN_EMPLOYEE,

  // SettingsStaffDefaults removed — now a subtab in SettingsTeamsUsers
  SettingsSystemHealth: ADMIN_ONLY,

  // ── ADMIN ONLY ────────────────────────────────────────────
  SettingsTeamsUsers: ADMIN_ONLY,
  Users: ADMIN_ONLY,
  NotificationsPulse: ADMIN_ONLY,
  TeamPulsePage: ADMIN_ONLY,
  AdminTodoList: ADMIN_ONLY,
};

/**
 * Check if a user role can access a given route.
 * Unlisted routes default to master_admin only (deny by default).
 */
export function canAccessRoute(routeName, userRole) {
  if (!routeName || !userRole) return false;
  const allowed = ROUTE_ACCESS[routeName];
  if (!allowed) return userRole === 'master_admin';
  return allowed.includes(userRole);
}

/**
 * Get the access level description for a page + role combination.
 */
export function getAccessLevel(routeName, userRole) {
  // BUG FIX: Guard against null/undefined role — must deny access, not fall through.
  if (!userRole) return 'none';
  const allowed = ROUTE_ACCESS[routeName];
  if (!allowed || !allowed.includes(userRole)) return 'none';
  return 'full';
}

/**
 * Get all route names accessible by a given role.
 */
export function getAccessibleRoutes(userRole) {
  // BUG FIX: Guard against null/undefined role — return empty array, not all routes
  if (!userRole) return [];
  return Object.entries(ROUTE_ACCESS)
    .filter(([_, roles]) => roles.includes(userRole))
    .map(([route]) => route);
}