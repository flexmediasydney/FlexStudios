import { useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { format, subMonths, startOfMonth, endOfMonth, isWithinInterval } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";

export default function RevenueComparisonChart({ projects = [] }) {
  const { data, totalCurrent, totalPrevious, growth } = useMemo(() => {
    const now = new Date();
    const projectValue = (p) => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;

    // Build 6 months of data, each with current year and previous year
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const targetMonth = subMonths(now, i);
      const monthStart = startOfMonth(targetMonth);
      const monthEnd = endOfMonth(targetMonth);
      const label = format(targetMonth, "MMM");

      // Current year
      const currentMonthProjects = projects.filter(p => {
        if (!p.created_date) return false;
        try {
          const d = new Date(fixTimestamp(p.created_date));
          return isWithinInterval(d, { start: monthStart, end: monthEnd });
        } catch { return false; }
      });

      // Same month, previous year
      const prevYearMonth = subMonths(targetMonth, 12);
      const prevStart = startOfMonth(prevYearMonth);
      const prevEnd = endOfMonth(prevYearMonth);
      const prevMonthProjects = projects.filter(p => {
        if (!p.created_date) return false;
        try {
          const d = new Date(fixTimestamp(p.created_date));
          return isWithinInterval(d, { start: prevStart, end: prevEnd });
        } catch { return false; }
      });

      months.push({
        month: label,
        current: currentMonthProjects.reduce((sum, p) => sum + projectValue(p), 0),
        previous: prevMonthProjects.reduce((sum, p) => sum + projectValue(p), 0),
      });
    }

    const totalCurrent = months.reduce((s, m) => s + m.current, 0);
    const totalPrevious = months.reduce((s, m) => s + m.previous, 0);
    const growth = totalPrevious > 0
      ? ((totalCurrent - totalPrevious) / totalPrevious * 100).toFixed(1)
      : totalCurrent > 0 ? 100 : 0;

    return { data: months, totalCurrent, totalPrevious, growth: parseFloat(growth) };
  }, [projects]);

  const isPositive = growth >= 0;

  return (
    <Card className="col-span-2">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Revenue: Month-over-Month</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Last 6 months vs. same period last year
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={`text-xs font-mono ${isPositive ? "text-green-600 border-green-200" : "text-red-600 border-red-200"}`}
            >
              {isPositive ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
              {isPositive ? "+" : ""}{growth}%
            </Badge>
            <Badge variant="outline" className="font-mono text-sm">
              ${(totalCurrent / 1000).toFixed(1)}k
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 11, fill: '#6b7280' }}
              axisLine={{ stroke: '#e5e7eb' }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#6b7280' }}
              axisLine={{ stroke: '#e5e7eb' }}
              tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#fff',
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
                boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                fontSize: '12px'
              }}
              formatter={(value, name) => [
                `$${value.toLocaleString()}`,
                name === 'current' ? 'This Year' : 'Last Year'
              ]}
            />
            <Legend
              wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }}
              iconType="circle"
              formatter={(value) => value === 'current' ? 'This Year' : 'Last Year'}
            />
            <Bar dataKey="previous" fill="#cbd5e1" radius={[4, 4, 0, 0]} name="previous" />
            <Bar dataKey="current" fill="#3b82f6" radius={[4, 4, 0, 0]} name="current" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
