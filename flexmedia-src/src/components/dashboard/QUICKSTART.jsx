# StatDrillThrough — Quick Start (2 Minutes)

## 1. Import
```jsx
import { StatDrillThrough } from '@/components/dashboard/StatDrillThrough';
```

## 2. Wrap Any Stat
```jsx
// Before:
<div className="text-3xl font-bold">${totalRevenue}</div>

// After:
<StatDrillThrough
  value={`$${Math.round(totalRevenue / 1000)}k`}
  label="Total Revenue"
  type="revenue"
  data={projects}
  className="text-3xl font-bold cursor-help"
/>
```

## 3. Done! 🎉
Hover over the stat to see the drill-through popup.

---

## 5 Drill Types

| Type | Use Case | Example |
|------|----------|---------|
| `revenue` | Sum of values | Total Revenue, Pipeline Value |
| `projects` | Count of items | Active Projects, Delivered Count |
| `tasks` | List of tasks | Overdue Tasks, Completed Tasks |
| `agencies` | Top performers | Top Agencies, Partners by Revenue |
| `stage` | Filtered subset | Projects in Stage X |

---

## With Filters

```jsx
// Show only active projects
<StatDrillThrough
  value={activeCount}
  label="Active Projects"
  type="projects"
  data={projects}
  config={{ filter: p => !['delivered'].includes(p.status) }}
/>

// Show only unpaid revenue
<StatDrillThrough
  value={unpaidAmount}
  label="Revenue at Risk"
  type="revenue"
  data={projects}
  config={{ filter: p => p.payment_status !== 'paid' }}
/>

// Show specific stage
<StatDrillThrough
  value={onsiteCount}
  label="Projects Onsite"
  type="stage"
  data={projects}
  config={{ stage: 'onsite' }}
/>
```

---

## That's It!

See `STAT_DRILLTHROUGH_GUIDE.md` for full documentation.

Try the testbed:
```jsx
import StatDrillTestbed from '@/components/dashboard/StatDrillTestbed';

export default function TestPage() {
  return <StatDrillTestbed />;
}
``