/**
 * Permission utility functions
 */

export const RISK_LEVELS = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical"
};

export const PERMISSION_ACTIONS = {
  VIEW: "view",
  CREATE: "create",
  EDIT: "edit",
  DELETE: "delete",
  EXPORT: "export",
  IMPORT: "import",
  APPROVE: "approve",
  CONFIGURE: "configure",
  MANAGE: "manage"
};

export const RESOURCES = {
  PROJECTS: "projects",
  PRODUCTS: "products",
  PACKAGES: "packages",
  PRICING: "pricing",
  CLIENTS: "clients",
  AGENTS: "agents",
  TEAMS: "teams",
  USERS: "users",
  SETTINGS: "settings",
  REPORTS: "reports",
  INTEGRATIONS: "integrations",
  CALENDAR: "calendar",
  EMAIL: "email",
  ANALYTICS: "analytics",
  AUDIT_LOGS: "audit_logs"
};

export const DATA_SCOPES = {
  OWN: "own",
  TEAM: "team",
  ALL: "all"
};

/**
 * Check if permission is expired
 */
export function isPermissionExpired(permission) {
  if (!permission.expires_at) return false;
  return new Date(permission.expires_at) <= new Date();
}

/**
 * Check if permission is expiring soon (within 7 days)
 */
export function isPermissionExpiringSoon(permission) {
  if (!permission.expires_at) return false;
  const expiresAt = new Date(permission.expires_at);
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return expiresAt <= sevenDaysFromNow && expiresAt > new Date();
}

/**
 * Format permission name for display
 */
export function formatPermissionName(name) {
  return name
    .split(".")
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Format date for display
 */
export function formatExpiryDate(dateStr) {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

/**
 * Get days remaining until expiry
 */
export function getDaysRemaining(expiresAt) {
  if (!expiresAt) return Infinity;
  const now = new Date();
  const expires = new Date(expiresAt);
  const days = Math.ceil((expires - now) / (1000 * 60 * 60 * 24));
  return Math.max(0, days);
}

/**
 * Validate permission name format
 */
export function isValidPermissionName(name) {
  return /^[a-z_]+\.[a-z_]+$/.test(name);
}

/**
 * Get risk level color
 */
export function getRiskColor(level) {
  const colors = {
    [RISK_LEVELS.LOW]: "bg-blue-50 text-blue-700 border-blue-200",
    [RISK_LEVELS.MEDIUM]: "bg-yellow-50 text-yellow-700 border-yellow-200",
    [RISK_LEVELS.HIGH]: "bg-orange-50 text-orange-700 border-orange-200",
    [RISK_LEVELS.CRITICAL]: "bg-red-50 text-red-700 border-red-200"
  };
  return colors[level] || colors[RISK_LEVELS.LOW];
}

/**
 * Validate expiry days
 */
export function validateExpiryDays(days) {
  const numDays = Number(days);
  if (isNaN(numDays) || numDays < 1) return false;
  if (numDays > 365) return false;
  return true;
}

/**
 * Calculate expiry timestamp
 */
export function calculateExpiryTimestamp(days) {
  if (!validateExpiryDays(days)) return null;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}