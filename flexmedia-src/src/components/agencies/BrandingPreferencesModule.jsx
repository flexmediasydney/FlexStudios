import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { AlertCircle, CheckCircle2, Loader2, Upload, Trash2, File, ChevronRight, Sparkles, Building2, Link } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * BrandingPreferencesModule - State-of-the-art category-based branding preferences
 * with real-time reactivity, orphan detection, and multi-file uploads
 */
export default function BrandingPreferencesModule({ agency }) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [uploading, setUploading] = useState({});
  const [selectedTypeId, setSelectedTypeId] = useState(null);

  // Fetch project types with real-time subscription
  const { data: allTypes = [], isLoading: typesLoading } = useQuery({
    queryKey: ['projectTypes'],
    queryFn: () => base44.entities.ProjectType.list(),
    staleTime: 20000
  });

  useEffect(() => {
    const unsubscribe = base44.entities.ProjectType.subscribe((event) => {
      queryClient.invalidateQueries({ queryKey: ['projectTypes'] });
    });
    return unsubscribe;
  }, [queryClient]);

  // Fetch all active categories with real-time subscription
  const { data: allCategories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['productCategories'],
    queryFn: () => base44.entities.ProductCategory.list(),
    staleTime: 20000
  });

  // Real-time category subscription for dynamic updates
  useEffect(() => {
    const unsubscribe = base44.entities.ProductCategory.subscribe((event) => {
      queryClient.invalidateQueries({ queryKey: ['productCategories'] });
    });
    return unsubscribe;
  }, [queryClient]);

  // Initialize preferences state from agency
  const [preferences, setPreferences] = useState([]);
  const [generalNotes, setGeneralNotes] = useState('');
  const [filesLink, setFilesLink] = useState('');

  useEffect(() => {
    if (agency?.branding_preferences) {
      setPreferences([...agency.branding_preferences]);
    } else {
      setPreferences([]);
    }
    setGeneralNotes(agency?.branding_general_notes || '');
    setFilesLink(agency?.branding_files_link || '');
  }, [agency]);

  // ── Orphan Detection & Auto-Cleanup ────────────────────────────────────
  // Categories that exist in preferences but no longer in database
  const orphanedPrefs = useMemo(() => {
    const activeIds = new Set(allCategories.map(c => c.id));
    return preferences.filter(p => !activeIds.has(p.category_id));
  }, [preferences, allCategories]);

  // Auto-select first type if none selected
  useEffect(() => {
    const activeTypes = allTypes.filter(t => t.is_active !== false);
    if (activeTypes.length > 0 && !selectedTypeId) {
      setSelectedTypeId(activeTypes[0].id);
    }
  }, [allTypes, selectedTypeId]);

  // Filter categories by selected type
  const categoriesForType = useMemo(() => {
    if (!selectedTypeId) return [];
    return allCategories.filter(c => 
      c.is_active !== false && c.project_type_id === selectedTypeId
    );
  }, [allCategories, selectedTypeId]);

  // Filter out orphaned preferences for display
  const activePreferences = useMemo(() => {
    return preferences.filter(p => {
      const cat = allCategories.find(c => c.id === p.category_id);
      return cat && cat.is_active !== false;
    });
  }, [preferences, allCategories]);

  // ── Preference Getters & Setters ───────────────────────────────────────
  const getPrefForCategory = useCallback((categoryId) => {
    return preferences.find(p => p.category_id === categoryId) || null;
  }, [preferences]);

  const ensurePrefForCategory = useCallback((categoryId, categoryName) => {
    let pref = getPrefForCategory(categoryId);
    if (!pref) {
      pref = {
        category_id: categoryId,
        category_name: categoryName,
        enabled: false,
        template_link: '',
        notes: '',
        reference_uploads: []
      };
      setPreferences(prev => [...prev, pref]);
    }
    return pref;
  }, [getPrefForCategory]);

  const updatePref = useCallback((categoryId, updates) => {
    setPreferences(prev =>
      prev.map(p =>
        p.category_id === categoryId ? { ...p, ...updates } : p
      )
    );
  }, []);

  const removePref = useCallback((categoryId) => {
    setPreferences(prev => prev.filter(p => p.category_id !== categoryId));
  }, []);

  // ── File Upload Handler ────────────────────────────────────────────────
  const handleUploadFiles = async (e, categoryId, categoryName) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const categoryKey = `${categoryId}`;
    setUploading(prev => ({ ...prev, [categoryKey]: true }));

    try {
      const pref = ensurePrefForCategory(categoryId, categoryName);
      const newUploads = [];

      for (let file of files) {
        const { file_url } = await base44.integrations.Core.UploadFile({ file });
        newUploads.push({
          file_url,
          file_name: file.name,
          uploaded_at: new Date().toISOString()
        });
      }

      updatePref(categoryId, {
        reference_uploads: [...(pref.reference_uploads || []), ...newUploads]
      });

      setMessage({ type: 'success', text: `${newUploads.length} file(s) uploaded successfully` });
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to upload files' });
      console.error('Upload error:', err);
    } finally {
      setUploading(prev => ({ ...prev, [categoryKey]: false }));
    }
  };

  const removeUpload = useCallback((categoryId, fileUrl) => {
    updatePref(categoryId, {
      reference_uploads: getPrefForCategory(categoryId)?.reference_uploads?.filter(f => f.file_url !== fileUrl) || []
    });
  }, [getPrefForCategory, updatePref]);

  // ── Save Handler ──────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    setMessage(null);

    try {
      // Filter out orphaned preferences before saving
      const cleanPrefs = preferences.filter(p => {
        const cat = allCategories.find(c => c.id === p.category_id);
        return cat && cat.is_active !== false;
      });

      await base44.entities.Agency.update(agency.id, {
        branding_preferences: cleanPrefs,
        branding_general_notes: generalNotes,
        branding_files_link: filesLink
      });

      setPreferences(cleanPrefs);
      setMessage({ type: 'success', text: 'Branding preferences saved successfully' });
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to save preferences' });
      console.error('Save error:', err);
    } finally {
      setSaving(false);
    }
  };

  if (typesLoading || categoriesLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const activeTypes = allTypes.filter(t => t.is_active !== false);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Branding Preferences</h2>
        </div>
        <p className="text-sm text-muted-foreground">Configure brand guidelines, templates, and assets for each product category and project type.</p>
      </div>

      {/* Messages */}
      {message && (
        <div className={`flex gap-3 p-4 rounded-xl border backdrop-blur-sm transition-all ${
          message.type === 'success' 
            ? 'bg-emerald-50/80 border-emerald-200/50 text-emerald-900' 
            : 'bg-red-50/80 border-red-200/50 text-red-900'
        }`}>
          {message.type === 'success' ? (
            <CheckCircle2 className="h-5 w-5 flex-shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
          )}
          <div className="flex-1">
            <p className="text-sm font-medium">{message.text}</p>
          </div>
        </div>
      )}

      {/* Agency-Level Branding */}
      <Card className="border-border bg-gradient-to-br from-muted/20 to-card">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-primary/10">
              <Building2 className="h-4 w-4 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold">Agency-Level Branding</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">Global branding settings that apply across all categories and project types.</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 border-t pt-5">
          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">General Notes</Label>
            <Textarea
              placeholder="Add any general branding guidelines, brand identity notes, or instructions that apply agency-wide..."
              value={generalNotes}
              onChange={(e) => setGeneralNotes(e.target.value)}
              className="h-32 text-sm resize-none"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Agency Branding Files</Label>
            <div className="relative">
              <Link className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="https://dropbox.com/sh/... or Google Drive link"
                type="url"
                value={filesLink}
                onChange={(e) => setFilesLink(e.target.value)}
                className="h-9 text-sm pl-9"
              />
            </div>
            {filesLink && (
              <a
                href={filesLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline mt-1"
              >
                <Link className="h-3 w-3" />
                Open branding files
              </a>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Orphan Warning */}
      {orphanedPrefs.length > 0 && (
        <div className="flex gap-3 p-4 rounded-xl border bg-amber-50/80 border-amber-200/50 backdrop-blur-sm">
          <AlertCircle className="h-5 w-5 text-amber-700 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-900">Orphaned Preferences Detected</p>
            <p className="text-sm text-amber-800 mt-1">
              {orphanedPrefs.length} preference(s) reference deleted categories. These will be automatically removed when you save.
            </p>
          </div>
        </div>
      )}

      {/* Type Selection + Category Cards */}
      {activeTypes.length === 0 ? (
        <Card className="bg-gradient-to-br from-muted/50 to-muted/30 border-dashed">
          <CardContent className="pt-12 pb-12 text-center">
            <p className="text-muted-foreground text-sm">No project types available. Create project types first.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex gap-8">
          {/* Left: Project Types Navigation */}
          <div className="w-56 flex-shrink-0">
            <div className="sticky top-8 space-y-2 p-4 rounded-xl border bg-card/50 backdrop-blur-sm">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">Project Types</p>
              {activeTypes.map(type => (
                <button
                  key={type.id}
                  onClick={() => setSelectedTypeId(type.id)}
                  className={cn(
                    "w-full text-left px-3 py-2.5 rounded-lg transition-all duration-200 flex items-center justify-between font-medium text-sm",
                    selectedTypeId === type.id
                      ? "bg-primary text-primary-foreground shadow-md"
                      : "text-foreground hover:bg-primary/5"
                  )}
                >
                  <span className="truncate">{type.name}</span>
                  {selectedTypeId === type.id && (
                    <ChevronRight className="h-4 w-4 flex-shrink-0 ml-2" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Right: Categories for Selected Type */}
          <div className="flex-1">
            {categoriesForType.length === 0 ? (
              <Card className="bg-gradient-to-br from-muted/50 to-muted/30 border-dashed">
                <CardContent className="pt-12 pb-12 text-center">
                  <p className="text-muted-foreground text-sm">
                    No categories for this project type yet.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-5">
                {categoriesForType.map(category => {
            const pref = getPrefForCategory(category.id);
            const isEnabled = pref?.enabled || false;
            const categoryKey = `${category.id}`;

            return (
              <Card key={category.id} className={cn(
                'border transition-all duration-300',
                isEnabled 
                  ? 'border-primary/40 bg-gradient-to-br from-primary/3 via-card to-card shadow-sm hover:shadow-md' 
                  : 'border-border hover:border-primary/30 hover:shadow-sm'
              )}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1">
                      <div
                        className="w-11 h-11 rounded-xl flex items-center justify-center text-white text-lg font-bold flex-shrink-0 shadow-sm"
                        style={{ backgroundColor: category.color || '#6b7280' }}
                      >
                        {category.icon || '◆'}
                      </div>
                      <div className="min-w-0 flex-1">
                        <CardTitle className="text-base font-semibold">{category.name}</CardTitle>
                        {category.description && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{category.description}</p>
                        )}
                      </div>
                    </div>
                    <Switch
                      checked={isEnabled}
                      onCheckedChange={(val) => {
                        if (val) {
                          ensurePrefForCategory(category.id, category.name);
                        }
                        updatePref(category.id, { enabled: val });
                      }}
                    />
                  </div>
                </CardHeader>

                {isEnabled && (
                  <CardContent className="space-y-5 border-t pt-5">
                    {/* Template Link */}
                     <div className="space-y-2">
                       <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Template Link URL</Label>
                       <Input
                         placeholder="https://example.com/template"
                         type="url"
                         value={pref?.template_link || ''}
                         onChange={(e) => updatePref(category.id, { template_link: e.target.value })}
                         className="h-9 text-sm"
                       />
                     </div>

                     {/* Notes */}
                     <div className="space-y-2">
                       <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Branding Guidelines</Label>
                       <Textarea
                         placeholder="Add specifications, guidelines, requirements, or any notes for this category..."
                         value={pref?.notes || ''}
                         onChange={(e) => updatePref(category.id, { notes: e.target.value })}
                         className="h-28 text-sm resize-none"
                       />
                     </div>

                     {/* Reference Uploads */}
                     <div className="space-y-2">
                       <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Reference Assets</Label>

                       {/* Upload Zone */}
                       <div className="border-2 border-dashed rounded-xl p-6 text-center bg-muted/20 hover:bg-muted/40 hover:border-primary/30 transition-all duration-200">
                        {uploading[categoryKey] ? (
                          <div className="flex items-center justify-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">Uploading...</span>
                          </div>
                        ) : (
                          <label className="cursor-pointer block">
                            <div className="flex flex-col items-center gap-2.5">
                              <div className="p-2 rounded-lg bg-primary/5">
                                <Upload className="h-5 w-5 text-primary/60" />
                              </div>
                              <div>
                                <p className="text-sm font-medium text-foreground">Click to upload reference files</p>
                                <p className="text-xs text-muted-foreground mt-0.5">Images, PDFs, and documents</p>
                              </div>
                            </div>
                            <input
                              type="file"
                              className="hidden"
                              multiple
                              accept="image/*,.pdf,.doc,.docx"
                              onChange={(e) => handleUploadFiles(e, category.id, category.name)}
                              disabled={uploading[categoryKey]}
                            />
                          </label>
                        )}
                      </div>

                      {/* Uploaded Files List */}
                      {pref?.reference_uploads && pref.reference_uploads.length > 0 && (
                        <div className="mt-4 space-y-2">
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{pref.reference_uploads.length} file{pref.reference_uploads.length !== 1 ? 's' : ''} uploaded</p>
                          <div className="space-y-2">
                            {pref.reference_uploads.map((file) => (
                              <div
                                key={file.file_url}
                                className="flex items-center justify-between p-3 rounded-lg bg-muted/30 hover:bg-muted/50 border border-border/50 hover:border-border transition-all group"
                              >
                                <a
                                  href={file.file_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-2.5 flex-1 min-w-0 text-primary hover:underline"
                                >
                                  <File className="h-4 w-4 flex-shrink-0 text-primary/60" />
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm truncate font-medium">{file.file_name}</p>
                                  </div>
                                </a>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 ml-2 opacity-0 group-hover:opacity-100 transition-opacity"
                                  onClick={() => removeUpload(category.id, file.file_url)}
                                >
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </CardContent>
                )}
              </Card>
            );
              })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Save Button */}
      <div className="flex justify-end pt-6 border-t">
        <Button
          onClick={handleSave}
          disabled={saving || categoriesLoading}
          size="lg"
          className="gap-2 font-medium"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {saving ? 'Saving...' : 'Save Preferences'}
        </Button>
      </div>
    </div>
  );
}