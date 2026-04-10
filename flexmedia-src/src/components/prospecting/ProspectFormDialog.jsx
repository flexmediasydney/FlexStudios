import React, { useState, useMemo, useEffect } from 'react';
import { toast } from 'sonner';
import { api } from '@/api/supabaseClient';
import { refetchEntityList } from '@/components/hooks/useEntityData';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { AlertCircle } from 'lucide-react';

const STATUS_OPTIONS = [
  'New Lead', 'Researching', 'Attempted Contact', 'Discovery Call Scheduled',
  'Proposal Sent', 'Nurturing', 'Qualified', 'Unqualified', 'Converted to Client', 'Lost'
];

const VALUE_OPTIONS = ['Low', 'Medium', 'High', 'Enterprise'];
const SOURCE_OPTIONS = ['Referral', 'LinkedIn', 'Web Search', 'Event', 'Manual Import', 'Networking'];
const MEDIA_NEEDS = ['Photography', 'Video Production', 'Drone Footage', 'Virtual Staging', 'Social Media Mgmt', 'Website Design', 'Branding'];

export default function ProspectFormDialog({ open, onOpenChange, prospect = null, onSuccess = null, entityType = 'Agent' }) {
  const { data: user } = useCurrentUser();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const buildInitialFormData = () => ({
    name: prospect?.name || '',
    title: prospect?.title || '',
    email: prospect?.email || '',
    phone: prospect?.phone || '',
    current_agency_id: prospect?.current_agency_id || '',
    current_agency_name: prospect?.current_agency_name || '',
    current_team_id: prospect?.current_team_id || '',
    current_team_name: prospect?.current_team_name || '',
    relationship_state: prospect?.relationship_state || 'Prospecting',
    status: prospect?.status || 'New Lead',
    source: prospect?.source || 'Manual Import',
    value_potential: prospect?.value_potential || 'Medium',
    media_needs: prospect?.media_needs || [],
    notes: prospect?.notes || '',
    assigned_to_user_id: prospect?.assigned_to_user_id || user?.id || ''
  });

  const [formData, setFormData] = useState(buildInitialFormData);
  const [errors, setErrors] = useState({});

  // BUG FIX: Reset form state every time the dialog opens so stale data
  // from a previous edit session doesn't persist into a new create/edit.
  useEffect(() => {
    if (open) {
      setFormData(buildInitialFormData());
      setErrors({});
      setError(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prospect?.id]);

  // Validation
  const validate = () => {
    const newErrors = {};
    if (!formData.name.trim()) newErrors.name = 'Name is required';
    if (formData.name.trim().length > 120) newErrors.name = 'Name must be 120 characters or less';
    // BUG FIX: Only require email format when email is provided.
    // Previously, empty email AND invalid-format were separate checks that
    // could overwrite each other, and empty email was always flagged even for
    // prospects where email isn't known yet.
    if (formData.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Invalid email format';
    }
    if (formData.phone.trim() && !/^[+\d\s\-().]{5,30}$/.test(formData.phone)) {
      newErrors.phone = 'Enter a valid phone number';
    }
    if (!formData.current_agency_name.trim()) newErrors.current_agency_name = 'Agency name is required';

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    setError(null);

    try {
      if (prospect) {
        await api.entities[entityType].update(prospect.id, formData);
      } else {
        const result = await api.entities[entityType].create(formData);
        
        // Auto-log creation as interaction (agents only)
        if (entityType === 'Agent') {
          await api.entities.InteractionLog.create({
            entity_type: 'Agent',
            entity_id: result?.id || null,
            entity_name: formData.name,
            interaction_type: 'Status Change',
            date_time: new Date().toISOString(),
            summary: `Agent added to system`,
            details: `Initial source: ${formData.source}`,
            user_id: user?.id,
            user_name: user?.full_name,
            sentiment: 'Neutral',
            relationship_state_at_time: 'Prospecting'
          });
        }
      }

      // BUG FIX: The Prospecting page uses useEntitiesData (custom cache), not
      // react-query. Invalidating react-query keys ['agents'] / ['prospects'] was
      // a no-op — the list never refreshed after create/edit.
      await refetchEntityList(entityType);
      await refetchEntityList('InteractionLog');
      toast.success(prospect ? `${entityType} updated` : `${entityType} created`);
      onOpenChange(false);
      if (onSuccess) onSuccess();
    } catch (err) {
      console.error('Save agent error:', err);
      toast.error(err.message || 'Failed to save agent');
      setError(err.message || 'Failed to save agent');
    } finally {
      setLoading(false);
    }
  };

  const toggleMediaNeed = (need) => {
    setFormData(prev => ({
      ...prev,
      media_needs: prev.media_needs.includes(need)
        ? prev.media_needs.filter(m => m !== need)
        : [...prev.media_needs, need]
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{prospect ? `Edit ${entityType}` : `Add New ${entityType}`}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="flex gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
              <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {/* Basic Info */}
          <div>
            <h3 className="font-semibold text-sm mb-4">Basic Information</h3>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => {
                      setFormData(prev => ({ ...prev, name: e.target.value }));
                      if (errors.name) setErrors(prev => ({ ...prev, name: null }));
                    }}
                    maxLength={120}
                    className={errors.name ? 'border-red-500' : ''}
                    placeholder="Full name"
                  />
                  {errors.name && <p className="text-xs text-red-600 mt-1">{errors.name}</p>}
                </div>

                <div>
                  <Label htmlFor="title">Job Title</Label>
                  <Input
                    id="title"
                    value={formData.title}
                    onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                    placeholder="e.g., Marketing Director"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => {
                      setFormData(prev => ({ ...prev, email: e.target.value }));
                      if (errors.email) setErrors(prev => ({ ...prev, email: null }));
                    }}
                    maxLength={100}
                    className={errors.email ? 'border-red-500' : ''}
                    placeholder="name@company.com"
                  />
                  {errors.email && <p className="text-xs text-red-600 mt-1">{errors.email}</p>}
                </div>

                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => {
                      setFormData(prev => ({ ...prev, phone: e.target.value }));
                      if (errors.phone) setErrors(prev => ({ ...prev, phone: null }));
                    }}
                    maxLength={30}
                    className={errors.phone ? 'border-red-500' : ''}
                    placeholder="+61 2 1234 5678"
                  />
                  {errors.phone && <p className="text-xs text-red-600 mt-1">{errors.phone}</p>}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="agency">Agency Name *</Label>
                  <Input
                    id="agency"
                    value={formData.current_agency_name}
                    onChange={(e) => {
                      setFormData(prev => ({ ...prev, current_agency_name: e.target.value }));
                      if (errors.current_agency_name) setErrors(prev => ({ ...prev, current_agency_name: null }));
                    }}
                    className={errors.current_agency_name ? 'border-red-500' : ''}
                    placeholder="Agency name"
                  />
                  {errors.current_agency_name && <p className="text-xs text-red-600 mt-1">{errors.current_agency_name}</p>}
                </div>

                <div>
                  <Label htmlFor="team">Team Name</Label>
                  <Input
                    id="team"
                    value={formData.current_team_name}
                    onChange={(e) => setFormData(prev => ({ ...prev, current_team_name: e.target.value }))}
                    placeholder="Team name"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Status & Qualification */}
          <div>
            <h3 className="font-semibold text-sm mb-4">Status & Qualification</h3>
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label htmlFor="status">Status</Label>
                  <Select value={formData.status} onValueChange={(val) => setFormData(prev => ({ ...prev, status: val }))}>
                    <SelectTrigger id="status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map(status => (
                        <SelectItem key={status} value={status}>{status}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="value">Value Potential</Label>
                  <Select value={formData.value_potential} onValueChange={(val) => setFormData(prev => ({ ...prev, value_potential: val }))}>
                    <SelectTrigger id="value">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VALUE_OPTIONS.map(val => (
                        <SelectItem key={val} value={val}>{val}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="source">Source</Label>
                  <Select value={formData.source} onValueChange={(val) => setFormData(prev => ({ ...prev, source: val }))}>
                    <SelectTrigger id="source">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SOURCE_OPTIONS.map(src => (
                        <SelectItem key={src} value={src}>{src}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </div>

          {/* Media Needs */}
          <div>
            <h3 className="font-semibold text-sm mb-4">Media Needs</h3>
            <div className="grid grid-cols-2 gap-3">
              {MEDIA_NEEDS.map(need => (
                <label key={need} className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={formData.media_needs.includes(need)}
                    onChange={() => toggleMediaNeed(need)}
                    className="rounded"
                  />
                  <span className="text-sm">{need}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div>
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={formData.notes}
              onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Add any relevant notes about this prospect..."
              maxLength={2000}
              rows={3}
            />
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
            <Button
              type="submit"
              disabled={loading || !formData.name?.trim() || !formData.current_agency_name?.trim()}
              className="gap-2"
            >
              {loading ? (
                <>
                  <span className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full"></span>
                  Saving...
                </>
              ) : (
                prospect ? 'Update Agent' : 'Create Agent'
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}