import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { fmtDate, parseDate, todaySydney } from '@/components/utils/dateUtils';

// Stage -> hex color for pipeline mode
const STAGE_COLORS = {
  pending_review:    '#f59e0b',
  to_be_scheduled:   '#94a3b8',
  scheduled:         '#3b82f6',
  onsite:            '#eab308',
  uploaded:          '#f97316',
  in_progress:       '#7c3aed',
  in_production:     '#06b6d4',
  ready_for_partial: '#6366f1',
  in_revision:       '#d97706',
  delivered:         '#10b981',
};

const STAGE_LABELS = {
  pending_review:    'Pending Review',
  to_be_scheduled:   'To Schedule',
  scheduled:         'Scheduled',
  onsite:            'Onsite',
  uploaded:          'Uploaded',
  in_progress:       'Stills in Progress',
  in_production:     'Video in Progress',
  ready_for_partial: 'Partial Delivery',
  in_revision:       'In Revision',
  delivered:         'Delivered',
};

function getShootTimingColor(shootDate) {
  if (!shootDate) return '#94a3b8';
  const shoot = parseDate(shootDate);
  const today = parseDate(todaySydney());
  if (!shoot || !today) return '#94a3b8';
  const diff = Math.round((shoot - today) / (1000 * 60 * 60 * 24));
  if (diff < 0)  return '#ef4444'; // overdue / past
  if (diff === 0) return '#22c55e'; // today
  if (diff <= 7)  return '#3b82f6'; // this week
  return '#94a3b8'; // future
}

const projectValue = (p) => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;

// ─── Pin icon with status-colored dot ────────────────────────────────
function makePin(color, initials = '', size = 34) {
  return L.divIcon({
    className: '',
    iconSize:   [size, size + 8],
    iconAnchor: [size / 2, size + 8],
    popupAnchor:[0, -(size + 8)],
    html: `
      <div style="position:relative;width:${size}px;height:${size + 8}px;cursor:pointer;">
        <div style="
          width:${size}px;height:${size}px;
          background:${color};
          border-radius:50% 50% 50% 0;
          transform:rotate(-45deg);
          border:3px solid white;
          box-shadow:0 3px 10px rgba(0,0,0,0.35);
        "></div>
        <div style="
          position:absolute;top:3px;left:50%;transform:translateX(-50%);
          color:white;font-size:${initials.length > 1 ? '10px' : '12px'};
          font-weight:700;font-family:system-ui,sans-serif;
          text-shadow:0 1px 2px rgba(0,0,0,0.4);
          white-space:nowrap;
        ">${initials}</div>
      </div>
    `,
  });
}

// ─── Cluster icon ────────────────────────────────────────────────────
function makeCluster(count, dominantColor, totalRevenue) {
  const size = count >= 50 ? 58 : count >= 20 ? 52 : count >= 10 ? 46 : 38;
  const revenueStr = totalRevenue >= 1000 ? `$${Math.round(totalRevenue / 1000)}k` : `$${totalRevenue}`;
  return L.divIcon({
    className: '',
    iconSize:  [size, size],
    iconAnchor:[size / 2, size / 2],
    html: `
      <div style="
        width:${size}px;height:${size}px;
        background:${dominantColor};
        border-radius:50%;
        border:3px solid white;
        box-shadow:0 3px 12px rgba(0,0,0,0.3);
        display:flex;align-items:center;justify-content:center;flex-direction:column;
        color:white;font-family:system-ui,sans-serif;
        cursor:pointer;
      ">
        <div style="font-weight:800;font-size:${size > 44 ? 15 : 13}px;line-height:1;">${count}</div>
        <div style="font-size:${size > 44 ? 9 : 8}px;opacity:0.85;line-height:1;margin-top:1px;">${revenueStr}</div>
      </div>
    `,
  });
}

// ─── Rich hover tooltip for individual pins ──────────────────────────
function buildTooltipHtml(project) {
  const color = STAGE_COLORS[project.status] || '#94a3b8';
  const label = STAGE_LABELS[project.status] || project.status || 'Unknown';
  const title = project.title || project.property_address || 'Untitled';
  const address = project.property_address || '';
  const agent = project.agent_name || '';
  const org = project.agency_name || '';
  const shootDate = project.shoot_date ? fmtDate(project.shoot_date, 'd MMM yyyy') : '';
  const shootTime = project.shoot_start_time || '';
  const price = projectValue(project);
  const products = project.product_names || project.package_name || '';

  let html = `<div style="font-family:system-ui,-apple-system,sans-serif;min-width:220px;max-width:280px;padding:0;">`;

  // Title row
  html += `<div style="font-weight:700;font-size:13px;margin-bottom:4px;line-height:1.3;">${escapeHtml(title)}</div>`;

  // Address (if different from title)
  if (address && address !== title) {
    html += `<div style="font-size:11px;color:#6b7280;margin-bottom:6px;">${escapeHtml(address)}</div>`;
  }

  // Status badge
  html += `<div style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:9999px;font-size:10px;font-weight:600;margin-bottom:8px;color:white;background:${color};">`;
  html += `<span style="width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,0.7);"></span>`;
  html += `${escapeHtml(label)}</div>`;

  // Details grid
  html += `<div style="display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:11px;">`;

  if (agent || org) {
    html += `<span style="color:#9ca3af;font-weight:500;">Agent</span>`;
    html += `<span style="font-weight:500;">${escapeHtml(agent)}${org ? ` <span style="color:#9ca3af;">&middot; ${escapeHtml(org)}</span>` : ''}</span>`;
  }

  if (shootDate) {
    html += `<span style="color:#9ca3af;font-weight:500;">Shoot</span>`;
    html += `<span>${shootDate}${shootTime ? ` at ${shootTime}` : ''}</span>`;
  }

  if (price > 0) {
    html += `<span style="color:#9ca3af;font-weight:500;">Price</span>`;
    html += `<span style="font-weight:600;color:#059669;">$${price.toLocaleString()}</span>`;
  }

  if (products) {
    html += `<span style="color:#9ca3af;font-weight:500;">Products</span>`;
    html += `<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(truncate(products, 50))}</span>`;
  }

  html += `</div>`;

  // Click hint
  html += `<div style="margin-top:8px;padding-top:6px;border-top:1px solid #e5e7eb;font-size:10px;color:#9ca3af;text-align:center;">Click to open project</div>`;

  html += `</div>`;
  return html;
}

// ─── Cluster hover tooltip ──────────────────────────────────────────
function buildClusterTooltipHtml(markers) {
  const count = markers.length;
  let totalRev = 0;
  const statusCounts = {};
  markers.forEach(m => {
    const p = m.options._project;
    if (p) {
      totalRev += projectValue(p);
      statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
    }
  });

  let html = `<div style="font-family:system-ui,-apple-system,sans-serif;min-width:160px;padding:0;">`;
  html += `<div style="font-weight:700;font-size:13px;margin-bottom:2px;">${count} projects</div>`;
  html += `<div style="font-size:11px;color:#059669;font-weight:600;margin-bottom:6px;">$${totalRev.toLocaleString()} total revenue</div>`;

  // Top statuses
  const sorted = Object.entries(statusCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (sorted.length > 0) {
    html += `<div style="display:flex;flex-direction:column;gap:2px;">`;
    sorted.forEach(([status, ct]) => {
      const color = STAGE_COLORS[status] || '#94a3b8';
      const label = STAGE_LABELS[status] || status;
      html += `<div style="display:flex;align-items:center;gap:6px;font-size:10px;">`;
      html += `<span style="width:6px;height:6px;border-radius:50%;background:${color};flex-shrink:0;"></span>`;
      html += `<span style="flex:1;">${escapeHtml(label)}</span>`;
      html += `<span style="font-weight:600;">${ct}</span>`;
      html += `</div>`;
    });
    html += `</div>`;
  }

  html += `<div style="margin-top:6px;font-size:10px;color:#9ca3af;text-align:center;">Click to zoom in</div>`;
  html += `</div>`;
  return html;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

// ─── Main component ──────────────────────────────────────────────────
export default function MarkerClusterLayer({
  projects,
  users,
  mode,         // 'shoots' | 'pipeline'
  onSelectProject,
}) {
  const map = useMap();
  const groupRef = useRef(null);

  useEffect(() => {
    if (!map) return;

    // Clear previous layer
    if (groupRef.current) {
      map.removeLayer(groupRef.current);
    }

    const group = L.markerClusterGroup({
      maxClusterRadius: 50,
      animate: true,
      animateAddingMarkers: false,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      iconCreateFunction(cluster) {
        const children = cluster.getAllChildMarkers();
        // Dominant color = most common pin color in cluster
        const colorCounts = {};
        let totalRevenue = 0;
        children.forEach(m => {
          const c = m.options._pinColor || '#6366f1';
          colorCounts[c] = (colorCounts[c] || 0) + 1;
          if (m.options._project) totalRevenue += projectValue(m.options._project);
        });
        const dominant = Object.entries(colorCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '#6366f1';
        return makeCluster(cluster.getChildCount(), dominant, totalRevenue);
      },
    });

    // Add cluster hover tooltip
    group.on('clustermouseover', function(e) {
      const cluster = e.layer;
      const children = cluster.getAllChildMarkers();
      const html = buildClusterTooltipHtml(children);
      const tooltip = L.tooltip({
        direction: 'top',
        offset: [0, -20],
        opacity: 1,
        className: 'leaflet-tooltip-custom',
      })
        .setLatLng(cluster.getLatLng())
        .setContent(html);
      tooltip.addTo(map);
      cluster._customTooltip = tooltip;
    });

    group.on('clustermouseout', function(e) {
      const cluster = e.layer;
      if (cluster._customTooltip) {
        map.removeLayer(cluster._customTooltip);
        cluster._customTooltip = null;
      }
    });

    projects.forEach(project => {
      if (!project.lat || !project.lng) return;

      // Pin color based on status
      const color = mode === 'pipeline'
        ? (STAGE_COLORS[project.status] || '#94a3b8')
        : getShootTimingColor(project.shoot_date);

      // Initials from first assigned staff
      let initials = '';
      const staffId = project.project_owner_id || project.onsite_staff_1_id;
      if (staffId) {
        const u = users.find(usr => usr.id === staffId);
        if (u?.full_name) {
          initials = u.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
        }
      }

      const marker = L.marker([project.lat, project.lng], {
        icon: makePin(color, initials),
        _pinColor: color,
        _project: project,
      });

      // Rich hover tooltip
      const tooltipHtml = buildTooltipHtml(project);
      marker.bindTooltip(tooltipHtml, {
        direction: 'top',
        offset: [0, -42],
        opacity: 1,
        className: 'leaflet-tooltip-custom',
        sticky: false,
      });

      // Click -> navigate to project
      marker.on('click', () => onSelectProject(project));

      group.addLayer(marker);
    });

    map.addLayer(group);
    groupRef.current = group;

    return () => {
      if (groupRef.current) {
        group.off('clustermouseover');
        group.off('clustermouseout');
        map.removeLayer(groupRef.current);
      }
    };
  }, [map, projects, users, mode, onSelectProject]);

  return null;
}
