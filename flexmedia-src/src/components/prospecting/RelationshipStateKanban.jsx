import React, { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Building2, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { api } from '@/api/supabaseClient';
import { refetchEntityList } from '@/components/hooks/useEntityData';
import { toast } from 'sonner';

const stateConfig = {
  'Prospecting': { color: 'bg-orange-100', textColor: 'text-orange-900', badge: 'bg-orange-200 text-orange-800' },
  'Active': { color: 'bg-green-100', textColor: 'text-green-900', badge: 'bg-green-200 text-green-800' },
  'Dormant': { color: 'bg-muted', textColor: 'text-foreground', badge: 'bg-gray-200 text-foreground' },
  'Do Not Contact': { color: 'bg-red-100', textColor: 'text-red-900', badge: 'bg-red-200 text-red-800' }
};

export default function RelationshipStateKanban({ entitiesByState, onDrillDown }) {
  const navigate = useNavigate();
  const [draggedEntity, setDraggedEntity] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const handleEntityClick = (entity) => {
    const pageMap = {
      'Agent': 'PersonDetails',
      'Agency': 'OrgDetails'
    };
    navigate(createPageUrl(pageMap[entity.entity_type]) + '?id=' + entity.id);
  };

  // BUG FIX: Added drag-and-drop support so cards can be moved between
  // relationship states. Previously, the kanban was read-only — dragging
  // cards did nothing.
  const handleDragStart = (e, entity) => {
    setDraggedEntity(entity);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', entity.id);
  };

  const handleDragOver = (e, state) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(state);
  };

  const handleDragLeave = () => {
    setDropTarget(null);
  };

  const handleDrop = async (e, targetState) => {
    e.preventDefault();
    setDropTarget(null);

    if (!draggedEntity || draggedEntity.relationship_state === targetState) {
      setDraggedEntity(null);
      return;
    }

    const entityType = draggedEntity.entity_type; // 'Agent' or 'Agency'
    try {
      await api.entities[entityType].update(draggedEntity.id, {
        relationship_state: targetState
      });
      await refetchEntityList(entityType);
      toast.success(`${draggedEntity.name} moved to ${targetState}`);
    } catch (err) {
      toast.error(err.message || 'Failed to update relationship state');
    }
    setDraggedEntity(null);
  };

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {Object.entries(stateConfig).map(([state, config]) => {
        const entities = entitiesByState[state] || [];
        const isDropTarget = dropTarget === state;

        return (
          <div key={state} className="flex-shrink-0 w-80">
            <div className={`${config.color} rounded-t-lg px-4 py-2.5`}>
              <h3 className="font-semibold text-sm flex items-center justify-between">
                {state}
                <Badge className={config.badge}>{entities.length}</Badge>
              </h3>
            </div>

            <div
              className={`bg-muted/30 rounded-b-lg min-h-[400px] p-3 space-y-2 overflow-y-auto transition-colors ${
                isDropTarget ? 'ring-2 ring-primary/40 bg-primary/5' : ''
              }`}
              onDragOver={(e) => handleDragOver(e, state)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, state)}
            >
              {entities.map((entity) => {
                const Icon = entity.entity_type === 'Agency' ? Building2 : Users;
                return (
                  <div
                    key={entity.id}
                    className="bg-card rounded-lg p-2.5 border border-border/50 hover:shadow-md transition-all cursor-grab active:cursor-grabbing"
                    draggable
                    onDragStart={(e) => handleDragStart(e, entity)}
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
                          <p className="text-xs text-primary mt-0.5">{entity.interactionCount} interactions</p>
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
