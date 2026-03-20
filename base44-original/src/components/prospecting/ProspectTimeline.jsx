import React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fmtTimestampCustom } from '@/components/utils/dateUtils';
import { Mail, Phone, MessageSquare, Calendar, User } from 'lucide-react';

const INTERACTION_ICONS = {
  'Email Sent': Mail,
  'Email Received': Mail,
  'Phone Call': Phone,
  'LinkedIn Message': MessageSquare,
  'Meeting': Calendar,
  'Note Added': MessageSquare,
  'Status Change': MessageSquare
};

export default function ProspectTimeline({ prospect, interactions = [] }) {
  if (interactions.length === 0) {
    return (
      <Card className="p-12 text-center">
        <p className="text-muted-foreground">No interactions yet. Start by logging your first touchpoint.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {interactions.map((interaction, index) => {
        const Icon = INTERACTION_ICONS[interaction.interaction_type] || MessageSquare;
        const isLast = index === interactions.length - 1;

        return (
          <div key={interaction.id} className="relative">
            {/* Timeline line */}
            {!isLast && (
              <div className="absolute left-4 top-10 w-0.5 h-20 bg-border" />
            )}

            <div className="flex gap-4">
              {/* Timeline dot */}
              <div className="flex-shrink-0 relative z-10">
                <div className="h-9 w-9 rounded-full bg-primary/10 border-4 border-background flex items-center justify-center">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
              </div>

              {/* Content */}
              <Card className="flex-1 p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h4 className="font-semibold">{interaction.summary}</h4>
                    <p className="text-xs text-muted-foreground mt-1">
                      {fmtTimestampCustom(interaction.date_time, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                  <Badge className="text-xs">
                    {interaction.interaction_type}
                  </Badge>
                </div>

                {interaction.details && (
                  <p className="text-sm text-muted-foreground mt-3">{interaction.details}</p>
                )}

                <div className="flex items-center gap-2 mt-4 pt-3 border-t text-xs text-muted-foreground">
                  <User className="h-3 w-3" />
                  <span>{interaction.user_name || 'System'}</span>
                </div>
              </Card>
            </div>
          </div>
        );
      })}
    </div>
  );
}