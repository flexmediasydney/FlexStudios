import React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';
import { fmtTimestampCustom, fixTimestamp } from '@/components/utils/dateUtils';
import { Mail, Phone, MessageSquare, Calendar, User, Smile } from 'lucide-react';

const INTERACTION_ICONS = {
  'Email Sent': Mail,
  'Email Received': Mail,
  'Phone Call': Phone,
  'LinkedIn Message': MessageSquare,
  'Meeting': Calendar,
  'Note Added': MessageSquare,
  'Status Change': MessageSquare
};

const SENTIMENT_COLORS = {
  'Positive': 'bg-green-100 text-green-800',
  'Neutral': 'bg-gray-100 text-gray-800',
  'Negative': 'bg-red-100 text-red-800'
};

const INTERACTION_TYPE_COLORS = {
  'Email Sent': 'bg-blue-100 text-blue-800',
  'Email Received': 'bg-blue-100 text-blue-800',
  'Phone Call': 'bg-purple-100 text-purple-800',
  'LinkedIn Message': 'bg-indigo-100 text-indigo-800',
  'Meeting': 'bg-amber-100 text-amber-800',
  'Note Added': 'bg-gray-100 text-gray-800',
  'Status Change': 'bg-cyan-100 text-cyan-800'
};

export default function InteractionCard({ interaction }) {
  const Icon = INTERACTION_ICONS[interaction.interaction_type] || MessageSquare;

  return (
    <Card className="p-4 hover:shadow-md transition-shadow">
      <div className="flex gap-4">
        {/* Icon */}
        <div className="flex-shrink-0 mt-0.5">
          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
            <Icon className="h-4 w-4 text-primary" />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-4 mb-2">
            <div className="flex-1">
              <h4 className="font-semibold text-sm">{interaction.summary}</h4>
              <p className="text-xs text-muted-foreground mt-0.5">
                {fmtTimestampCustom(interaction.date_time, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                <span className="text-muted-foreground/60 ml-2">
                  ({formatDistanceToNow(new Date(fixTimestamp(interaction.date_time)), { addSuffix: true })})
                </span>
              </p>
            </div>
            
            <div className="flex gap-2 flex-shrink-0">
              <Badge className={INTERACTION_TYPE_COLORS[interaction.interaction_type]}>
                {interaction.interaction_type}
              </Badge>
              <Badge className={SENTIMENT_COLORS[interaction.sentiment]}>
                {interaction.sentiment}
              </Badge>
            </div>
          </div>

          {/* Details */}
          {interaction.details && (
            <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
              {interaction.details}
            </p>
          )}

          {/* Footer */}
          <div className="flex items-center gap-3 mt-3 pt-3 border-t text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <User className="h-3 w-3" />
              <span>{interaction.user_name || 'System'}</span>
            </div>
            {interaction.relationship_state_at_time && (
              <div className="flex items-center gap-1">
                <Badge variant="outline" className="text-xs">
                  {interaction.relationship_state_at_time}
                </Badge>
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}