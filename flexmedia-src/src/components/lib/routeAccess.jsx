/**
 * Route access control matrix.
 * Single source of truth for which roles can access which pages.
 * Used by RouteGuard (App.jsx) and Layout.jsx nav filtering.
 * 
 * If a page is NOT listed here, defaults to master_admin only.
 */

const ALL_LEVELS = ['master_admin', 'admin', 'manager', 'employee', 'contractor'];
const EMPLOYEE_AND_ABOVE = ['master_admin', 'admin', 'manager', 'employee'];
const MANAGER_AND_ABOVE = ['master_admin', 'admin', 'manager'];
const ADMIN_AND_ABOVE = ['master_admin', 'admin'];
const OWNER_ONLY = ['master_admin'];

export const ROUTE_ACCESS = {
  // ── WORKSPACE (all levels) ────────────────────────────────
  Dashboard: ALL_LEVELS,
  Calendar: ALL_LEVELS,
  Inbox: EMPLOYEE_AND_ABOVE,
  NotificationsPage: ALL_LEVELS,
  UserSettings: ALL_LEVELS,

  // ── PROJECTS (all levels) ─────────────────────────────────
  Projects: ALL_LEVELS,
  ProjectDetails: ALL_LEVELS,
  ProjectLocation: ALL_LEVELS, // view: any project member; edit gated inside the page
  DronePinEditor: EMPLOYEE_AND_ABOVE,
  // DroneBoundaryEditor mirrors PinEditor's role gate. The server-side
  // drone-boundary-save edge fn explicitly 403s contractors — the route
  // gate keeps the UI consistent so contractors never land on a page that
  // would error on save. (Wave 5 P2 S5)
  DroneBoundaryEditor: EMPLOYEE_AND_ABOVE,
  Tasks: ALL_LEVELS,
  Goals: ALL_LEVELS,
  GoalDetails: ALL_LEVELS,

  // ── DRONE MODULE ──────────────────────────────────────────
  DroneCommandCenter: ADMIN_AND_ABOVE,
  AdminDroneThemes: OWNER_ONLY, // global system theme — master_admin only

  // ── SHORTLISTING MODULE ───────────────────────────────────
  ShortlistingCommandCenter: ADMIN_AND_ABOVE,
  SettingsShortlistingSlots: OWNER_ONLY,
  SettingsShortlistingRoomTypes: OWNER_ONLY,
  SettingsShortlistingStandards: OWNER_ONLY,
  SettingsShortlistingSignals: OWNER_ONLY,
  ShortlistingCalibration: OWNER_ONLY,
  SettingsShortlistingTraining: OWNER_ONLY,
  SettingsShortlistingOverrides: OWNER_ONLY,
  SettingsShortlistingPrompts: OWNER_ONLY,
  SettingsEngineSettings: OWNER_ONLY,
  SettingsPackageTierMapping: OWNER_ONLY,
  SettingsVendorComparison: OWNER_ONLY,
  // Wave 11.7.7 / W11.6 — Shape D operator UX surfaces.
  MasterListingReview: ADMIN_AND_ABOVE,
  Stage4Overrides: ADMIN_AND_ABOVE,
  EngineDashboard: ADMIN_AND_ABOVE,
  // Wave 14 — engine calibration runner / drift dashboard.
  CalibrationDashboard: OWNER_ONLY,
  // Wave 15a — internal finals scoring QA dashboard.
  FinalsQADashboard: OWNER_ONLY,
  // Wave 12 / W11.6.11 — discovery queue for slot + object candidates.
  SettingsObjectRegistryDiscovery: OWNER_ONLY,
  // Wave 12.B — full object registry curation: browse canonicals, review
  // discovery queue, view normalisation stats. master_admin only because
  // mutations rewrite the canonical taxonomy used by Stage 1 grounding.
  SettingsObjectRegistry: OWNER_ONLY,
  // Wave 12.7-12.8 — AI suggestion engine review surface (slot + room-type
  // proposals). master_admin only because approve/merge mutations extend
  // the canonical slot/room-type taxonomies.
  SettingsAISuggestions: OWNER_ONLY,
  // W11.6.10 — engine override patterns analytics dashboard.
  SettingsEngineOverridePatterns: ADMIN_AND_ABOVE,

  // ── CONTACTS & CRM (manager+) ────────────────────────────
  ClientAgents: MANAGER_AND_ABOVE,
  Organisations: MANAGER_AND_ABOVE,
  People: EMPLOYEE_AND_ABOVE,
  PersonDetails: EMPLOYEE_AND_ABOVE,
  OrgDetails: EMPLOYEE_AND_ABOVE,
  TeamDetails: EMPLOYEE_AND_ABOVE,
  Properties: EMPLOYEE_AND_ABOVE,
  PropertyDetails: EMPLOYEE_AND_ABOVE,
  PropertyProspects: MANAGER_AND_ABOVE,
  PropertyMergeTool: ADMIN_AND_ABOVE,
  Prospecting: MANAGER_AND_ABOVE,
  ProspectDetails: MANAGER_AND_ABOVE,
  ClientMonitor: MANAGER_AND_ABOVE,
  IndustryPulse: MANAGER_AND_ABOVE,
  PulseListingDetail: MANAGER_AND_ABOVE,
  SalesCommand: MANAGER_AND_ABOVE,
  SalesMap: MANAGER_AND_ABOVE,
  TalentPulse: MANAGER_AND_ABOVE,

  // ── SOCIAL MEDIA (all levels) ─────────────────────────────
  SocialMedia: ALL_LEVELS,

  // ── FIELD MODE (all levels) ───────────────────────────────
  FieldMode: ALL_LEVELS,

  // ── ANALYTICS (manager+) ─────────────────────────────────
  Reports: MANAGER_AND_ABOVE,
  'Reports/LegacyMarketShare': MANAGER_AND_ABOVE,

  // ── PRODUCTS & PRICING (admin+) ──────────────────────────
  Products: ADMIN_AND_ABOVE,
  Packages: ADMIN_AND_ABOVE,
  PriceMatrix: ADMIN_AND_ABOVE,
  SettingsProductsPackages: ADMIN_AND_ABOVE,
  SettingsPriceMatrix: ADMIN_AND_ABOVE,

  // ── TONOMO / BOOKINGS (manager+) ─────────────────────────
  TonomoIntegrationDashboard: MANAGER_AND_ABOVE,
  TonomoPulse: MANAGER_AND_ABOVE,

  // ── PUBLIC / GALLERY (all levels) ─────────────────────────
  ClientGallery: ALL_LEVELS,
  MarketingWithFlex: ALL_LEVELS,
  SoldWithFlex: ALL_LEVELS,
  BountyBoard: ALL_LEVELS,
  InternalRoadmap: ALL_LEVELS,
  Favorites: ALL_LEVELS,
  Feedback2: ALL_LEVELS,

  // ── SETTINGS (admin+) ────────────────────────────────────
  Settings: ADMIN_AND_ABOVE,
  SettingsOrganisation: ADMIN_AND_ABOVE,
  SettingsAutomationRules: ADMIN_AND_ABOVE,
  SettingsRevisionTemplates: ADMIN_AND_ABOVE,
  SettingsIntegrations: ADMIN_AND_ABOVE,
  EmailSyncSettings: ADMIN_AND_ABOVE,
  SettingsEmailSyncHealth: ADMIN_AND_ABOVE,
  SettingsOperationsHealth: ADMIN_AND_ABOVE,
  EdgeFunctionHealth: ADMIN_AND_ABOVE,
  EdgeFunctionAuditLog: ADMIN_AND_ABOVE,
  SettingsTonomoIntegration: ADMIN_AND_ABOVE,
  SettingsTonomoMappings: ADMIN_AND_ABOVE,
  SettingsNotifications: ADMIN_AND_ABOVE,
  SettingsClients: ADMIN_AND_ABOVE,
  SettingsDataConsistency: ADMIN_AND_ABOVE,
  SettingsLegacyPackageMapping: ADMIN_AND_ABOVE,
  SettingsLegacyImport: ADMIN_AND_ABOVE,
  SettingsLegacyCrmReconciliation: ADMIN_AND_ABOVE,
  SettingsProjectRulebook: ADMIN_AND_ABOVE,
  SettingsTonomoWebhooks: ADMIN_AND_ABOVE,
  SettingsAI: ADMIN_AND_ABOVE,
  BusinessRequirementsDocument: ADMIN_AND_ABOVE,
  HierarchyVisualization: ADMIN_AND_ABOVE,

  // SettingsStaffDefaults removed — now a subtab in SettingsTeamsUsers

  // ── TEAMS (admin+) ───────────────────────────────────────
  Teams: ADMIN_AND_ABOVE,
  SettingsTeamsUsers: ADMIN_AND_ABOVE,

  // ── OWNER ONLY (master_admin) ─────────────────────────────
  Users: OWNER_ONLY,
  NotificationsPulse: OWNER_ONLY,
  AdminTodoList: OWNER_ONLY,
  AIAuditLog: OWNER_ONLY,
  // Wave 15b.9 — missed-opportunity quoting engine command center.
  // master_admin only because it exposes manual override of customer-facing
  // quotes + a queue-pause control that affects production cost.
  PulseMissedOpportunityCommandCenter: OWNER_ONLY,
  // Wave 11.6 — rejection reasons dashboard. master_admin only because it
  // surfaces raw human override observations (W11.5 capture) + Gemini cost
  // attribution + canonical registry coverage.
  SettingsRejectionReasonsDashboard: OWNER_ONLY,
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