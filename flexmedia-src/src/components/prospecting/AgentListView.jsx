import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { createPageUrl } from '@/utils';
import { Link } from 'react-router-dom';

const statusColors = {
  'New Lead': 'bg-blue-100 text-blue-800',
  'Researching': 'bg-indigo-100 text-indigo-800',
  'Attempted Contact': 'bg-purple-100 text-purple-800',
  'Discovery Call Scheduled': 'bg-pink-100 text-pink-800',
  'Proposal Sent': 'bg-rose-100 text-rose-800',
  'Nurturing': 'bg-amber-100 text-amber-800',
  'Qualified': 'bg-green-100 text-green-800',
  'Unqualified': 'bg-red-100 text-red-800',
  'Converted to Client': 'bg-emerald-100 text-emerald-800',
  'Lost': 'bg-muted text-foreground'
};

export default function AgentListView({ agents, interactions }) {
  if (!agents.length) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">No agents to display</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Agents ({agents.length})</h2>
      <div className="grid grid-cols-1 gap-3">
        {agents.map((agent) => (
          <Link key={agent.id} to={createPageUrl('ProspectDetails') + `?id=${agent.id}`}>
            <Card className="hover:shadow-lg transition-shadow cursor-pointer">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold">{agent.name}</h3>
                    <p className="text-sm text-muted-foreground">{agent.title}</p>
                    <div className="flex gap-2 mt-2">
                      <Badge variant="outline">{agent.email}</Badge>
                      {agent.current_agency_name && (
                        <Badge variant="outline">{agent.current_agency_name}</Badge>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <Badge className={statusColors[agent.status] || 'bg-muted text-foreground'}>
                      {agent.status}
                    </Badge>
                    <p className="text-xs text-muted-foreground mt-2">{agent.interactionCount} interactions</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}