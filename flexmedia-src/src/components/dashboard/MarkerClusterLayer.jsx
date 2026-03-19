import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { createPageUrl } from '@/utils';
import { fmtDate, parseDate, todaySydney } from '@/components/utils/dateUtils';

// Stage → hex color for pipeline mode
const STAGE_COLORS = {
  pending_review:    '#f59e0b',
  to_be_scheduled:  '#94a3b8',
  scheduled:        '#3b82f6',
  onsite:           '#eab308',
  uploaded:         '#f97316',
  submitted:        '#8b5cf6',
  in_progress:      '#7c3aed',
  ready_for_partial:'#6366f1',
  in_revision:      '#d97706',
  delivered:        '#10b981',
};

const STAGE_LABELS = {
  pending_review:    'Pending Review',
  to_be_scheduled:  'To Schedule',
  scheduled:        'Scheduled',
  onsite:           'Onsite',
  uploaded:         'Uploaded',
  submitted:        'Submitted',
  in_progress:      'In Progress',
  ready_for_partial:'Ready Partial',
  in_revision:      'In Revision',
  delivered:        'Delivered',
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

function makePin(color, initials = '', size = 34) {
  return L.divIcon({
    className: '',
    iconSize:   [size, size + 8],
    iconAnchor: [size / 2, size + 8],
    popupAnchor:[0, -(size + 8)],
    html: `
      <div style="position:relative;width:${size}px;height:${size + 8}px;">
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

function makeCluster(count, dominantColor) {
  const size = count >= 20 ? 52 : count >= 10 ? 46 : 38;
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
        display:flex;align-items:center;justify-content:center;
        color:white;font-weight:800;font-size:${size > 44 ? 16 : 13}px;
        font-family:system-ui,sans-serif;
      ">${count}</div>
    `,
  });
}

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
        children.forEach(m => {
          const c = m.options._pinColor || '#6366f1';
          colorCounts[c] = (colorCounts[c] || 0) + 1;
        });
        const dominant = Object.entries(colorCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '#6366f1';
        return makeCluster(cluster.getChildCount(), dominant);
      },
    });

    projects.forEach(project => {
      if (!project.lat || !project.lng) return;

      // Pin color
      const color = mode === 'pipeline'
        ? (STAGE_COLORS[project.status] || '#94a3b8')
        : getShootTimingColor(project.shoot_date);

      // Initials from first assigned staff
      let initials = '';
      const staffId = project.project_owner_id || project.onsite_staff_1_id;
      if (staffId) {
        const u = users.find(u => u.id === staffId);
        if (u?.full_name) {
          initials = u.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
        }
      }

      const marker = L.marker([project.lat, project.lng], {
        icon: makePin(color, initials),
        _pinColor: color,
      });

      // Click → call parent handler (opens side drawer, no popup)
      marker.on('click', () => onSelectProject(project));

      group.addLayer(marker);
    });

    map.addLayer(group);
    groupRef.current = group;

    return () => {
      if (groupRef.current) map.removeLayer(groupRef.current);
    };
  }, [map, projects, users, mode, onSelectProject]);

  return null;
}