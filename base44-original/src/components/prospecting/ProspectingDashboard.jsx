import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, Users, Building2, Target, Calendar, DollarSign } from 'lucide-react';
import { useEntityList } from '@/components/hooks/useEntityData';

export default function ProspectingDashboard() {
  const { data: agents = [] } = useEntityList('Agent');
  const { data: agencies = [] } = useEntityList('Agency');
  const { data: interactions = [] } = useEntityList('InteractionLog');

  const metrics = useMemo(() => {
    const prospectingAgents = agents.filter(a => a.relationship_state === 'Prospecting');
    const activeAgents = agents.filter(a => a.relationship_state === 'Active');
    const prospectingAgencies = agencies.filter(a => a.relationship_state === 'Prospecting');
    const activeAgencies = agencies.filter(a => a.relationship_state === 'Active');

    // Pipeline stages
    const pipelineStages = {
      'New Lead': agents.filter(a => a.status === 'New Lead').length,
      'Researching': agents.filter(a => a.status === 'Researching').length,
      'Attempted Contact': agents.filter(a => a.status === 'Attempted Contact').length,
      'Discovery Call Scheduled': agents.filter(a => a.status === 'Discovery Call Scheduled').length,
      'Proposal Sent': agents.filter(a => a.status === 'Proposal Sent').length,
      'Qualified': agents.filter(a => a.status === 'Qualified').length,
    };

    // Value potential distribution
    const valueDistribution = {
      'Low': agents.filter(a => a.value_potential === 'Low').length,
      'Medium': agents.filter(a => a.value_potential === 'Medium').length,
      'High': agents.filter(a => a.value_potential === 'High').length,
      'Enterprise': agents.filter(a => a.value_potential === 'Enterprise').length,
    };

    // Engagement metrics
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentInteractions = interactions.filter(i => new Date(i.date_time) > lastWeek).length;

    return {
      totalAgents: agents.length,
      prospectingAgents: prospectingAgents.length,
      activeAgents: activeAgents.length,
      totalAgencies: agencies.length,
      prospectingAgencies: prospectingAgencies.length,
      activeAgencies: activeAgencies.length,
      totalInteractions: interactions.length,
      recentInteractions,
      conversionRate: agents.length > 0 ? ((activeAgents.length / agents.length) * 100).toFixed(1) : 0,
      pipelineStages,
      valueDistribution,
      agentsByMedia: {
        'Photography': agents.filter(a => a.media_needs?.includes('Photography')).length,
        'Video': agents.filter(a => a.media_needs?.includes('Video Production')).length,
        'Drone': agents.filter(a => a.media_needs?.includes('Drone Footage')).length,
      }
    };
  }, [agents, agencies, interactions]);

  const StatCard = ({ icon: Icon, label, value, subtext, color = 'blue' }) => (
    <Card className="border-l-4" style={{ borderLeftColor: `hsl(var(--${color}))` }}>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-3xl font-bold mt-2">{value}</p>
            {subtext && <p className="text-xs text-muted-foreground mt-1">{subtext}</p>}
          </div>
          <Icon className="h-6 w-6 text-muted-foreground opacity-50" />
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      {/* KPI Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Users}
          label="Total Agents"
          value={metrics.totalAgents}
          subtext={`${metrics.activeAgents} active`}
          color="primary"
        />
        <StatCard
          icon={Building2}
          label="Total Agencies"
          value={metrics.totalAgencies}
          subtext={`${metrics.activeAgencies} active`}
          color="primary"
        />
        <StatCard
          icon={Target}
          label="Conversion Rate"
          value={`${metrics.conversionRate}%`}
          subtext="Prospecting → Active"
          color="primary"
        />
        <StatCard
          icon={Calendar}
          label="Recent Activity"
          value={metrics.recentInteractions}
          subtext="Last 7 days"
          color="primary"
        />
      </div>

      {/* Pipeline Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Prospecting Pipeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Object.entries(metrics.pipelineStages).map(([stage, count]) => (
              <div key={stage}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium">{stage}</span>
                  <Badge variant="outline">{count}</Badge>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div
                    className="bg-primary rounded-full h-2 transition-all"
                    style={{ width: `${(count / Math.max(...Object.values(metrics.pipelineStages), 1)) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Value Potential Distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5" />
              Value Potential
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(metrics.valueDistribution).map(([level, count]) => {
                const colors = {
                  'Low': 'bg-blue-100 text-blue-800',
                  'Medium': 'bg-amber-100 text-amber-800',
                  'High': 'bg-green-100 text-green-800',
                  'Enterprise': 'bg-purple-100 text-purple-800'
                };
                return (
                  <div key={level} className="flex items-center justify-between">
                    <Badge className={colors[level]}>{level}</Badge>
                    <span className="font-semibold">{count} agents</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Media Needs */}
        <Card>
          <CardHeader>
            <CardTitle>Media Service Demand</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(metrics.agentsByMedia).map(([service, count]) => (
                <div key={service}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium">{service}</span>
                    <span className="font-semibold">{count}</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2">
                    <div
                      className="bg-accent rounded-full h-2 transition-all"
                      style={{ width: `${(count / Math.max(...Object.values(metrics.agentsByMedia), 1)) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Summary */}
      <Card className="bg-muted/30">
        <CardContent className="pt-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold text-primary">{metrics.prospectingAgents}</p>
              <p className="text-xs text-muted-foreground">Prospecting Agents</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-600">{metrics.activeAgents}</p>
              <p className="text-xs text-muted-foreground">Active Agents</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-primary">{metrics.totalInteractions}</p>
              <p className="text-xs text-muted-foreground">Total Interactions</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-accent">{metrics.prospectingAgencies}</p>
              <p className="text-xs text-muted-foreground">Prospecting Agencies</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}