import { describe, it, expect } from 'vitest';
import { canAccessRoute, ROUTE_ACCESS } from '@/components/lib/routeAccess';

describe('SettingsEngineOverridePatterns — route access (post W11.6.21 hard-cut)', () => {
  it('is NO LONGER registered in ROUTE_ACCESS (consolidated into umbrella)', () => {
    expect(ROUTE_ACCESS).not.toHaveProperty('SettingsEngineOverridePatterns');
  });
  it('unlisted route now defaults to master_admin only (admin loses access)', () => {
    expect(canAccessRoute('SettingsEngineOverridePatterns', 'master_admin')).toBe(true);
    // Admin previously had access via ADMIN_AND_ABOVE; under the hard-cut
    // they reach the page through the umbrella ?tab=overrides instead.
    expect(canAccessRoute('SettingsEngineOverridePatterns', 'admin')).toBe(false);
    expect(canAccessRoute('SettingsEngineOverridePatterns', 'manager')).toBe(false);
    expect(canAccessRoute('SettingsEngineOverridePatterns', 'employee')).toBe(false);
    expect(canAccessRoute('SettingsEngineOverridePatterns', 'contractor')).toBe(false);
  });
});

function fmtUsd(n){if(n==null||!Number.isFinite(Number(n)))return '$0.00';const v=Number(n);if(v<0.01)return `$${v.toFixed(4)}`;if(v<1)return `$${v.toFixed(3)}`;return `$${v.toFixed(2)}`;}
function fmtPct(n){if(n==null||!Number.isFinite(Number(n)))return '—';return `${(Number(n)*100).toFixed(1)}%`;}
function fmtSec(n){if(n==null||!Number.isFinite(Number(n)))return '—';const v=Number(n);if(v<60)return `${v.toFixed(1)}s`;return `${(v/60).toFixed(1)}m`;}
function heatColor(rate){if(rate==null)return 'bg-slate-50 text-slate-400';if(rate>=0.15)return 'bg-red-100 text-red-900 dark:bg-red-950/40 dark:text-red-200';if(rate>=0.05)return 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200';return 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200';}

describe('fmtUsd', () => {
  it('formats > $1', () => { expect(fmtUsd(3.5)).toBe('$3.50'); });
  it('formats sub-dollar', () => { expect(fmtUsd(0.5)).toBe('$0.500'); });
  it('handles null', () => { expect(fmtUsd(null)).toBe('$0.00'); });
});
describe('fmtPct', () => {
  it('multiplies by 100', () => { expect(fmtPct(0.237)).toBe('23.7%'); });
});
describe('fmtSec', () => {
  it('seconds for <60', () => { expect(fmtSec(15)).toBe('15.0s'); });
  it('minutes for >=60', () => { expect(fmtSec(60)).toBe('1.0m'); });
});
describe('heatColor', () => {
  it('null', () => { expect(heatColor(null)).toContain('text-slate-400'); });
  it('<5% green', () => { expect(heatColor(0.04)).toContain('emerald'); });
  it('5-15% amber', () => { expect(heatColor(0.1)).toContain('amber'); });
  it('>=15% red', () => { expect(heatColor(0.15)).toContain('red'); });
});
