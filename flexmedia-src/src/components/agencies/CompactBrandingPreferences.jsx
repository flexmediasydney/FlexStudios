import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { api } from '@/api/supabaseClient';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Loader2, Check, ExternalLink, Upload, Trash2, File, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export default function CompactBrandingPreferences({ agency }) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState({});
  const [selectedTypeId, setSelectedTypeId] = useState(null);
  const [preferences, setPreferences] = useState([]);
  const [generalNotes, setGeneralNotes] = useState('');
  const [filesLink, setFilesLink] = useState('');

  const { data: allTypes = [], isLoading: typesLoading } = useQuery({
    queryKey: ['projectTypes'],
    queryFn: () => api.entities.ProjectType.list(),
    staleTime: 20000
  });
  const { data: allCategories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['productCategories'],
    queryFn: () => api.entities.ProductCategory.list(),
    staleTime: 20000
  });

  useEffect(() => {
    const u1 = api.entities.ProjectType.subscribe(() => queryClient.invalidateQueries({ queryKey: ['projectTypes'] }));
    const u2 = api.entities.ProductCategory.subscribe(() => queryClient.invalidateQueries({ queryKey: ['productCategories'] }));
    return () => { u1(); u2(); };
  }, [queryClient]);

  useEffect(() => {
    setPreferences(agency?.branding_preferences ? [...agency.branding_preferences] : []);
    setGeneralNotes(agency?.branding_general_notes || '');
    setFilesLink(agency?.branding_files_link || '');
  }, [agency]);

  const activeTypes = useMemo(() => allTypes.filter(t => t.is_active !== false), [allTypes]);

  useEffect(() => {
    if (activeTypes.length > 0 && !selectedTypeId) setSelectedTypeId(activeTypes[0].id);
  }, [activeTypes, selectedTypeId]);

  const categoriesForType = useMemo(() =>
    !selectedTypeId ? [] : allCategories.filter(c => c.is_active !== false && c.project_type_id === selectedTypeId),
    [allCategories, selectedTypeId]
  );

  const getPref = useCallback((catId) => preferences.find(p => p.category_id === catId) || null, [preferences]);

  const setPref = useCallback((catId, catName, updates) => {
    setPreferences(prev => {
      const exists = prev.find(p => p.category_id === catId);
      if (exists) return prev.map(p => p.category_id === catId ? { ...p, ...updates } : p);
      return [...prev, { category_id: catId, category_name: catName, enabled: false, template_link: '', notes: '', reference_uploads: [], ...updates }];
    });
  }, []);

  const handleUpload = async (e, catId, catName) => {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading(p => ({ ...p, [catId]: true }));
    try {
      const uploads = [];
      for (const file of files) {
        const { file_url } = await api.integrations.Core.UploadFile({ file });
        uploads.push({ file_url, file_name: file.name, uploaded_at: new Date().toISOString() });
      }
      const existing = getPref(catId)?.reference_uploads || [];
      setPref(catId, catName, { reference_uploads: [...existing, ...uploads] });
      toast.success(`${uploads.length} file(s) uploaded`);
    } catch { toast.error('Upload failed'); }
    finally { setUploading(p => ({ ...p, [catId]: false })); }
  };

  const removeUpload = useCallback((catId, fileUrl) => {
    const existing = getPref(catId)?.reference_uploads || [];
    setPref(catId, catId, { reference_uploads: existing.filter(f => f.file_url !== fileUrl) });
  }, [getPref, setPref]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const activeIds = new Set(allCategories.map(c => c.id));
      const cleanPrefs = preferences.filter(p => activeIds.has(p.category_id));
      await api.entities.Agency.update(agency.id, {
        branding_preferences: cleanPrefs,
        branding_general_notes: generalNotes,
        branding_files_link: filesLink
      });
      setPreferences(cleanPrefs);
      toast.success('Branding saved');
    } catch { toast.error('Failed to save'); }
    finally { setSaving(false); }
  };

  if (typesLoading || categoriesLoading) {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground py-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading...</div>;
  }

  return (
    <div className="space-y-3">
      {/* Global fields */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="space-y-1">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">General Notes</p>
          <Textarea
            placeholder="Agency-wide branding notes..."
            value={generalNotes}
            onChange={e => setGeneralNotes(e.target.value)}
            rows={2}
            className="text-xs resize-none h-16"
          />
        </div>
        <div className="space-y-1">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Files Link</p>
          <Input
            placeholder="https://dropbox.com/... or Drive"
            type="url"
            value={filesLink}
            onChange={e => setFilesLink(e.target.value)}
            className="text-xs h-7"
          />
          {filesLink && (
            <a href={filesLink} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline">
              <ExternalLink className="h-2.5 w-2.5" />Open files
            </a>
          )}
        </div>
      </div>

      {activeTypes.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No project types configured.</p>
      ) : (
        <>
          {/* Project type tabs */}
          <div className="flex flex-wrap gap-1 pt-1">
            {activeTypes.map(type => (
              <button
                key={type.id}
                onClick={() => setSelectedTypeId(type.id)}
                className={cn(
                  'px-2.5 py-1 rounded text-[11px] font-medium border transition-all',
                  selectedTypeId === type.id
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:border-primary/40'
                )}
              >
                {type.name}
              </button>
            ))}
          </div>

          {/* Category rows */}
          {categoriesForType.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No categories for this type.</p>
          ) : (
            <div className="border rounded-lg overflow-hidden divide-y">
              {categoriesForType.map(cat => {
                const pref = getPref(cat.id);
                const enabled = pref?.enabled || false;
                return (
                  <div key={cat.id} className={cn('transition-colors', enabled ? 'bg-primary/[0.02]' : '')}>
                    {/* Row header */}
                    <div className="flex items-center gap-2.5 px-3 py-2">
                      <span
                        className="w-5 h-5 rounded flex-shrink-0 flex items-center justify-center text-white text-[10px] font-bold"
                        style={{ backgroundColor: cat.color || '#6b7280' }}
                      >
                        {cat.icon || '◆'}
                      </span>
                      <span className="flex-1 text-xs font-medium">{cat.name}</span>
                      <Switch
                        checked={enabled}
                        onCheckedChange={val => setPref(cat.id, cat.name, { enabled: val })}
                      />
                    </div>
                    {/* Expanded content when enabled */}
                    {enabled && (
                      <div className="px-3 pb-3 space-y-2 bg-muted/10 border-t">
                        <div className="pt-2">
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Template Link</p>
                          <Input
                            placeholder="https://..."
                            type="url"
                            value={pref?.template_link || ''}
                            onChange={e => setPref(cat.id, cat.name, { template_link: e.target.value })}
                            className="text-xs h-7"
                          />
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Notes</p>
                          <Textarea
                            placeholder="Branding guidelines..."
                            value={pref?.notes || ''}
                            onChange={e => setPref(cat.id, cat.name, { notes: e.target.value })}
                            rows={2}
                            className="text-xs resize-none h-14"
                          />
                        </div>
                        {/* Reference files */}
                        <div>
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Reference Files</p>
                          {pref?.reference_uploads?.length > 0 && (
                            <div className="space-y-1 mb-1">
                              {pref.reference_uploads.map(f => (
                                <div key={f.file_url} className="flex items-center gap-1.5 px-2 py-1 rounded bg-muted/50 border text-[11px]">
                                  <File className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                                  <a href={f.file_url} target="_blank" rel="noopener noreferrer" className="flex-1 truncate text-primary hover:underline">{f.file_name}</a>
                                  <button onClick={() => removeUpload(cat.id, f.file_url)} className="text-muted-foreground hover:text-destructive transition-colors flex-shrink-0">
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          <label className="cursor-pointer inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors border border-dashed rounded px-2 py-1">
                            {uploading[cat.id] ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                            Upload file
                            <input type="file" className="hidden" multiple accept="image/*,.pdf,.doc,.docx"
                              onChange={e => handleUpload(e, cat.id, cat.name)} disabled={uploading[cat.id]} />
                          </label>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Save */}
      <div className="flex justify-end pt-1">
        <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5 h-7 text-xs">
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Save Branding
        </Button>
      </div>
    </div>
  );
}