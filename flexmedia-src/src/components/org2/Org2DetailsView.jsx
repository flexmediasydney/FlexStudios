import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pencil, X, Save } from 'lucide-react';
import { api } from '@/api/supabaseClient';

const DETAIL_FIELDS = [
  { key: 'name', label: 'Agency Name', type: 'text', readOnly: false },
  { key: 'email', label: 'Email', type: 'email', readOnly: false },
  { key: 'phone', label: 'Phone', type: 'text', readOnly: false },
  { key: 'address', label: 'Address', type: 'text', readOnly: false },
  { key: 'relationship_state', label: 'Relationship State', type: 'select', readOnly: false, options: ['Prospecting', 'Active', 'Dormant', 'Do Not Contact'] },
  { key: 'onboarding_date', label: 'Onboarding Date', type: 'date', readOnly: false },
  { key: 'became_active_date', label: 'Became Active Date', type: 'date', readOnly: false },
  { key: 'became_dormant_date', label: 'Became Dormant Date', type: 'date', readOnly: false },
];

const KEY_CONTACT_FIELDS = [
  { key: 'primary_marketing_contact', label: 'Marketing Contact' },
  { key: 'primary_accounts_contact', label: 'Accounts Contact' },
  { key: 'primary_partner', label: 'Primary Partner' },
];

export default function Org2DetailsView({ agency, agents }) {
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState(agency || {});

  const handleSave = async () => {
    await api.entities.Agency.update(agency.id, editData);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditData(agency);
    setIsEditing(false);
  };

  const handleFieldChange = (key, value) => {
    setEditData(prev => ({ ...prev, [key]: value }));
  };

  const getAgentByEmail = (email) => {
    return agents?.find(a => a.email === email);
  };

  const formatValue = (value) => {
    if (!value) return '-';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    return value;
  };

  return (
    <div className="space-y-6 p-4">
      {/* Agency Information */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold uppercase text-muted-foreground">Agency Information</h3>
          {!isEditing ? (
            <Button 
              size="sm" 
              variant="ghost"
              onClick={() => setIsEditing(true)}
              className="gap-1"
            >
              <Pencil className="h-4 w-4" />
              Edit Details
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button 
                size="sm" 
                variant="default"
                onClick={handleSave}
                className="gap-1"
              >
                <Save className="h-4 w-4" />
                Save
              </Button>
              <Button 
                size="sm" 
                variant="outline"
                onClick={handleCancel}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          {DETAIL_FIELDS.map(field => (
            <div key={field.key} className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase">{field.label}</label>
              {isEditing ? (
                field.type === 'select' ? (
                  <select
                    value={editData[field.key] || ''}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                    className="w-full px-2 py-1 border rounded text-sm"
                  >
                    <option value="">Select...</option>
                    {field.options?.map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type={field.type}
                    value={editData[field.key] || ''}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                    className="h-8 text-sm"
                  />
                )
              ) : (
                <p className="text-sm font-medium text-foreground">{formatValue(editData[field.key])}</p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Key Contacts */}
      <section>
        <h3 className="text-sm font-semibold uppercase text-muted-foreground mb-4">Key Contacts</h3>
        <div className="grid grid-cols-2 gap-4">
          {KEY_CONTACT_FIELDS.map(field => {
            const contactEmail = editData[field.key];
            const contactAgent = getAgentByEmail(contactEmail);
            
            return (
              <div key={field.key} className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase">{field.label}</label>
                {isEditing ? (
                  <select
                    value={contactEmail || ''}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                    className="w-full px-2 py-1 border rounded text-sm"
                  >
                    <option value="">Unassigned</option>
                    {agents?.map(agent => (
                      <option key={agent.id} value={agent.email}>{agent.name}</option>
                    ))}
                  </select>
                ) : (
                  <p className="text-sm font-medium text-foreground">
                    {contactAgent ? contactAgent.name : '-'}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Branding & Preferences */}
      <section>
        <h3 className="text-sm font-semibold uppercase text-muted-foreground mb-4">Branding & Preferences</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Floorplan Enabled:</span>
            <span className="font-medium">{editData.floorplan_enabled ? 'Yes' : 'No'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Images Branding:</span>
            <span className="font-medium">{editData.images_branding_enabled ? 'Yes' : 'No'}</span>
          </div>
          {editData.branding_general_notes && (
            <div className="pt-2">
              <span className="text-xs font-medium text-muted-foreground block mb-1">Branding Notes</span>
              <p className="text-sm text-foreground whitespace-pre-wrap">{editData.branding_general_notes}</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}