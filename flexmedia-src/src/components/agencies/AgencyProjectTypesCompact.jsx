import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useEntityList } from '@/components/hooks/useEntityData';
import { Button } from '@/components/ui/button';
import { Loader2, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export default function AgencyProjectTypesCompact({ agency }) {
  const { data: projectTypes = [] } = useEntityList('ProjectType', 'order');
  const [selected, setSelected] = useState(agency?.default_project_type_ids || []);
  const [saving, setSaving] = useState(false);

  const activeTypes = projectTypes.filter(t => t.is_active !== false);

  const toggle = (id) => setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await base44.entities.Agency.update(agency.id, { default_project_type_ids: selected });
      toast.success('Project types saved');
    } catch { toast.error('Failed to save'); }
    finally { setSaving(false); }
  };

  if (activeTypes.length === 0) {
    return <p className="text-xs text-muted-foreground italic">No project types configured in Settings.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {activeTypes.map(type => {
          const isSelected = selected.includes(type.id);
          return (
            <button
              key={type.id}
              type="button"
              onClick={() => toggle(type.id)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all',
                isSelected ? 'text-white border-transparent shadow-sm' : 'bg-background text-muted-foreground border-border hover:border-primary/40'
              )}
              style={isSelected ? { backgroundColor: type.color || '#3b82f6', borderColor: type.color || '#3b82f6' } : {}}
            >
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: isSelected ? 'rgba(255,255,255,0.7)' : (type.color || '#3b82f6') }} />
              {type.name}
              {isSelected && <Check className="h-2.5 w-2.5 opacity-80" />}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-muted-foreground">
          {selected.length > 0 ? `${selected.length} selected as default` : 'None selected — all types shown'}
        </p>
        <div className="flex gap-1.5">
          {selected.length > 0 && (
            <Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground px-2" onClick={() => setSelected([])} disabled={saving}>Clear</Button>
          )}
          <Button size="sm" onClick={handleSave} disabled={saving} className="h-6 text-xs gap-1 px-2">
            {saving ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Check className="h-2.5 w-2.5" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}