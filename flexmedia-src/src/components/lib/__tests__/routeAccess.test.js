import { describe, it, expect } from 'vitest';
import { canAccessRoute, getAccessLevel, getAccessibleRoutes, ROUTE_ACCESS } from '../routeAccess';

// ─── canAccessRoute ──────────────────────────────────────────────────────────

describe('canAccessRoute', () => {
  // ── Null / edge cases ─────────────────────────────────────────────────────
  it('returns false for null routeName', () => {
    expect(canAccessRoute(null, 'master_admin')).toBe(false);
  });

  it('returns false for null userRole', () => {
    expect(canAccessRoute('Dashboard', null)).toBe(false);
  });

  it('returns false for empty strings', () => {
    expect(canAccessRoute('', 'master_admin')).toBe(false);
    expect(canAccessRoute('Dashboard', '')).toBe(false);
  });

  // ── master_admin can access everything ────────────────────────────────────
  it('master_admin can access ALL_ROLES routes', () => {
    expect(canAccessRoute('Dashboard', 'master_admin')).toBe(true);
    expect(canAccessRoute('Calendar', 'master_admin')).toBe(true);
    expect(canAccessRoute('Projects', 'master_admin')).toBe(true);
  });

  it('master_admin can access ADMIN_EMPLOYEE routes', () => {
    expect(canAccessRoute('ClientAgents', 'master_admin')).toBe(true);
    expect(canAccessRoute('Analytics', 'master_admin')).toBe(true);
    expect(canAccessRoute('Settings', 'master_admin')).toBe(true);
  });

  it('master_admin can access ADMIN_ONLY routes', () => {
    expect(canAccessRoute('Users', 'master_admin')).toBe(true);
    expect(canAccessRoute('SettingsTeamsUsers', 'master_admin')).toBe(true);
    expect(canAccessRoute('BusinessIntelligence', 'master_admin')).toBe(true);
    expect(canAccessRoute('AdminTodoList', 'master_admin')).toBe(true);
  });

  it('master_admin can access unlisted routes (default admin-only)', () => {
    expect(canAccessRoute('SomeUnknownRoute', 'master_admin')).toBe(true);
  });

  // ── employee access ──────────────────────────────────────────────────────
  it('employee can access ALL_ROLES routes', () => {
    expect(canAccessRoute('Dashboard', 'employee')).toBe(true);
    expect(canAccessRoute('Calendar', 'employee')).toBe(true);
    expect(canAccessRoute('Projects', 'employee')).toBe(true);
    expect(canAccessRoute('Inbox', 'employee')).toBe(true);
  });

  it('employee can access ADMIN_EMPLOYEE routes', () => {
    expect(canAccessRoute('ClientAgents', 'employee')).toBe(true);
    expect(canAccessRoute('Organisations', 'employee')).toBe(true);
    expect(canAccessRoute('Analytics', 'employee')).toBe(true);
    expect(canAccessRoute('Settings', 'employee')).toBe(true);
  });

  it('employee is blocked from ADMIN_ONLY routes', () => {
    expect(canAccessRoute('Users', 'employee')).toBe(false);
    expect(canAccessRoute('SettingsTeamsUsers', 'employee')).toBe(false);
    expect(canAccessRoute('BusinessIntelligence', 'employee')).toBe(false);
    expect(canAccessRoute('EmployeeUtilization', 'employee')).toBe(false);
    expect(canAccessRoute('AdminTodoList', 'employee')).toBe(false);
    expect(canAccessRoute('NotificationsPulse', 'employee')).toBe(false);
    expect(canAccessRoute('TeamPulsePage', 'employee')).toBe(false);
    expect(canAccessRoute('SettingsSystemHealth', 'employee')).toBe(false);
  });

  it('employee is blocked from unlisted routes (defaults to admin-only)', () => {
    expect(canAccessRoute('SomeUnknownRoute', 'employee')).toBe(false);
  });

  // ── contractor access ─────────────────────────────────────────────────────
  it('contractor can access ALL_ROLES routes', () => {
    expect(canAccessRoute('Dashboard', 'contractor')).toBe(true);
    expect(canAccessRoute('Calendar', 'contractor')).toBe(true);
    expect(canAccessRoute('Projects', 'contractor')).toBe(true);
    expect(canAccessRoute('ProjectDetails', 'contractor')).toBe(true);
    expect(canAccessRoute('Inbox', 'contractor')).toBe(true);
    expect(canAccessRoute('NotificationsPage', 'contractor')).toBe(true);
    expect(canAccessRoute('UserSettings', 'contractor')).toBe(true);
  });

  it('contractor is blocked from CRM routes', () => {
    expect(canAccessRoute('ClientAgents', 'contractor')).toBe(false);
    expect(canAccessRoute('Organisations', 'contractor')).toBe(false);
    expect(canAccessRoute('People', 'contractor')).toBe(false);
    expect(canAccessRoute('Teams', 'contractor')).toBe(false);
    expect(canAccessRoute('Prospecting', 'contractor')).toBe(false);
    expect(canAccessRoute('ClientMonitor', 'contractor')).toBe(false);
  });

  it('contractor is blocked from settings routes', () => {
    expect(canAccessRoute('Settings', 'contractor')).toBe(false);
    expect(canAccessRoute('SettingsOrganisation', 'contractor')).toBe(false);
    expect(canAccessRoute('SettingsIntegrations', 'contractor')).toBe(false);
  });

  it('contractor is blocked from admin-only routes', () => {
    expect(canAccessRoute('Users', 'contractor')).toBe(false);
    expect(canAccessRoute('SettingsTeamsUsers', 'contractor')).toBe(false);
    expect(canAccessRoute('AdminTodoList', 'contractor')).toBe(false);
  });

  it('contractor is blocked from analytics routes', () => {
    expect(canAccessRoute('Analytics', 'contractor')).toBe(false);
    expect(canAccessRoute('Reports', 'contractor')).toBe(false);
    expect(canAccessRoute('BusinessIntelligence', 'contractor')).toBe(false);
  });

  it('contractor can access public/gallery routes', () => {
    expect(canAccessRoute('ClientGallery', 'contractor')).toBe(true);
    expect(canAccessRoute('MarketingWithFlex', 'contractor')).toBe(true);
    expect(canAccessRoute('BountyBoard', 'contractor')).toBe(true);
    expect(canAccessRoute('InternalRoadmap', 'contractor')).toBe(true);
  });

  it('contractor is blocked from unlisted routes', () => {
    expect(canAccessRoute('SomeUnknownRoute', 'contractor')).toBe(false);
  });
});

// ─── getAccessLevel ──────────────────────────────────────────────────────────

describe('getAccessLevel', () => {
  it('returns "full" for admin on any listed route', () => {
    expect(getAccessLevel('Dashboard', 'master_admin')).toBe('full');
    expect(getAccessLevel('Users', 'master_admin')).toBe('full');
  });

  it('returns "full" for employee on ADMIN_EMPLOYEE routes', () => {
    expect(getAccessLevel('Analytics', 'employee')).toBe('full');
    expect(getAccessLevel('Settings', 'employee')).toBe('full');
  });

  it('returns "filtered" for contractor on filtered pages', () => {
    expect(getAccessLevel('Dashboard', 'contractor')).toBe('filtered');
    expect(getAccessLevel('Projects', 'contractor')).toBe('filtered');
    expect(getAccessLevel('ProjectDetails', 'contractor')).toBe('filtered');
    expect(getAccessLevel('Calendar', 'contractor')).toBe('filtered');
    expect(getAccessLevel('Inbox', 'contractor')).toBe('filtered');
    expect(getAccessLevel('NotificationsPage', 'contractor')).toBe('filtered');
  });

  it('returns "full" for contractor on non-filtered ALL_ROLES pages', () => {
    expect(getAccessLevel('UserSettings', 'contractor')).toBe('full');
    expect(getAccessLevel('ClientGallery', 'contractor')).toBe('full');
    expect(getAccessLevel('BountyBoard', 'contractor')).toBe('full');
  });

  it('returns "none" for blocked routes', () => {
    expect(getAccessLevel('Users', 'contractor')).toBe('none');
    expect(getAccessLevel('Users', 'employee')).toBe('none');
    expect(getAccessLevel('Settings', 'contractor')).toBe('none');
  });

  it('returns "none" for unlisted routes (non-admin)', () => {
    expect(getAccessLevel('UnknownPage', 'employee')).toBe('none');
    expect(getAccessLevel('UnknownPage', 'contractor')).toBe('none');
  });
});

// ─── getAccessibleRoutes ─────────────────────────────────────────────────────

describe('getAccessibleRoutes', () => {
  it('returns all listed routes for master_admin', () => {
    const adminRoutes = getAccessibleRoutes('master_admin');
    const allRouteNames = Object.keys(ROUTE_ACCESS);
    expect(adminRoutes).toEqual(expect.arrayContaining(allRouteNames));
    expect(adminRoutes.length).toBe(allRouteNames.length);
  });

  it('returns a subset for employee (no ADMIN_ONLY routes)', () => {
    const empRoutes = getAccessibleRoutes('employee');
    expect(empRoutes).toContain('Dashboard');
    expect(empRoutes).toContain('Settings');
    expect(empRoutes).not.toContain('Users');
    expect(empRoutes).not.toContain('SettingsTeamsUsers');
    expect(empRoutes).not.toContain('AdminTodoList');
  });

  it('returns a smaller subset for contractor (only ALL_ROLES routes)', () => {
    const contractorRoutes = getAccessibleRoutes('contractor');
    expect(contractorRoutes).toContain('Dashboard');
    expect(contractorRoutes).toContain('Projects');
    expect(contractorRoutes).toContain('ClientGallery');
    expect(contractorRoutes).not.toContain('Settings');
    expect(contractorRoutes).not.toContain('Users');
    expect(contractorRoutes).not.toContain('Analytics');
  });

  it('contractor has fewer routes than employee', () => {
    const contractorRoutes = getAccessibleRoutes('contractor');
    const empRoutes = getAccessibleRoutes('employee');
    expect(contractorRoutes.length).toBeLessThan(empRoutes.length);
  });

  it('employee has fewer routes than master_admin', () => {
    const empRoutes = getAccessibleRoutes('employee');
    const adminRoutes = getAccessibleRoutes('master_admin');
    expect(empRoutes.length).toBeLessThan(adminRoutes.length);
  });
});
