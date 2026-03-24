import React, { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { api } from '@/api/supabaseClient';
import { refetchEntityList } from '@/components/hooks/useEntityData';
import { toast } from 'sonner';

const statusConfig = {
  'New Lead': { color: 'bg-blue-100', badge: 'bg-blue-200 text-blue-800' },
  'Researching': { color: 'bg-indigo-100', badge: 'bg-indigo-200 text-indigo-800' },
  'Attempted Contact': { color: 'bg-purple-100', badge: 'bg-purple-200 text-purple-800' },
  'Discovery Call Scheduled': { color: 'bg-pink-100', badge: 'bg-pink-200 text-pink-800' },
  'Proposal Sent': { color: 'bg-rose-100', badge: 'bg-rose-200 text-rose-800' },
  'Nurturing': { color: 'bg-amber-100', badge: 'bg-amber-200 text-amber-800' },
  'Qualified': { color: 'bg-green-100', badge: 'bg-green-200 text-green-800' },
  'Unqualified': { color: 'bg-red-100', badge: 'bg-red-200 text-red-800' },
  'Converted to Client': { color: 'bg-emerald-100', badge: 'bg-emerald-200 text-emerald-800' },
  'Lost': { color: 'bg-gray-100', badge: 'bg-gray-200 text-gray-800' }
};

export default function ProspectingStatusKanban({ agentsByStatus }) {
  const navigate = useNavigate();
  const statuses = Object.keys(statusConfig);
  const [draggedAgent, setDraggedAgent] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const handleAgentClick = (agent) => {
    navigate(createPageUrl('PersonDetails') + '?id=' + agent.id);
  };

  // BUG FIX: Added drag-and-drop support so agent cards can be moved between
  // prospecting statuses. Previously, the kanban was read-only.
  const handleDragStart = (e, agent) => {
    setDraggedAgent(agent);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', agent.id);
  };

  const handleDragOver = (e, status) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(status);
  };

  const handleDragLeave = () => {
    setDropTarget(null);
  };

  const handleDrop = async (e, targetStatus) => {
    e.preventDefault();
    setDropTarget(null);

    if (!draggedAgent || draggedAgent.status === targetStatus) {
      setDraggedAgent(null);
      return;
    }

    try {
      await api.entities.Agent.update(draggedAgent.id, {
        status: targetStatus
      });
      await refetchEntityList('Agent');
      toast.success(`${draggedAgent.name} moved to ${targetStatus}`);
    } catch (err) {
      toast.error(err.message || 'Failed to update status');
    }
    setDraggedAgent(null);
  };

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {statuses.map((status) => {
        const agents = agentsByStatus[status] || [];
        const config = statusConfig[status];
        const isDropTarget = dropTarget === status;

        return (
          <div key={status} className="flex-shrink-0 w-72">
            <div className={`${config.color} rounded-t-lg px-3 py-2`}>
              <h3 className="font-semibold text-xs flex items-center justify-between">
                <span className="truncate">{status}</span>
                <Badge className={config.badge}>{agents.length}</Badge>
              </h3>
            </div>

            <div
              className={`bg-muted/30 rounded-b-lg min-h-[400px] p-2 space-y-1.5 overflow-y-auto transition-colors ${
                isDropTarget ? 'ring-2 ring-primary/40 bg-primary/5' : ''
              }`}
              onDragOver={(e) => handleDragOver(e, status)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, status)}
            >
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className="bg-card rounded-lg p-2 border border-border/50 hover:shadow-md transition-all cursor-grab active:cursor-grabbing text-xs"
                  draggable
                  onDragStart={(e) => handleDragStart(e, agent)}
                  onClick={() => handleAgentClick(agent)}
                >
                  <p className="font-medium truncate">{agent.name}</p>
                  <p className="text-muted-foreground truncate">{agent.email}</p>
                  {agent.interactionCount > 0 && (
                    <p className="text-primary mt-0.5">{agent.interactionCount} interactions</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
