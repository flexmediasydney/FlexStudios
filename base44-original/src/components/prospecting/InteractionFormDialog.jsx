import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertCircle } from 'lucide-react';

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

export default function InteractionFormDialog({
  open,
  onOpenChange,
  prospect,
  entityType = 'Prospect',
  entityId = null,
  onSuccess = null
}) {
  const { data: user } = useCurrentUser();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [formData, setFormData] = useState({
    interaction_type: 'Meeting',
    summary: '',
    details: '',
    sentiment: 'Neutral',
    date_time: new Date().toISOString()
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
        date_time: new Date().toISOString()
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
      await base44.entities.InteractionLog.create({
        entity_type: entityType || 'Agent',
        entity_id: entityId || prospect?.id,
        entity_name: prospect?.name || 'Unknown',
        interaction_type: formData.interaction_type,
        date_time: formData.date_time,
        summary: formData.summary,
        details: formData.details,
        user_id: user?.id,
        user_name: user?.full_name,
        sentiment: formData.sentiment,
        relationship_state_at_time: prospect?.relationship_state || 'Prospecting'
      });

      // Auto-update agent's last_contacted_at
      if (entityType === 'Agent' && (entityId || prospect?.id)) {
        base44.entities.Agent.update(entityId || prospect?.id, {
          last_contacted_at: new Date().toISOString(),
        }).catch(() => {});
      }

      onOpenChange(false);
      setFormData({
        interaction_type: 'Meeting',
        summary: '',
        details: '',
        sentiment: 'Neutral',
        date_time: new Date().toISOString()
      });

      if (onSuccess) onSuccess();
    } catch (err) {
      setError(err.message || 'Failed to log interaction');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Log Interaction</DialogTitle>
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
                value={formData.date_time.slice(0, 16)}
                onChange={(e) => {
                  const date = new Date(e.target.value);
                  setFormData(prev => ({ ...prev, date_time: date.toISOString() }));
                }}
              />
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
              <p className="text-xs text-amber-600 mt-1">{2000 - formData.details.length} characters remaining</p>
            )}
          </div>

          {/* Buttons */}
          <div className="flex gap-3 justify-end pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading} className="gap-2">
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