import React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Mail, Phone, TrendingUp } from 'lucide-react';

const VALUE_COLORS = {
  'Low': 'text-gray-600',
  'Medium': 'text-blue-600',
  'High': 'text-orange-600',
  'Enterprise': 'text-red-600'
};

const STATUS_BORDER = {
  'New Lead': 'border-t-blue-500',
  'Researching': 'border-t-purple-500',
  'Attempted Contact': 'border-t-orange-500',
  'Discovery Call Scheduled': 'border-t-indigo-500',
  'Proposal Sent': 'border-t-cyan-500',
  'Nurturing': 'border-t-pink-500',
  'Qualified': 'border-t-green-500',
  'Unqualified': 'border-t-gray-500',
  'Converted to Client': 'border-t-emerald-500',
  'Lost': 'border-t-red-500'
};

const ProspectCard = ({ prospect }) => (
  <Link to={createPageUrl(`ProspectDetails?id=${prospect.id}`)}>
    <Card className={`p-4 hover:shadow-lg transition-all duration-200 cursor-pointer border-t-4 ${STATUS_BORDER[prospect.status]}`}>
      <div className="space-y-3">
        <div>
          <h4 className="font-semibold text-sm line-clamp-2">{prospect.name}</h4>
          <p className="text-xs text-muted-foreground mt-0.5">{prospect.title}</p>
        </div>

        {/* Contact Quick Links */}
        <div className="flex gap-2">
          {prospect.email && (
            <a
              href={`mailto:${prospect.email}`}
              className="p-1.5 hover:bg-muted rounded transition-colors"
              onClick={(e) => e.stopPropagation()}
              title={prospect.email}
            >
              <Mail className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
            </a>
          )}
          {prospect.phone && (
            <a
              href={`tel:${prospect.phone}`}
              className="p-1.5 hover:bg-muted rounded transition-colors"
              onClick={(e) => e.stopPropagation()}
              title={prospect.phone}
            >
              <Phone className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
            </a>
          )}
        </div>

        {/* Stats */}
        <div className="flex items-center justify-between pt-2 border-t">
          <div className="flex items-center gap-1">
            {prospect.value_potential && (
              <div className="flex items-center gap-0.5">
                <TrendingUp className={`h-3 w-3 ${VALUE_COLORS[prospect.value_potential]}`} />
                <span className={`text-xs font-semibold ${VALUE_COLORS[prospect.value_potential]}`}>
                  {prospect.value_potential[0]}
                </span>
              </div>
            )}
          </div>
          <div className="text-right">
            <p className="text-xs font-bold text-primary">{prospect.interactionCount}</p>
            <p className="text-xs text-muted-foreground">touches</p>
          </div>
        </div>

        {/* Agency */}
        {prospect.current_agency_name && (
          <p className="text-xs text-muted-foreground truncate bg-muted/50 px-2 py-1 rounded">
            {prospect.current_agency_name}
          </p>
        )}
      </div>
    </Card>
  </Link>
);

export default function ProspectKanbanView({ prospectsByStatus }) {
  const statuses = Object.keys(prospectsByStatus);
  
  // Group statuses into columns intelligently
  const columns = [
    { title: 'Discovery', statuses: ['New Lead', 'Researching', 'Attempted Contact'] },
    { title: 'Engagement', statuses: ['Discovery Call Scheduled', 'Proposal Sent', 'Nurturing'] },
    { title: 'Closing', statuses: ['Qualified', 'Converted to Client'] },
    { title: 'Archive', statuses: ['Unqualified', 'Lost'] }
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-6">
      {columns.map(column => (
        <div key={column.title}>
          <div className="mb-4">
            <h3 className="font-semibold text-sm text-muted-foreground">
              {column.title}
            </h3>
            <p className="text-xs text-muted-foreground/70 mt-1">
              {column.statuses.reduce((sum, status) => sum + (prospectsByStatus[status]?.length || 0), 0)} prospects
            </p>
          </div>

          <div className="space-y-3 min-h-[500px] bg-muted/30 rounded-lg p-3">
            {column.statuses.flatMap(status => 
              prospectsByStatus[status]?.map(prospect => (
                <ProspectCard key={prospect.id} prospect={prospect} />
              )) || []
            )}
          </div>
        </div>
      ))}
    </div>
  );
}