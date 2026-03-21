import React, { useState } from 'react';
import { api } from '@/api/supabaseClient';
import { useEntityList } from '@/components/hooks/useEntityData';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, AlertCircle, Loader2, Tag } from 'lucide-react';

export default function AgencyProjectTypes({ agency }) {
  const { data: projectTypes = [] } = useEntityList('ProjectType', 'order');
  const [selected, setSelected] = useState(agency?.default_project_type_ids || []);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const activeTypes = projectTypes.filter(t => t.is_active !== false);

  const toggle = (id) => {
    setSelected(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await api.entities.Agency.update(agency.id, { default_project_type_ids: selected });
      setMessage({ type: 'success', text: 'Default project types saved.' });
    } catch {
      setMessage({ type: 'error', text: 'Failed to save.' });
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSelected([]);
    setSaving(true);
    setMessage(null);
    try {
      await api.entities.Agency.update(agency.id, { default_project_type_ids: [] });
      setMessage({ type: 'success', text: 'Default project types cleared.' });
    } catch {
      setMessage({ type: 'error', text: 'Failed to clear.' });
    } finally {
      setSaving(false);
    }
  };

  if (activeTypes.length === 0) {
    return (
      <Card className="bg-muted/30 border-dashed">
        <CardContent className="pt-6 pb-6 text-center">
          <p className="text-muted-foreground text-sm">No project types configured. Add project types in Settings → Organisation first.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {message && (
        <div className={`flex gap-3 p-4 rounded-lg border ${message.type === 'success' ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          {message.type === 'success'
            ? <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0" />
            : <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0" />}
          <p className={`text-sm ${message.type === 'success' ? 'text-green-800' : 'text-red-800'}`}>{message.text}</p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Tag className="h-4 w-4" />
            Default Project Types
          </CardTitle>
          <CardDescription>
            These project types will be pre-selected when creating new projects for this agency. Leave all unselected to show all types.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {activeTypes.map(type => {
              const isSelected = selected.includes(type.id);
              return (
                <button
                  key={type.id}
                  type="button"
                  onClick={() => toggle(type.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium border-2 transition-all ${
                    isSelected ? 'text-white border-transparent shadow-sm' : 'bg-background text-muted-foreground border-border hover:border-muted-foreground/40'
                  }`}
                  style={isSelected ? { backgroundColor: type.color || '#3b82f6', borderColor: type.color || '#3b82f6' } : {}}
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: isSelected ? 'rgba(255,255,255,0.7)' : (type.color || '#3b82f6') }}
                  />
                  {type.name}
                  {isSelected && <CheckCircle2 className="h-3.5 w-3.5 ml-0.5 opacity-80" />}
                </button>
              );
            })}
          </div>

          {selected.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {selected.length} type{selected.length !== 1 ? 's' : ''} selected as default
            </p>
          )}

          <div className="flex items-center justify-between pt-2 border-t">
            <Button variant="ghost" size="sm" onClick={handleClear} disabled={saving || selected.length === 0} className="text-muted-foreground">
              Clear all
            </Button>
            <Button onClick={handleSave} disabled={saving} className="gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}