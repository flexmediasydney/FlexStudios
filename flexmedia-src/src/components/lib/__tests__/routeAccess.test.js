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
  it('master_admin can access ALL_LEVELS routes', () => {
    expect(canAccessRoute('Dashboard', 'master_admin')).toBe(true);
    expect(canAccessRoute('Calendar', 'master_admin')).toBe(true);
    expect(canAccessRoute('Projects', 'master_admin')).toBe(true);
  });

  it('master_admin can access MANAGER_AND_ABOVE routes', () => {
    expect(canAccessRoute('ClientAgents', 'master_admin')).toBe(true);
    expect(canAccessRoute('Reports', 'master_admin')).toBe(true);
    expect(canAccessRoute('Products', 'master_admin')).toBe(true);
  });

  it('master_admin can access ADMIN_AND_ABOVE routes', () => {
    expect(canAccessRoute('Settings', 'master_admin')).toBe(true);
    expect(canAccessRoute('SettingsTeamsUsers', 'master_admin')).toBe(true);
    expect(canAccessRoute('Teams', 'master_admin')).toBe(true);
  });

  it('master_admin can access OWNER_ONLY routes', () => {
    expect(canAccessRoute('Users', 'master_admin')).toBe(true);
    expect(canAccessRoute('AdminTodoList', 'master_admin')).toBe(true);
    expect(canAccessRoute('NotificationsPulse', 'master_admin')).toBe(true);
    expect(canAccessRoute('AIAuditLog', 'master_admin')).toBe(true);
  });

  it('master_admin can access unlisted routes (default owner-only)', () => {
    expect(canAccessRoute('SomeUnknownRoute', 'master_admin')).toBe(true);
  });

  // ── admin access ────────────────────────────────────────────────────────
  it('admin can access ALL_LEVELS routes', () => {
    expect(canAccessRoute('Dashboard', 'admin')).toBe(true);
    expect(canAccessRoute('Calendar', 'admin')).toBe(true);
    expect(canAccessRoute('FieldMode', 'admin')).toBe(true);
  });

  it('admin can access ADMIN_AND_ABOVE routes', () => {
    expect(canAccessRoute('Settings', 'admin')).toBe(true);
    expect(canAccessRoute('SettingsTeamsUsers', 'admin')).toBe(true);
    expect(canAccessRoute('Teams', 'admin')).toBe(true);
  });

  it('admin is blocked from OWNER_ONLY routes', () => {
    expect(canAccessRoute('Users', 'admin')).toBe(false);
    expect(canAccessRoute('AdminTodoList', 'admin')).toBe(false);
    expect(canAccessRoute('NotificationsPulse', 'admin')).toBe(false);
    expect(canAccessRoute('AIAuditLog', 'admin')).toBe(false);
  });

  // ── manager access ──────────────────────────────────────────────────────
  it('manager can access ALL_LEVELS routes', () => {
    expect(canAccessRoute('Dashboard', 'manager')).toBe(true);
    expect(canAccessRoute('Projects', 'manager')).toBe(true);
  });

  it('manager can access MANAGER_AND_ABOVE routes', () => {
    expect(canAccessRoute('ClientAgents', 'manager')).toBe(true);
    expect(canAccessRoute('Reports', 'manager')).toBe(true);
    expect(canAccessRoute('Products', 'manager')).toBe(true);
    expect(canAccessRoute('TonomoPulse', 'manager')).toBe(true);
  });

  it('manager is blocked from ADMIN_AND_ABOVE routes', () => {
    expect(canAccessRoute('Settings', 'manager')).toBe(false);
    expect(canAccessRoute('SettingsTeamsUsers', 'manager')).toBe(false);
    expect(canAccessRoute('Teams', 'manager')).toBe(false);
  });

  it('manager is blocked from OWNER_ONLY routes', () => {
    expect(canAccessRoute('Users', 'manager')).toBe(false);
    expect(canAccessRoute('AdminTodoList', 'manager')).toBe(false);
  });

  // ── employee access ──────────────────────────────────────────────────────
  it('employee can access ALL_LEVELS routes', () => {
    expect(canAccessRoute('Dashboard', 'employee')).toBe(true);
    expect(canAccessRoute('Calendar', 'employee')).toBe(true);
    expect(canAccessRoute('Projects', 'employee')).toBe(true);
    expect(canAccessRoute('Inbox', 'employee')).toBe(true);
  });

  it('employee can access EMPLOYEE_AND_ABOVE routes', () => {
    expect(canAccessRoute('People', 'employee')).toBe(true);
    expect(canAccessRoute('PersonDetails', 'employee')).toBe(true);
    expect(canAccessRoute('OrgDetails', 'employee')).toBe(true);
    expect(canAccessRoute('TeamDetails', 'employee')).toBe(true);
  });

  it('employee is blocked from MANAGER_AND_ABOVE routes', () => {
    expect(canAccessRoute('ClientAgents', 'employee')).toBe(false);
    expect(canAccessRoute('Organisations', 'employee')).toBe(false);
    expect(canAccessRoute('Reports', 'employee')).toBe(false);
    expect(canAccessRoute('Products', 'employee')).toBe(false);
  });

  it('employee is blocked from ADMIN_AND_ABOVE routes', () => {
    expect(canAccessRoute('Settings', 'employee')).toBe(false);
    expect(canAccessRoute('SettingsTeamsUsers', 'employee')).toBe(false);
  });

  it('employee is blocked from OWNER_ONLY routes', () => {
    expect(canAccessRoute('Users', 'employee')).toBe(false);
    expect(canAccessRoute('AdminTodoList', 'employee')).toBe(false);
    expect(canAccessRoute('NotificationsPulse', 'employee')).toBe(false);
  });

  it('employee is blocked from unlisted routes (defaults to owner-only)', () => {
    expect(canAccessRoute('SomeUnknownRoute', 'employee')).toBe(false);
  });

  // ── contractor access ─────────────────────────────────────────────────
  it('contractor can access ALL_LEVELS routes', () => {
    expect(canAccessRoute('Dashboard', 'contractor')).toBe(true);
    expect(canAccessRoute('Calendar', 'contractor')).toBe(true);
    expect(canAccessRoute('Projects', 'contractor')).toBe(true);
    expect(canAccessRoute('FieldMode', 'contractor')).toBe(true);
    expect(canAccessRoute('SocialMedia', 'contractor')).toBe(true);
  });

  it('contractor is blocked from EMPLOYEE_AND_ABOVE routes', () => {
    expect(canAccessRoute('People', 'contractor')).toBe(false);
    expect(canAccessRoute('PersonDetails', 'contractor')).toBe(false);
  });

  it('contractor is blocked from MANAGER_AND_ABOVE routes', () => {
    expect(canAccessRoute('ClientAgents', 'contractor')).toBe(false);
    expect(canAccessRoute('Reports', 'contractor')).toBe(false);
  });

  it('contractor is blocked from ADMIN_AND_ABOVE routes', () => {
    expect(canAccessRoute('Settings', 'contractor')).toBe(false);
    expect(canAccessRoute('SettingsTeamsUsers', 'contractor')).toBe(false);
  });

  it('contractor is blocked from OWNER_ONLY routes', () => {
    expect(canAccessRoute('Users', 'contractor')).toBe(false);
    expect(canAccessRoute('AdminTodoList', 'contractor')).toBe(false);
  });

  it('contractor is blocked from unlisted routes', () => {
    expect(canAccessRoute('SomeUnknownRoute', 'contractor')).toBe(false);
  });
});

// ─── getAccessLevel ──────────────────────────────────────────────────────────

describe('getAccessLevel', () => {
  it('returns "full" for master_admin on any listed route', () => {
    expect(getAccessLevel('Dashboard', 'master_admin')).toBe('full');
    expect(getAccessLevel('Users', 'master_admin')).toBe('full');
  });

  it('returns "full" for admin on ADMIN_AND_ABOVE routes', () => {
    expect(getAccessLevel('Settings', 'admin')).toBe('full');
    expect(getAccessLevel('Teams', 'admin')).toBe('full');
  });

  it('returns "full" for manager on MANAGER_AND_ABOVE routes', () => {
    expect(getAccessLevel('Reports', 'manager')).toBe('full');
    expect(getAccessLevel('Products', 'manager')).toBe('full');
  });

  it('returns "full" for employee on EMPLOYEE_AND_ABOVE routes', () => {
    expect(getAccessLevel('People', 'employee')).toBe('full');
    expect(getAccessLevel('Dashboard', 'employee')).toBe('full');
  });

  it('returns "full" for contractor on ALL_LEVELS routes', () => {
    expect(getAccessLevel('Dashboard', 'contractor')).toBe('full');
    expect(getAccessLevel('Projects', 'contractor')).toBe('full');
  });

  it('returns "none" for blocked routes', () => {
    expect(getAccessLevel('Users', 'employee')).toBe('none');
    expect(getAccessLevel('Settings', 'manager')).toBe('none');
    expect(getAccessLevel('Users', 'admin')).toBe('none');
    expect(getAccessLevel('Reports', 'contractor')).toBe('none');
  });

  it('returns "none" for unlisted routes (non-owner)', () => {
    expect(getAccessLevel('UnknownPage', 'employee')).toBe('none');
    expect(getAccessLevel('UnknownPage', 'contractor')).toBe('none');
  });
});

// ─── getAccessibleRoutes ─────────────────────────────────────────────────────

describe('getAccessibleRoutes', () => {
  const totalRoutes = Object.keys(ROUTE_ACCESS).length;

  it('master_admin gets all 53 routes', () => {
    const routes = getAccessibleRoutes('master_admin');
    expect(routes.length).toBe(53);
    expect(routes.length).toBe(totalRoutes);
  });

  it('admin gets 49 routes', () => {
    const routes = getAccessibleRoutes('admin');
    expect(routes.length).toBe(49);
    expect(routes).toContain('Settings');
    expect(routes).toContain('Teams');
    expect(routes).not.toContain('Users');
    expect(routes).not.toContain('AdminTodoList');
    expect(routes).not.toContain('AIAuditLog');
  });

  it('manager gets 32 routes', () => {
    const routes = getAccessibleRoutes('manager');
    expect(routes.length).toBe(32);
    expect(routes).toContain('Reports');
    expect(routes).toContain('Products');
    expect(routes).not.toContain('Settings');
    expect(routes).not.toContain('SettingsTeamsUsers');
    expect(routes).not.toContain('Users');
  });

  it('employee gets 19 routes', () => {
    const routes = getAccessibleRoutes('employee');
    expect(routes.length).toBe(19);
    expect(routes).toContain('Dashboard');
    expect(routes).toContain('People');
    expect(routes).not.toContain('ClientAgents');
    expect(routes).not.toContain('Settings');
    expect(routes).not.toContain('Users');
  });

  it('contractor gets 15 routes', () => {
    const routes = getAccessibleRoutes('contractor');
    expect(routes.length).toBe(15);
    expect(routes).toContain('Dashboard');
    expect(routes).toContain('Projects');
    expect(routes).toContain('FieldMode');
    expect(routes).not.toContain('People');
    expect(routes).not.toContain('ClientAgents');
    expect(routes).not.toContain('Settings');
  });

  it('each tier has strictly fewer routes than the one above', () => {
    const counts = {
      contractor: getAccessibleRoutes('contractor').length,
      employee: getAccessibleRoutes('employee').length,
      manager: getAccessibleRoutes('manager').length,
      admin: getAccessibleRoutes('admin').length,
      master_admin: getAccessibleRoutes('master_admin').length,
    };
    expect(counts.contractor).toBeLessThan(counts.employee);
    expect(counts.employee).toBeLessThan(counts.manager);
    expect(counts.manager).toBeLessThan(counts.admin);
    expect(counts.admin).toBeLessThan(counts.master_admin);
  });
});
