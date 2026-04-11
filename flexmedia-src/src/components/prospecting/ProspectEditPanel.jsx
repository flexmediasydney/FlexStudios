import React, { useState } from 'react';
import { api } from '@/api/supabaseClient';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

const SOURCE_OPTIONS = ['Referral', 'LinkedIn', 'Web Search', 'Event', 'Manual Import', 'Networking'];
const VALUE_OPTIONS = ['Low', 'Medium', 'High', 'Enterprise'];
const MEDIA_NEEDS = ['Photography', 'Video Production', 'Drone Footage', 'Virtual Staging', 'Social Media Mgmt', 'Website Design', 'Branding'];

export default function ProspectEditPanel({ prospect }) {
  const { data: user } = useCurrentUser();
  const [formData, setFormData] = useState({
    name: prospect.name,
    title: prospect.title || '',
    email: prospect.email,
    phone: prospect.phone || '',
    current_agency_name: prospect.current_agency_name,
    current_team_name: prospect.current_team_name || '',
    source: prospect.source || 'Manual Import',
    value_potential: prospect.value_potential || 'Medium',
    media_needs: prospect.media_needs || [],
    notes: prospect.notes || ''
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      // Track changed fields for audit log
      const changedFields = [];
      Object.keys(formData).forEach(key => {
        if (formData[key] !== prospect[key]) {
          changedFields.push({
            field: key,
            old_value: prospect[key] || "",
            new_value: formData[key] || ""
          });
        }
      });

      const result = await api.entities.Agent.update(prospect.id, formData);

      // Create audit log
      if (changedFields.length > 0) {
        await api.entities.AuditLog.create({
          entity_type: "agent",
          entity_id: prospect.id,
          entity_name: formData.name || prospect.name,
          action: "update",
          changed_fields: changedFields,
          previous_state: prospect,
          new_state: result,
          user_name: user?.full_name,
          user_email: user?.email
        }).catch(() => {}); // non-fatal
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      console.error('Update agent error:', err);
      setError('Failed to save changes. Please try again.');
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
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="flex gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {success && (
        <div className="flex gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
          <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-green-800">Changes saved successfully</p>
        </div>
      )}

      {/* Basic Info */}
      <div>
        <h3 className="font-semibold mb-4">Basic Information</h3>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="title">Job Title</Label>
              <Input
                id="title"
                value={formData.title}
                onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
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
                onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                type="tel"
                value={formData.phone}
                onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="agency">Agency Name</Label>
              <Input
                id="agency"
                value={formData.current_agency_name}
                onChange={(e) => setFormData(prev => ({ ...prev, current_agency_name: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="team">Team Name</Label>
              <Input
                id="team"
                value={formData.current_team_name}
                onChange={(e) => setFormData(prev => ({ ...prev, current_team_name: e.target.value }))}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Qualification */}
      <div>
        <h3 className="font-semibold mb-4">Qualification</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="value">Value Potential</Label>
            <Select
              value={formData.value_potential}
              onValueChange={(val) => setFormData(prev => ({ ...prev, value_potential: val }))}
            >
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
            <Select
              value={formData.source}
              onValueChange={(val) => setFormData(prev => ({ ...prev, source: val }))}
            >
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

      {/* Media Needs */}
      <div>
        <h3 className="font-semibold mb-4">Media Needs</h3>
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
          rows={4}
        />
      </div>

      <div className="flex gap-3 pt-4 border-t">
        <Button
          type="submit"
          disabled={loading}
          className="gap-2"
        >
          {loading ? (
            <>
              <span className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full"></span>
              Saving...
            </>
          ) : (
            'Save Changes'
          )}
        </Button>
      </div>
    </form>
  );
}