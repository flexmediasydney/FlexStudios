import React, { useState, useEffect } from 'react';
import { api } from '@/api/supabaseClient';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { AlertCircle, CheckCircle2, Loader2, Upload, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { refetchEntityList } from '@/components/hooks/useEntityData';

export default function AgencyDetailsEditor({ agency, onSave, products = [] }) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  
  // Fetch all categories with real-time sync
  const { data: allCategories = [] } = useQuery({
    queryKey: ['productCategories'],
    queryFn: () => api.entities.ProductCategory.list(),
    staleTime: 30000 // 30s cache
  });

  useEffect(() => {
    const unsubscribe = api.entities.ProductCategory.subscribe((event) => {
      // Force refetch on any category change
      queryClient.invalidateQueries({ queryKey: ['productCategories'] });
      refetchEntityList("ProductCategory");
    });
    return unsubscribe;
  }, []);

  const [formData, setFormData] = useState({
    pricing_agreement: agency?.pricing_agreement || '',
    pricing_notes: agency?.pricing_notes || '',
    floorplan_enabled: agency?.floorplan_enabled || false,
    floorplan_template: agency?.floorplan_template || '',
    floorplan_notes: agency?.floorplan_notes || '',
    floorplan_reference: agency?.floorplan_reference || '',
    floorplan_product_category: agency?.floorplan_product_category || '',
    images_branding_enabled: agency?.images_branding_enabled || false,
    images_logo_reference: agency?.images_logo_reference || '',
    images_logo_location: agency?.images_logo_location || '',
    drone_template: agency?.drone_template || '',
    drone_product_category: agency?.drone_product_category || '',
    drone_branding_notes: agency?.drone_branding_notes || '',
    drone_template_link: agency?.drone_template_link || '',
    video_branding: agency?.video_branding || '',
    video_product_category: agency?.video_product_category || '',
    video_music_preference: agency?.video_music_preference || '',
    video_branding_notes: agency?.video_branding_notes || '',
    agency_branding_link: agency?.agency_branding_link || '',
    images_logo_watermark: agency?.images_logo_watermark || '',
    images_product_category: agency?.images_product_category || '',
    primary_marketing_contact: agency?.primary_marketing_contact || '',
    primary_accounts_contact: agency?.primary_accounts_contact || '',
    primary_partner: agency?.primary_partner || ''
  });

  const [uploading, setUploading] = useState(false);

  const updateField = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleUploadFile = async (e, fieldName, successMsg) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const { file_url } = await api.integrations.Core.UploadFile({ file });
      updateField(fieldName, file_url);
      setMessage({ type: 'success', text: successMsg });
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to upload file' });
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await api.entities.Agency.update(agency.id, formData);
      setMessage({ type: 'success', text: 'Details saved successfully' });
      onSave?.();
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to save details' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {message && (
        <div className={`flex gap-3 p-4 rounded-lg border ${
          message.type === 'success' 
            ? 'bg-green-50 border-green-200' 
            : 'bg-red-50 border-red-200'
        }`}>
          {message.type === 'success' ? (
            <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0" />
          ) : (
            <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
          )}
          <p className={`text-sm ${message.type === 'success' ? 'text-green-800' : 'text-red-800'}`}>
            {message.text}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* Floorplan Branding */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Floorplan Branding</CardTitle>
              <Switch
                checked={formData.floorplan_enabled}
                onCheckedChange={(val) => updateField('floorplan_enabled', val)}
              />
            </div>
          </CardHeader>
          {formData.floorplan_enabled && (
            <CardContent className="space-y-4">
              <div>
                <Label className="text-sm mb-2 block">Template Name</Label>
                <Input
                  placeholder="Name of template"
                  value={formData.floorplan_template}
                  onChange={(e) => updateField('floorplan_template', e.target.value)}
                />
              </div>
              <div>
                <Label className="text-sm mb-2 block">Floorplan Notes</Label>
                <Textarea
                  placeholder="Notes about floorplan branding..."
                  value={formData.floorplan_notes}
                  onChange={(e) => updateField('floorplan_notes', e.target.value)}
                  className="h-20"
                />
              </div>
              <div>
                <Label className="text-sm mb-2 block">Floorplan Reference</Label>
                <div className="border-2 border-dashed rounded-lg p-4 text-center">
                  {formData.floorplan_reference ? (
                    <div className="space-y-2">
                      <img src={formData.floorplan_reference} alt="Floorplan" className="max-h-24 mx-auto" />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => updateField('floorplan_reference', '')}
                        className="gap-2"
                      >
                        <X className="h-4 w-4" />
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <label className="cursor-pointer">
                      <div className="flex flex-col items-center gap-2">
                        <Upload className="h-5 w-5 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">Click to upload floorplan</span>
                      </div>
                      <input
                        type="file"
                        className="hidden"
                        accept="image/*,.pdf"
                        onChange={(e) => handleUploadFile(e, 'floorplan_reference', 'Floorplan uploaded successfully')}
                        disabled={uploading}
                      />
                    </label>
                  )}
                </div>
              </div>
              <div>
                <Label className="text-xs mb-1 block text-muted-foreground">Product Category (optional)</Label>
                <Select value={formData.floorplan_product_category || '__none__'} onValueChange={(val) => updateField('floorplan_product_category', val === '__none__' ? '' : val)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="All categories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">All categories</SelectItem>
                    {allCategories.map(cat => (
                      <SelectItem key={cat.id} value={cat.name}>{cat.icon} {cat.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          )}
        </Card>

        {/* Photography - Images */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Photography - Images</CardTitle>
              <Switch
                checked={formData.images_branding_enabled}
                onCheckedChange={(val) => updateField('images_branding_enabled', val)}
              />
            </div>
          </CardHeader>
          {formData.images_branding_enabled && (
            <CardContent className="space-y-4">
              <div>
                <Label className="text-sm mb-2 block">Logo Reference</Label>
                <div className="border-2 border-dashed rounded-lg p-4 text-center">
                  {formData.images_logo_reference ? (
                    <div className="space-y-2">
                      <img src={formData.images_logo_reference} alt="Logo" className="max-h-24 mx-auto" />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => updateField('images_logo_reference', '')}
                        className="gap-2"
                      >
                        <X className="h-4 w-4" />
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <label className="cursor-pointer">
                      <div className="flex flex-col items-center gap-2">
                        <Upload className="h-5 w-5 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">Click to upload logo</span>
                      </div>
                      <input
                        type="file"
                        className="hidden"
                        accept="image/*"
                        onChange={(e) => handleUploadFile(e, 'images_logo_reference', 'Logo uploaded successfully')}
                        disabled={uploading}
                      />
                    </label>
                  )}
                </div>
              </div>
              <div>
                <Label className="text-sm mb-2 block">Logo Location</Label>
                <Select value={formData.images_logo_location || ''} onValueChange={(val) => updateField('images_logo_location', val)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select position" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bottom_left">Bottom Left</SelectItem>
                    <SelectItem value="bottom_right">Bottom Right</SelectItem>
                    <SelectItem value="bottom_centered">Bottom Centered</SelectItem>
                    <SelectItem value="top_left">Top Left</SelectItem>
                    <SelectItem value="top_right">Top Right</SelectItem>
                    <SelectItem value="top_centered">Top Centered</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs mb-1 block text-muted-foreground">Product Category (optional)</Label>
                <Select value={formData.images_product_category || '__none__'} onValueChange={(val) => updateField('images_product_category', val === '__none__' ? '' : val)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="All categories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">All categories</SelectItem>
                    {allCategories.map(cat => (
                      <SelectItem key={cat.id} value={cat.name}>{cat.icon} {cat.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              </CardContent>
              )}
              </Card>

        {/* Drone Branding */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Drone Branding</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm mb-2 block">Drone Template</Label>
              <Input
                placeholder="Link or reference"
                value={formData.drone_template}
                onChange={(e) => updateField('drone_template', e.target.value)}
              />
              <div className="mt-2">
                <Label className="text-xs mb-1 block text-muted-foreground">Product Category (optional)</Label>
                <Select value={formData.drone_product_category || '__none__'} onValueChange={(val) => updateField('drone_product_category', val === '__none__' ? '' : val)}>
                   <SelectTrigger className="h-8 text-xs">
                     <SelectValue placeholder="All categories" />
                   </SelectTrigger>
                   <SelectContent>
                     <SelectItem value="__none__">All categories</SelectItem>
                     {allCategories.map(cat => (
                       <SelectItem key={cat.id} value={cat.name}>{cat.icon} {cat.name}</SelectItem>
                     ))}
                   </SelectContent>
                 </Select>
              </div>
            </div>
            <div>
              <Label className="text-sm mb-2 block">Drone Template Link</Label>
              <Input
                placeholder="Full URL"
                type="url"
                value={formData.drone_template_link}
                onChange={(e) => updateField('drone_template_link', e.target.value)}
              />
            </div>
            <div>
              <Label className="text-sm mb-2 block">Drone Branding Notes</Label>
              <Textarea
                placeholder="Drone-specific branding notes..."
                value={formData.drone_branding_notes}
                onChange={(e) => updateField('drone_branding_notes', e.target.value)}
                className="h-20"
              />
            </div>
          </CardContent>
        </Card>

        {/* Video Branding */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Video Branding</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm mb-2 block">Video Branding</Label>
              <Input
                placeholder="Link or reference"
                value={formData.video_branding}
                onChange={(e) => updateField('video_branding', e.target.value)}
              />
              <div className="mt-2">
                <Label className="text-xs mb-1 block text-muted-foreground">Product Category (optional)</Label>
                <Select value={formData.video_product_category || '__none__'} onValueChange={(val) => updateField('video_product_category', val === '__none__' ? '' : val)}>
                   <SelectTrigger className="h-8 text-xs">
                     <SelectValue placeholder="All categories" />
                   </SelectTrigger>
                   <SelectContent>
                     <SelectItem value="__none__">All categories</SelectItem>
                     {allCategories.map(cat => (
                       <SelectItem key={cat.id} value={cat.name}>{cat.icon} {cat.name}</SelectItem>
                     ))}
                   </SelectContent>
                 </Select>
              </div>
            </div>
            <div>
              <Label className="text-sm mb-2 block">Video - Music Preference</Label>
              <Input
                placeholder="Preferred music style or link"
                value={formData.video_music_preference}
                onChange={(e) => updateField('video_music_preference', e.target.value)}
              />
            </div>
            <div>
              <Label className="text-sm mb-2 block">Video Branding Notes</Label>
              <Textarea
                placeholder="Video-specific branding notes..."
                value={formData.video_branding_notes}
                onChange={(e) => updateField('video_branding_notes', e.target.value)}
                className="h-20"
              />
            </div>
          </CardContent>
        </Card>

        {/* Branding & Links */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Branding & Links</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm mb-2 block">Agency Branding Link</Label>
              <Input
                placeholder="Full URL"
                type="url"
                value={formData.agency_branding_link}
                onChange={(e) => updateField('agency_branding_link', e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Agency Contacts */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Agency Contacts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm mb-2 block">Primary Marketing Contact</Label>
              <Input
                placeholder="Name or email"
                value={formData.primary_marketing_contact}
                onChange={(e) => updateField('primary_marketing_contact', e.target.value)}
              />
            </div>
            <div>
              <Label className="text-sm mb-2 block">Primary Accounts Contact</Label>
              <Input
                placeholder="Name or email"
                value={formData.primary_accounts_contact}
                onChange={(e) => updateField('primary_accounts_contact', e.target.value)}
              />
            </div>
            <div>
              <Label className="text-sm mb-2 block">Primary Partner</Label>
              <Input
                placeholder="Name or contact"
                value={formData.primary_partner}
                onChange={(e) => updateField('primary_partner', e.target.value)}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Save Button */}
      <div className="flex justify-end gap-2">
        <Button
          onClick={handleSave}
          disabled={saving}
          className="gap-2"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save Branding Preferences
        </Button>
      </div>
    </div>
  );
}