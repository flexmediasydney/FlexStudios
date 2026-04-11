import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';
import { cn } from '@/lib/utils';
import { fmtHoursMins } from '@/components/utilization/utilizationUtils';

const ROLE_COLORS = {
  photographer: '#3b82f6',
  videographer: '#8b5cf6',
  image_editor: '#ec4899',
  video_editor: '#f59e0b',
  admin: '#6b7280',
};

export default function RoleAnalysisView({ utilizations }) {
  const { roleList, pieData } = useMemo(() => {
    const roleStats = {};

    utilizations.forEach(u => {
      if (!roleStats[u.role]) {
        roleStats[u.role] = {
          role: u.role,
          count: 0,
          activeCount: 0,
          actual: 0,
          estimated: 0,
          totalUtil: 0,
        };
      }
      const rs = roleStats[u.role];
      rs.count += 1;
      rs.actual += u.actual_seconds;
      rs.estimated += u.estimated_seconds;
      if (u.has_data) {
        rs.activeCount += 1;
        rs.totalUtil += u.utilization_percent;
      }
    });

    const list = Object.values(roleStats).sort((a, b) => b.count - a.count);
    const pie = list.map(r => ({ name: r.role, value: r.count }));
    return { roleList: list, pieData: pie };
  }, [utilizations]);

  if (roleList.length === 0) {
    return (
      <Card className="p-12 text-center">
        <p className="text-sm text-muted-foreground">No role data available</p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pie Chart */}
        <Card className="p-6">
          <h3 className="text-sm font-semibold mb-4">Headcount by Role</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={100}
                paddingAngle={2}
                dataKey="value"
                label={({ name, value }) => `${value}`}
              >
                {pieData.map((entry, idx) => (
                  <Cell key={idx} fill={ROLE_COLORS[entry.name] || '#9ca3af'} />
                ))}
              </Pie>
              <Tooltip formatter={(value, name) => [`${value} people`, name.replace(/_/g, ' ')]} />
              <Legend formatter={v => v.replace(/_/g, ' ')} />
            </PieChart>
          </ResponsiveContainer>
        </Card>

        {/* Role Summary */}
        <Card className="p-6">
          <h3 className="text-sm font-semibold mb-4">Role Utilization Summary</h3>
          <div className="space-y-3">
            {roleList.map(role => {
              const avgUtil = role.activeCount > 0
                ? Math.round(role.totalUtil / role.activeCount)
                : null;

              const utilColor = avgUtil == null
                ? 'text-muted-foreground'
                : avgUtil > 120 ? 'text-orange-600'
                : avgUtil >= 80 ? 'text-green-600'
                : 'text-blue-600';

              return (
                <div key={role.role} className="pb-3 border-b last:border-b-0">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <div
                        className="h-3 w-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: ROLE_COLORS[role.role] || '#9ca3af' }}
                      />
                      <span className="text-sm font-medium capitalize">
                        {role.role.replace(/_/g, ' ')}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        ({role.count}{role.activeCount < role.count ? `, ${role.activeCount} active` : ''})
                      </span>
                    </div>
                    <span className={cn('text-sm font-bold', utilColor)}>
                      {avgUtil !== null ? `${avgUtil}%` : '—'}
                    </span>
                  </div>
                  <div className="flex gap-3 text-xs text-muted-foreground">
                    <span>{fmtHoursMins(role.actual)} actual</span>
                    <span>·</span>
                    <span>{fmtHoursMins(role.estimated)} estimated</span>
                  </div>
                  {role.estimated > 0 && (
                    <div className="w-full bg-muted rounded-full h-1 mt-1.5">
                      <div
                        className={cn(
                          'h-1 rounded-full transition-all',
                          avgUtil > 120 ? 'bg-orange-400' : avgUtil >= 80 ? 'bg-green-400' : 'bg-blue-300',
                        )}
                        style={{ width: `${Math.min(avgUtil ?? 0, 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}