import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Building2 } from 'lucide-react';

const stateColors = {
  'Prospecting': 'bg-orange-100 text-orange-800',
  'Active': 'bg-green-100 text-green-800',
  'Dormant': 'bg-muted text-foreground'
};

export default function AgencyListView({ agencies, interactions }) {
  if (!agencies.length) {
    return (
      <div className="text-center py-12">
        <Building2 className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-muted-foreground">No agencies found. Add an agency to start tracking prospects.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Agencies ({agencies.length})</h2>
      <div className="grid grid-cols-1 gap-3">
        {agencies.map((agency) => (
          <Card key={agency.id} className="hover:shadow-md transition-all duration-200">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <Building2 className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium text-sm">{agency.name}</h3>
                    <p className="text-sm text-muted-foreground">{agency.email}</p>
                    {agency.address && (
                      <p className="text-sm text-muted-foreground">{agency.address}</p>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <Badge className={stateColors[agency.relationship_state] || 'bg-muted text-foreground'}>
                    {agency.relationship_state}
                  </Badge>
                  <p className="text-xs text-muted-foreground mt-2">{agency.interactionCount} interaction{agency.interactionCount !== 1 ? 's' : ''}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}