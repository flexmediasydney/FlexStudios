import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { PROJECT_STAGES } from "@/components/projects/projectStatuses";

export default function StageDistributionChart({ projects }) {
  const data = PROJECT_STAGES.map(stage => {
    const stageProjects = projects.filter(p => p.status === stage.value);
    const revenue = stageProjects.reduce((sum, p) => sum + (p.calculated_price || p.price || 0), 0);
    return {
      name: stage.label,
      count: stageProjects.length,
      revenue,
      fill: stage.color.includes('bg-') 
        ? `hsl(${stage.color.includes('blue') ? '220 70% 50%' : stage.color.includes('green') ? '142 71% 45%' : stage.color.includes('amber') ? '38 92% 50%' : '220 14% 96%'})`
        : '#3b82f6'
    };
  }).filter(d => d.count > 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Projects by Stage</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={data} layout="vertical" margin={{ top: 5, right: 10, left: 80, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11, fill: '#6b7280' }} />
            <YAxis 
              type="category" 
              dataKey="name" 
              tick={{ fontSize: 11, fill: '#6b7280' }}
              width={75}
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
                name === 'count' ? `${value} projects` : `$${value.toLocaleString()}`,
                name === 'count' ? 'Projects' : 'Revenue'
              ]}
            />
            <Bar dataKey="count" radius={[0, 4, 4, 0]}>
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}