import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Building2, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';

const stateConfig = {
  'Prospecting': { color: 'bg-orange-100', textColor: 'text-orange-900', badge: 'bg-orange-200 text-orange-800' },
  'Active': { color: 'bg-green-100', textColor: 'text-green-900', badge: 'bg-green-200 text-green-800' },
  'Dormant': { color: 'bg-gray-100', textColor: 'text-gray-900', badge: 'bg-gray-200 text-gray-800' },
  'Do Not Contact': { color: 'bg-red-100', textColor: 'text-red-900', badge: 'bg-red-200 text-red-800' }
};

export default function RelationshipStateKanban({ entitiesByState, onDrillDown }) {
  const navigate = useNavigate();

  const handleEntityClick = (entity) => {
    const pageMap = {
      'Agent': 'PersonDetails',
      'Agency': 'OrgDetails'
    };
    navigate(createPageUrl(pageMap[entity.entity_type]) + '?id=' + entity.id);
  };

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {Object.entries(stateConfig).map(([state, config]) => {
        const entities = entitiesByState[state] || [];
        
        return (
          <div key={state} className="flex-shrink-0 w-80">
            <div className={`${config.color} rounded-t-lg px-4 py-2.5`}>
              <h3 className="font-semibold text-sm flex items-center justify-between">
                {state}
                <Badge className={config.badge}>{entities.length}</Badge>
              </h3>
            </div>
            
            <div className="bg-muted/30 rounded-b-lg min-h-[400px] p-3 space-y-2 overflow-y-auto">
              {entities.map((entity) => {
                const Icon = entity.entity_type === 'Agency' ? Building2 : Users;
                return (
                  <div 
                    key={entity.id} 
                    className="bg-white rounded-lg p-2.5 border border-border/50 hover:shadow-md transition-all cursor-pointer"
                    onClick={() => handleEntityClick(entity)}
                  >
                    <div className="flex items-start gap-2">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm truncate">{entity.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {entity.email || entity.current_agency_name}
                        </p>
                        {entity.interactionCount > 0 && (
                          <p className="text-xs text-primary mt-0.5">{entity.interactionCount} 📞</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              
              {state === 'Prospecting' && entities.some(e => e.entity_type === 'Agent') && entities.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full mt-3"
                  onClick={() => onDrillDown('Prospecting')}
                >
                  View Pipeline
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}