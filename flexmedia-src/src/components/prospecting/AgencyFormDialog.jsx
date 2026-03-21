import React, { useState } from 'react';
import { api } from '@/api/supabaseClient';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { AlertCircle } from 'lucide-react';

export default function AgencyFormDialog({ open, onOpenChange, agency = null, onSuccess = null }) {
  const { data: user } = useCurrentUser();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  const [formData, setFormData] = useState({
    name: agency?.name || '',
    relationship_state: agency?.relationship_state || 'Prospecting',
    email: agency?.email || '',
    phone: agency?.phone || '',
    address: agency?.address || '',
    notes: agency?.notes || '',
    onboarding_date: agency?.onboarding_date || '',
    became_active_date: agency?.became_active_date || '',
    became_dormant_date: agency?.became_dormant_date || '',
    pricing_agreement: agency?.pricing_agreement || '',
    pricing_notes: agency?.pricing_notes || '',
    floorplan_template: agency?.floorplan_template || '',
    branding_notes: agency?.branding_notes || '',
    drone_template: agency?.drone_template || '',
    drone_branding_notes: agency?.drone_branding_notes || '',
    video_branding: agency?.video_branding || '',
    video_music_preference: agency?.video_music_preference || '',
    video_branding_notes: agency?.video_branding_notes || '',
    primary_marketing_contact: agency?.primary_marketing_contact || '',
    primary_accounts_contact: agency?.primary_accounts_contact || '',
    primary_partner: agency?.primary_partner || '',
    whatsapp_group_chat: agency?.whatsapp_group_chat || ''
  });

  const [errors, setErrors] = useState({});

  const validate = () => {
    const newErrors = {};
    if (!formData.name.trim()) newErrors.name = 'Agency name is required';
    if (formData.name.trim().length > 120) newErrors.name = 'Name must be 120 characters or less';
    if (formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) newErrors.email = 'Enter a valid email address';
    if (formData.phone && !/^[+\d\s\-().]{5,30}$/.test(formData.phone)) newErrors.phone = 'Enter a valid phone number';
    if (formData.whatsapp_group_chat && formData.whatsapp_group_chat.trim() && !/^https?:\/\/.+/.test(formData.whatsapp_group_chat)) newErrors.whatsapp_group_chat = 'URL must start with http:// or https://';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    setError(null);

    try {
      if (agency) {
        await api.entities.Agency.update(agency.id, formData);
      } else {
        const result = await api.entities.Agency.create(formData);
        
        // Auto-log creation as interaction
        await api.entities.InteractionLog.create({
          entity_type: 'Agency',
          entity_id: result?.id || null,
          entity_name: formData.name,
          interaction_type: 'Status Change',
          date_time: new Date().toISOString(),
          summary: `Agency added to system`,
          details: `Relationship state: ${formData.relationship_state}`,
          user_id: user?.id,
          user_name: user?.full_name,
          sentiment: 'Neutral',
          relationship_state_at_time: formData.relationship_state
        });
      }

      onOpenChange(false);
      if (onSuccess) onSuccess();
    } catch (err) {
      setError(err.message || 'Failed to save agency');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{agency ? 'Edit Agency' : 'Add New Agency'}</DialogTitle>
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
              <div>
                <Label htmlFor="name">Agency Name *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => {
                    setFormData(prev => ({ ...prev, name: e.target.value }));
                    if (errors.name) setErrors(prev => ({ ...prev, name: null }));
                  }}
                  className={errors.name ? 'border-red-500' : ''}
                  placeholder="Agency name"
                />
                {errors.name && <p className="text-xs text-red-600 mt-1">{errors.name}</p>}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                    placeholder="contact@agency.com"
                  />
                </div>
                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                    placeholder="+61 2 1234 5678"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="address">Address</Label>
                <Input
                  id="address"
                  value={formData.address}
                  onChange={(e) => setFormData(prev => ({ ...prev, address: e.target.value }))}
                  placeholder="Street address"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="state">Relationship State</Label>
                  <Select value={formData.relationship_state} onValueChange={(val) => setFormData(prev => ({ ...prev, relationship_state: val }))}>
                    <SelectTrigger id="state">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Prospecting">Prospecting</SelectItem>
                      <SelectItem value="Active">Active</SelectItem>
                      <SelectItem value="Dormant">Dormant</SelectItem>
                      <SelectItem value="Do Not Contact">Do Not Contact</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="onboarding">Onboarding Date</Label>
                  <Input
                    id="onboarding"
                    type="date"
                    value={formData.onboarding_date}
                    onChange={(e) => setFormData(prev => ({ ...prev, onboarding_date: e.target.value }))}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Contact People */}
          <div>
            <h3 className="font-semibold text-sm mb-4">Key Contacts</h3>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="marketing">Primary Marketing Contact</Label>
                  <Input
                    id="marketing"
                    value={formData.primary_marketing_contact}
                    onChange={(e) => setFormData(prev => ({ ...prev, primary_marketing_contact: e.target.value }))}
                    placeholder="Contact name or email"
                  />
                </div>
                <div>
                  <Label htmlFor="accounts">Primary Accounts Contact</Label>
                  <Input
                    id="accounts"
                    value={formData.primary_accounts_contact}
                    onChange={(e) => setFormData(prev => ({ ...prev, primary_accounts_contact: e.target.value }))}
                    placeholder="Contact name or email"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="partner">Primary Partner</Label>
                <Input
                  id="partner"
                  value={formData.primary_partner}
                  onChange={(e) => setFormData(prev => ({ ...prev, primary_partner: e.target.value }))}
                  placeholder="Partner name"
                />
              </div>

              <div>
                <Label htmlFor="whatsapp">WhatsApp Group Chat</Label>
                <Input
                  id="whatsapp"
                  value={formData.whatsapp_group_chat}
                  onChange={(e) => setFormData(prev => ({ ...prev, whatsapp_group_chat: e.target.value }))}
                  placeholder="https://chat.whatsapp.com/..."
                />
              </div>
            </div>
          </div>

          {/* Branding & Templates */}
          <div>
            <h3 className="font-semibold text-sm mb-4">Branding & Templates</h3>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="floorplan">Floorplan Template Link</Label>
                  <Input
                    id="floorplan"
                    value={formData.floorplan_template}
                    onChange={(e) => setFormData(prev => ({ ...prev, floorplan_template: e.target.value }))}
                    placeholder="https://..."
                  />
                </div>
                <div>
                  <Label htmlFor="branding_notes">Branding Notes</Label>
                  <Input
                    id="branding_notes"
                    value={formData.branding_notes}
                    onChange={(e) => setFormData(prev => ({ ...prev, branding_notes: e.target.value }))}
                    placeholder="Special branding requirements"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="drone">Drone Template Link</Label>
                  <Input
                    id="drone"
                    value={formData.drone_template}
                    onChange={(e) => setFormData(prev => ({ ...prev, drone_template: e.target.value }))}
                    placeholder="https://..."
                  />
                </div>
                <div>
                  <Label htmlFor="drone_notes">Drone Branding Notes</Label>
                  <Input
                    id="drone_notes"
                    value={formData.drone_branding_notes}
                    onChange={(e) => setFormData(prev => ({ ...prev, drone_branding_notes: e.target.value }))}
                    placeholder="Drone footage requirements"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="video">Video Branding</Label>
                  <Input
                    id="video"
                    value={formData.video_branding}
                    onChange={(e) => setFormData(prev => ({ ...prev, video_branding: e.target.value }))}
                    placeholder="https://..."
                  />
                </div>
                <div>
                  <Label htmlFor="music">Video Music Preference</Label>
                  <Input
                    id="music"
                    value={formData.video_music_preference}
                    onChange={(e) => setFormData(prev => ({ ...prev, video_music_preference: e.target.value }))}
                    placeholder="Preferred music style or playlist"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="video_notes">Video Branding Notes</Label>
                <Textarea
                  id="video_notes"
                  value={formData.video_branding_notes}
                  onChange={(e) => setFormData(prev => ({ ...prev, video_branding_notes: e.target.value }))}
                  placeholder="Video requirements and preferences"
                  rows={2}
                />
              </div>
            </div>
          </div>

          {/* Pricing & Agreements */}
          <div>
            <h3 className="font-semibold text-sm mb-4">Pricing & Agreements</h3>
            <div className="space-y-4">
              <div>
                <Label htmlFor="pricing_agreement">Pricing Agreement Link</Label>
                <Input
                  id="pricing_agreement"
                  value={formData.pricing_agreement}
                  onChange={(e) => setFormData(prev => ({ ...prev, pricing_agreement: e.target.value }))}
                  placeholder="https://..."
                />
              </div>

              <div>
                <Label htmlFor="pricing_notes">Pricing Notes</Label>
                <Textarea
                  id="pricing_notes"
                  value={formData.pricing_notes}
                  onChange={(e) => setFormData(prev => ({ ...prev, pricing_notes: e.target.value }))}
                  placeholder="Special pricing terms, volume discounts, etc."
                  rows={2}
                />
              </div>
            </div>
          </div>

          {/* Notes */}
          <div>
            <Label htmlFor="notes">General Notes</Label>
            <Textarea
              id="notes"
              value={formData.notes}
              onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Add any additional notes about this agency..."
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
              disabled={loading}
              className="gap-2"
            >
              {loading ? (
                <>
                  <span className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full"></span>
                  Saving...
                </>
              ) : (
                agency ? 'Update Agency' : 'Create Agency'
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}