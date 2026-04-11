import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { api } from '@/api/supabaseClient';
import { refetchEntityList } from '@/components/hooks/useEntityData';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertCircle } from 'lucide-react';
import { useEntityAccess } from '@/components/auth/useEntityAccess';

const INTERACTION_TYPES = [
  'Email Sent',
  'Email Received',
  'Phone Call',
  'LinkedIn Message',
  'Meeting',
  'Note Added',
  'Status Change'
];

const SENTIMENT_OPTIONS = ['Positive', 'Neutral', 'Negative'];

// Convert a Date to a local datetime-local input value (YYYY-MM-DDTHH:MM)
function toLocalDatetimeString(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function InteractionFormDialog({
  open,
  onOpenChange,
  prospect,
  entityType = 'Agent',
  entityId = null,
  onSuccess = null
}) {
  const { data: user } = useCurrentUser();
  const { canEdit, canView } = useEntityAccess('interaction_logs');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [formData, setFormData] = useState({
    interaction_type: 'Meeting',
    summary: '',
    details: '',
    sentiment: 'Neutral',
    date_time: toLocalDatetimeString(new Date())
  });

  const [errors, setErrors] = useState({});

  // Reset form state every time the dialog opens
  useEffect(() => {
    if (open) {
      setFormData({
        interaction_type: 'Meeting',
        summary: '',
        details: '',
        sentiment: 'Neutral',
        date_time: toLocalDatetimeString(new Date())
      });
      setErrors({});
      setError(null);
    }
  }, [open]);

  const validate = () => {
    const newErrors = {};
    if (!formData.interaction_type) newErrors.interaction_type = 'Type is required';
    if (!formData.summary.trim()) newErrors.summary = 'Summary is required';
    if (formData.details && formData.details.length > 2000) newErrors.details = 'Details must be 2000 characters or less';

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    setError(null);

    try {
      // Convert local datetime-local value to ISO string for storage
      const interactionDateTime = new Date(formData.date_time).toISOString();

      await api.entities.InteractionLog.create({
        entity_type: entityType || 'Agent',
        entity_id: entityId || prospect?.id,
        entity_name: prospect?.name || 'Unknown',
        interaction_type: formData.interaction_type,
        date_time: interactionDateTime,
        summary: formData.summary,
        details: formData.details,
        user_id: user?.id,
        user_name: user?.full_name,
        sentiment: formData.sentiment,
        relationship_state_at_time: prospect?.relationship_state || 'Prospecting'
      });

      // Auto-update agent's last_contacted_at using the interaction's actual time
      if (entityType === 'Agent' && (entityId || prospect?.id)) {
        api.entities.Agent.update(entityId || prospect?.id, {
          last_contacted_at: interactionDateTime,
        }).catch(() => {});
      }

      // BUG FIX: The Prospecting page uses useEntitiesData (custom cache), not
      // react-query. Invalidating react-query keys was a no-op — the interaction
      // count and list never refreshed after logging.
      await refetchEntityList('InteractionLog');
      await refetchEntityList('Agent');
      toast.success('Interaction logged');
      onOpenChange(false);
      setFormData({
        interaction_type: 'Meeting',
        summary: '',
        details: '',
        sentiment: 'Neutral',
        date_time: toLocalDatetimeString(new Date())
      });

      if (onSuccess) onSuccess();
    } catch (err) {
      console.error('Log interaction error:', err);
      toast.error(err.message || 'Failed to log interaction');
      setError(err.message || 'Failed to log interaction. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Log Interaction</DialogTitle>
          {prospect?.name && (
            <p className="text-sm text-muted-foreground">Recording interaction with {prospect.name}</p>
          )}
          {canView && !canEdit && (
            <p className="text-xs text-amber-600 dark:text-amber-400 font-medium mt-1">View only — you do not have edit access</p>
          )}
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="flex gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
              <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {/* Type & Time */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="type">Interaction Type *</Label>
              <Select
                value={formData.interaction_type}
                onValueChange={(val) => {
                  setFormData(prev => ({ ...prev, interaction_type: val }));
                  if (errors.interaction_type) setErrors(prev => ({ ...prev, interaction_type: null }));
                }}
              >
                <SelectTrigger id="type" className={errors.interaction_type ? 'border-red-500' : ''}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERACTION_TYPES.map(type => (
                    <SelectItem key={type} value={type}>{type}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.interaction_type && <p className="text-xs text-red-600 mt-1">{errors.interaction_type}</p>}
            </div>

            <div>
              <Label htmlFor="datetime">Date & Time</Label>
              <Input
                id="datetime"
                type="datetime-local"
                value={formData.date_time}
                onChange={(e) => {
                  // BUG FIX: Guard against empty/invalid date values which produce
                  // "Invalid Date" and crash toISOString().
                  if (!e.target.value) return; // guard against clearing
                  const date = new Date(e.target.value);
                  if (!isNaN(date.getTime())) {
                    setFormData(prev => ({ ...prev, date_time: e.target.value }));
                  }
                }}
              />
              <p className="text-xs text-muted-foreground mt-1">Defaults to now — change if logging a past interaction.</p>
            </div>
          </div>

          {/* Sentiment */}
          <div>
            <Label htmlFor="sentiment">Sentiment</Label>
            <Select
              value={formData.sentiment}
              onValueChange={(val) => setFormData(prev => ({ ...prev, sentiment: val }))}
            >
              <SelectTrigger id="sentiment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SENTIMENT_OPTIONS.map(sentiment => (
                  <SelectItem key={sentiment} value={sentiment}>{sentiment}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Summary */}
          <div>
            <Label htmlFor="summary">Summary *</Label>
            <Input
              id="summary"
              value={formData.summary}
              onChange={(e) => {
                setFormData(prev => ({ ...prev, summary: e.target.value }));
                if (errors.summary) setErrors(prev => ({ ...prev, summary: null }));
              }}
              className={errors.summary ? 'border-red-500' : ''}
              placeholder="Brief summary of the interaction"
            />
            {errors.summary && <p className="text-xs text-red-600 mt-1">{errors.summary}</p>}
          </div>

          {/* Details */}
          <div>
            <Label htmlFor="details">Details</Label>
            <Textarea
              id="details"
              value={formData.details}
              onChange={(e) => setFormData(prev => ({ ...prev, details: e.target.value }))}
              placeholder="Add detailed notes about this interaction..."
              rows={4}
              maxLength={2000}
            />
            {formData.details.length > 1900 && (
              <p className="text-xs text-amber-600 mt-1 tabular-nums">{2000 - formData.details.length} characters remaining</p>
            )}
          </div>

          {/* Buttons */}
          <div className="flex gap-3 justify-end pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
              title="Cancel logging interaction"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canEdit || loading} className="gap-2">
              {loading ? (
                <>
                  <span className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full"></span>
                  Logging...
                </>
              ) : (
                'Log Interaction'
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}