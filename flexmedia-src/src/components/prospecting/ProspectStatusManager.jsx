import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';

const STATUS_OPTIONS = [
  'New Lead',
  'Researching',
  'Attempted Contact',
  'Discovery Call Scheduled',
  'Proposal Sent',
  'Nurturing',
  'Qualified',
  'Unqualified',
  'Converted to Client',
  'Lost'
];

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

export default function ProspectStatusManager({ prospect }) {
  const { data: user } = useCurrentUser();
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleStatusChange = async (newStatus) => {
    if (newStatus === prospect.status) {
      setIsOpen(false);
      return;
    }

    setLoading(true);

    try {
      // Update agent status
      await base44.entities.Agent.update(prospect.id, {
        status: newStatus
      });

      // Log interaction for status change
       await base44.entities.InteractionLog.create({
         entity_type: 'Agent',
         entity_id: prospect.id,
         entity_name: prospect.name,
         interaction_type: 'Status Change',
         date_time: new Date().toISOString(),
         summary: `Status changed from ${prospect.status} to ${newStatus}`,
         user_id: user?.id,
         user_name: user?.full_name,
         sentiment: 'Neutral',
         relationship_state_at_time: prospect.relationship_state || 'Prospecting'
       });

       // Create audit log for status change
       await base44.entities.AuditLog.create({
         entity_type: "agent",
         entity_id: prospect.id,
         entity_name: prospect.name,
         action: "update",
         changed_fields: [{ field: "status", old_value: prospect.status || "", new_value: newStatus }],
         previous_state: prospect,
         new_state: { ...prospect, status: newStatus },
         user_name: user?.full_name,
         user_email: user?.email
       }).catch(() => {}); // non-fatal

       // Auto-transition relationship_state when converted to client
       if (newStatus === 'Converted to Client' && prospect.relationship_state !== 'Active') {
         await base44.entities.Agent.update(prospect.id, {
           relationship_state: 'Active',
           became_active_date: new Date().toISOString().split('T')[0],
           is_at_risk: false,
         });
         toast.success(`${prospect.name} is now an Active client`);
       } else {
         toast.success('Status updated');
       }

       setIsOpen(false);
      } catch (err) {
       toast.error(err?.message || 'Failed to update status');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative">
      <Button
        variant="outline"
        onClick={() => setIsOpen(!isOpen)}
        disabled={loading}
        className={`min-w-[180px] justify-start ${STATUS_COLORS[prospect.status]}`}
      >
        {prospect.status}
      </Button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown */}
          <div className="absolute top-full right-0 mt-2 bg-card border rounded-lg shadow-lg z-50 min-w-[200px]">
            <div className="p-2 space-y-1 max-h-80 overflow-y-auto">
              {STATUS_OPTIONS.map(status => (
                <button
                  key={status}
                  onClick={() => handleStatusChange(status)}
                  disabled={loading}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                    prospect.status === status
                      ? `${STATUS_COLORS[status]} font-semibold`
                      : 'hover:bg-muted text-foreground'
                  } disabled:opacity-50`}
                >
                  {status}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}