import React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Mail, Phone, Building, Calendar, TrendingUp } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { fixTimestamp } from '@/components/utils/dateUtils';

const STATUS_COLORS = {
  'New Lead': 'bg-blue-100 text-blue-800',
  'Researching': 'bg-purple-100 text-purple-800',
  'Attempted Contact': 'bg-orange-100 text-orange-800',
  'Discovery Call Scheduled': 'bg-indigo-100 text-indigo-800',
  'Proposal Sent': 'bg-cyan-100 text-cyan-800',
  'Nurturing': 'bg-pink-100 text-pink-800',
  'Qualified': 'bg-green-100 text-green-800',
  'Unqualified': 'bg-gray-100 text-gray-800',
  'Converted to Client': 'bg-emerald-100 text-emerald-800',
  'Lost': 'bg-red-100 text-red-800'
};

const VALUE_COLORS = {
  'Low': 'text-gray-600',
  'Medium': 'text-blue-600',
  'High': 'text-orange-600',
  'Enterprise': 'text-red-600'
};

export default function ProspectListView({ prospects, interactionsByProspect }) {
  return (
    <div className="space-y-3">
      {prospects.map(prospect => (
        <Link
          key={prospect.id}
          to={createPageUrl(`ProspectDetails?id=${prospect.id}`)}
        >
          <Card className="p-5 hover:shadow-lg transition-all duration-200 cursor-pointer border-l-4 border-l-primary/20 hover:border-l-primary">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-2">
                  <h3 className="text-lg font-semibold truncate">{prospect.name}</h3>
                  {prospect.value_potential && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <TrendingUp className={`h-4 w-4 ${VALUE_COLORS[prospect.value_potential]}`} />
                      <span className={`text-xs font-semibold ${VALUE_COLORS[prospect.value_potential]}`}>
                        {prospect.value_potential}
                      </span>
                    </div>
                  )}
                </div>

                {prospect.title && (
                  <p className="text-sm text-muted-foreground mb-3">{prospect.title}</p>
                )}

                {/* Contact Info */}
                <div className="flex flex-wrap gap-3 mb-3 text-xs">
                  {prospect.email && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Mail className="h-3.5 w-3.5" />
                      <span className="truncate">{prospect.email}</span>
                    </div>
                  )}
                  {prospect.phone && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Phone className="h-3.5 w-3.5" />
                      <span>{prospect.phone}</span>
                    </div>
                  )}
                  {prospect.current_agency_name && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Building className="h-3.5 w-3.5" />
                      <span className="truncate">{prospect.current_agency_name}</span>
                    </div>
                  )}
                </div>

                {/* Tags */}
                <div className="flex flex-wrap gap-2">
                  <Badge className={STATUS_COLORS[prospect.status]}>
                    {prospect.status}
                  </Badge>
                  {prospect.media_needs && prospect.media_needs.length > 0 && (
                    <Badge variant="outline" className="text-xs">
                      {prospect.media_needs.length} service{prospect.media_needs.length !== 1 ? 's' : ''}
                    </Badge>
                  )}
                </div>
              </div>

              {/* Right Side Stats */}
              <div className="flex flex-col items-end gap-3 flex-shrink-0">
                <div className="text-right">
                  <div className="text-2xl font-bold text-primary">{prospect.interactionCount}</div>
                  <p className="text-xs text-muted-foreground">Interactions</p>
                </div>
                
                {prospect.lastInteraction && (
                  <div className="text-right text-xs text-muted-foreground flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    <span>{formatDistanceToNow(new Date(fixTimestamp(prospect.lastInteraction)), { addSuffix: true })}</span>
                  </div>
                )}
              </div>
            </div>
          </Card>
        </Link>
      ))}
    </div>
  );
}