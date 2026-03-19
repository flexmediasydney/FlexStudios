/**
 * StatDrillThrough.jsx
 * 
 * Universal drill-through system for aggregated dashboard statistics.
 * Provides consistent hover popups that show transactional breakdowns with drillable links.
 * 
 * Usage:
 *   <StatDrillThrough value="1,234" label="Total Revenue" type="revenue" data={projects} />
 *   <StatDrillThrough value="42" label="Active Projects" type="projects" data={projects} />
 */

import React, { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { ChevronRight, DollarSign, Zap, AlertCircle, Users, TrendingUp, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fixTimestamp } from '@/components/utils/dateUtils';

/**
 * StatDrillThrough - Wrapper component
 * Adds hover drill-through capability to any stat display
 */
export function StatDrillThrough({ 
  value, 
  label, 
  type, 
  data = [], 
  config = {},
  className = ''
}) {
  const [showPopup, setShowPopup] = useState(false);
  const drillData = useDrillData(type, data, config);

  if (!drillData || drillData.records.length === 0) {
    return (
      <div className={className} title={`${label}: ${value}`}>
        <span>{value}</span>
      </div>
    );
  }

  return (
    <div 
      className={cn('relative cursor-help', className)}
      onMouseEnter={() => setShowPopup(true)}
      onMouseLeave={() => setShowPopup(false)}
      title={`Click to drill into ${label}`}
    >
      <span className="inline-block opacity-90 hover:opacity-100 transition-opacity">
        {value}
      </span>
      {showPopup && (
        <StatDrillPopup 
          label={label} 
          type={type}
          drillData={drillData} 
        />
      )}
    </div>
  );
}

/**
 * StatDrillPopup - Popup component showing transactional breakdown
 */
function StatDrillPopup({ label, type, drillData }) {
  return (
    <div className="fixed z-50 pointer-events-none">
      <div 
        className="absolute top-full mt-2 right-0 pointer-events-auto"
        style={{ transform: 'translateX(50%)' }}
      >
        <Card className="w-96 shadow-2xl border-primary/30">
          <div className="px-4 py-3 border-b bg-gradient-to-r from-primary/5 to-transparent flex items-center justify-between">
            <div className="flex items-center gap-2">
              {drillData.icon && <drillData.icon className="h-4 w-4 text-primary" />}
              <span className="text-sm font-bold">{label}</span>
            </div>
            <Badge variant="secondary" className="text-xs">
              {drillData.records.length} records
            </Badge>
          </div>

          <div className="max-h-80 overflow-y-auto divide-y">
            {drillData.records.slice(0, 10).map((record, idx) => (
              <StatDrillRow 
                key={idx} 
                record={record} 
                type={type}
              />
            ))}
            {drillData.records.length > 10 && (
              <div className="px-3 py-2 text-xs text-muted-foreground text-center bg-muted/30 font-medium">
                +{drillData.records.length - 10} more
              </div>
            )}
          </div>

          {drillData.cta && (
            <Link 
              to={drillData.cta.url}
              className="block px-4 py-2 border-t text-xs font-medium text-primary hover:bg-muted/50 transition-colors flex items-center justify-between group"
            >
              <span>{drillData.cta.label}</span>
              <ChevronRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
            </Link>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * StatDrillRow - Individual transaction row
 */
function StatDrillRow({ record, type }) {
  const isClickable = record.url && record.url !== '#';

  const rowContent = (
    <div className="flex items-center gap-3 px-3 py-2.5 text-xs">
      {record.icon && <record.icon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{record.title}</div>
        {record.subtitle && <div className="text-[11px] text-muted-foreground truncate">{record.subtitle}</div>}
      </div>
      {record.value && (
        <span className={cn('font-semibold whitespace-nowrap', record.valueColor)}>
          {record.value}
        </span>
      )}
    </div>
  );

  if (isClickable) {
    return (
      <Link to={record.url} className="block hover:bg-muted/40 transition-colors">
        {rowContent}
      </Link>
    );
  }

  return <div className="hover:bg-muted/30 transition-colors">{rowContent}</div>;
}

/**
 * useDrillData - Hook that transforms aggregated data into drillable records
 * 
 * Types supported:
 * - revenue: Total/filtered revenue
 * - projects: Active/status projects
 * - tasks: Completed/pending tasks
 * - agencies: Top agencies by revenue
 * - agents: Top agents by revenue
 * - utilization: Team utilization
 * - overdue: Overdue items
 * - stage: Projects by stage
 * - effort: Effort logged
 * - risk: Revenue at risk
 */
function useDrillData(type, data = [], config = {}) {
  return useMemo(() => {
    if (!data || data.length === 0) return null;

    const pv = (p) => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;
    const now = new Date();

    const drills = {
      revenue: () => {
        const filtered = config.filter ? data.filter(config.filter) : data;
        return {
          icon: DollarSign,
          records: filtered
            .sort((a, b) => pv(b) - pv(a))
            .map(p => ({
              title: p.title || p.property_address || 'Untitled',
              subtitle: p.agency_name || p.client_name || '—',
              value: `$${Math.round(pv(p)).toLocaleString()}`,
              valueColor: 'text-emerald-600',
              url: createPageUrl('ProjectDetails') + `?id=${p.id}`,
              icon: DollarSign,
            })),
          cta: { label: 'View all projects', url: createPageUrl('Projects') },
        };
      },

      projects: () => {
        const filtered = config.filter ? data.filter(config.filter) : data;
        return {
          icon: Zap,
          records: filtered
            .sort((a, b) => (b.created_date || '').localeCompare(a.created_date || ''))
            .map(p => ({
              title: p.title || p.property_address || 'Untitled',
              subtitle: `${p.status} · ${p.agency_name || 'N/A'}`,
              value: `$${Math.round(pv(p) / 1000)}k`,
              valueColor: 'text-blue-600',
              url: createPageUrl('ProjectDetails') + `?id=${p.id}`,
              icon: Zap,
            })),
          cta: { label: 'View all projects', url: createPageUrl('Projects') },
        };
      },

      tasks: () => {
        const filtered = config.filter ? data.filter(config.filter) : data;
        return {
          icon: Clock,
          records: filtered
            .sort((a, b) => (b.due_date || '').localeCompare(a.due_date || ''))
            .map(t => ({
              title: t.title,
              subtitle: `${t.project_id ? 'Project ' + t.project_id.slice(0, 8) : 'Unlinked'} · ${t.assigned_to_name || 'Unassigned'}`,
              value: t.is_completed ? '✓' : '○',
              valueColor: t.is_completed ? 'text-green-600' : 'text-muted-foreground',
              url: '#', // Can be enhanced with task detail modal
            })),
          cta: { label: 'View all tasks', url: createPageUrl('Projects') },
        };
      },

      agencies: () => {
        const stats = {};
        data.forEach(p => {
          if (!p.agency_id) return;
          if (!stats[p.agency_id]) stats[p.agency_id] = { id: p.agency_id, name: p.agency_name, revenue: 0, count: 0 };
          stats[p.agency_id].revenue += pv(p);
          stats[p.agency_id].count++;
        });
        return {
          icon: Users,
          records: Object.values(stats)
            .sort((a, b) => b.revenue - a.revenue)
            .map(a => ({
              title: a.name || 'Unknown',
              subtitle: `${a.count} project${a.count !== 1 ? 's' : ''}`,
              value: `$${Math.round(a.revenue / 1000)}k`,
              valueColor: 'text-emerald-600',
              url: createPageUrl('OrgDetails') + `?id=${a.id}`,
              icon: Users,
            })),
          cta: { label: 'Manage agencies', url: createPageUrl('Organisations') },
        };
      },

      overdue: () => {
        const filtered = data.filter(t => !t.is_completed && t.due_date && new Date(fixTimestamp(t.due_date)) < now);
        return {
          icon: AlertCircle,
          records: filtered
            .sort((a, b) => new Date(fixTimestamp(a.due_date)) - new Date(fixTimestamp(b.due_date)))
            .map(t => ({
              title: t.title,
              subtitle: `Due ${new Date(fixTimestamp(t.due_date)).toLocaleDateString()} · ${t.assigned_to_name || 'Unassigned'}`,
              value: '⚠',
              valueColor: 'text-red-600',
              url: '#',
            })),
          cta: { label: 'View all overdue', url: createPageUrl('Projects') },
        };
      },

      stage: () => {
        const stage = config.stage;
        const filtered = data.filter(p => p.status === stage);
        return {
          icon: TrendingUp,
          records: filtered
            .sort((a, b) => pv(b) - pv(a))
            .map(p => ({
              title: p.title || p.property_address || 'Untitled',
              subtitle: p.agency_name || p.client_name || '—',
              value: `$${Math.round(pv(p) / 1000)}k`,
              valueColor: 'text-blue-600',
              url: createPageUrl('ProjectDetails') + `?id=${p.id}`,
              icon: TrendingUp,
            })),
          cta: { label: `View all ${stage} projects`, url: createPageUrl('Projects') + `?status=${stage}` },
        };
      },
    };

    return drills[type]?.() || null;
  }, [type, data, config]);
}

/**
 * useStat - Convenience hook for simple stat aggregation
 * Returns { value, drillData, StatComponent }
 */
export function useStat(type, data, label, config = {}) {
  const drillData = useDrillData(type, data, config);
  const formatted = formatStatValue(type, data, config);

  return {
    value: formatted,
    drillData,
    render: (props) => (
      <StatDrillThrough 
        value={formatted}
        label={label}
        type={type}
        data={data}
        config={config}
        {...props}
      />
    ),
  };
}

/**
 * formatStatValue - Format raw stat into display string
 */
function formatStatValue(type, data, config) {
  if (!data || data.length === 0) return '—';

  const pv = (p) => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;
  const now = new Date();

  switch (type) {
    case 'revenue': {
      const filtered = config.filter ? data.filter(config.filter) : data;
      const total = filtered.reduce((s, p) => s + pv(p), 0);
      return `$${Math.round(total / 1000)}k`;
    }
    case 'projects': {
      const filtered = config.filter ? data.filter(config.filter) : data;
      return filtered.length;
    }
    case 'tasks': {
      const filtered = config.filter ? data.filter(config.filter) : data;
      return filtered.length;
    }
    case 'agencies': {
      const stats = {};
      data.forEach(p => {
        if (!p.agency_id) return;
        if (!stats[p.agency_id]) stats[p.agency_id] = { revenue: 0, count: 0 };
        stats[p.agency_id].revenue += pv(p);
        stats[p.agency_id].count++;
      });
      return Object.keys(stats).length;
    }
    case 'overdue': {
      return data.filter(t => !t.is_completed && t.due_date && new Date(fixTimestamp(t.due_date)) < now).length;
    }
    case 'stage': {
      const stage = config.stage;
      return data.filter(p => p.status === stage).length;
    }
    default:
      return '—';
  }
}

export default StatDrillThrough;