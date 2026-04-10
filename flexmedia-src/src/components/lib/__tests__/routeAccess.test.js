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
    expect(canAccessRoute('Settings', 'master_admin')).toBe(true);
  });

  it('master_admin can access ADMIN_ONLY routes', () => {
    expect(canAccessRoute('Users', 'master_admin')).toBe(true);
    expect(canAccessRoute('SettingsTeamsUsers', 'master_admin')).toBe(true);
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
    expect(canAccessRoute('Settings', 'employee')).toBe(true);
  });

  it('employee is blocked from ADMIN_ONLY routes', () => {
    expect(canAccessRoute('Users', 'employee')).toBe(false);
    expect(canAccessRoute('SettingsTeamsUsers', 'employee')).toBe(false);
    expect(canAccessRoute('AdminTodoList', 'employee')).toBe(false);
    expect(canAccessRoute('NotificationsPulse', 'employee')).toBe(false);
  });

  it('employee is blocked from unlisted routes (defaults to admin-only)', () => {
    expect(canAccessRoute('SomeUnknownRoute', 'employee')).toBe(false);
  });

  // ── unknown roles are blocked ─────────────────────────────────────────────
  it('unknown role is blocked from all routes', () => {
    expect(canAccessRoute('Dashboard', 'contractor')).toBe(false);
    expect(canAccessRoute('Settings', 'contractor')).toBe(false);
    expect(canAccessRoute('Users', 'contractor')).toBe(false);
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
    expect(getAccessLevel('Settings', 'employee')).toBe('full');
    expect(getAccessLevel('Reports', 'employee')).toBe('full');
  });

  it('returns "none" for blocked routes', () => {
    expect(getAccessLevel('Users', 'employee')).toBe('none');
  });

  it('returns "none" for unlisted routes (non-admin)', () => {
    expect(getAccessLevel('UnknownPage', 'employee')).toBe('none');
  });

  it('returns "none" for unknown role on any route', () => {
    expect(getAccessLevel('Dashboard', 'contractor')).toBe('none');
    expect(getAccessLevel('Users', 'contractor')).toBe('none');
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

  it('unknown role gets no routes', () => {
    const unknownRoutes = getAccessibleRoutes('contractor');
    expect(unknownRoutes.length).toBe(0);
  });

  it('employee has fewer routes than master_admin', () => {
    const empRoutes = getAccessibleRoutes('employee');
    const adminRoutes = getAccessibleRoutes('master_admin');
    expect(empRoutes.length).toBeLessThan(adminRoutes.length);
  });
});
