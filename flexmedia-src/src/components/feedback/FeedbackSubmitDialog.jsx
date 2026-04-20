import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Upload, X, Image as ImageIcon, Bug, Lightbulb, Sparkles } from 'lucide-react';
import { api } from '@/api/supabaseClient';
import { refetchEntityList } from '@/components/hooks/useEntityData';
import { cn } from '@/lib/utils';
import { AREA_OPTIONS, TYPE_META } from './feedbackConstants';

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_DESCRIPTION = 2000;
const MAX_TITLE = 120;
const BUCKET = 'feedback-screenshots';

const TYPE_CHOICES = [
  { value: 'bug', label: 'Bug', icon: Bug },
  { value: 'improvement', label: 'Improvement', icon: Lightbulb },
  { value: 'feature_request', label: 'Feature request', icon: Sparkles },
];

async function uploadToStorage(file) {
  const supabase = api._supabase;
  const ts = Date.now();
  const safeName = (file.name || `paste_${ts}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${ts}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type || 'image/png', upsert: false });
  if (error) throw new Error(error.message || 'Upload failed');
  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return { path: data.path, url: urlData.publicUrl };
}

export default function FeedbackSubmitDialog({ open, onOpenChange, onSubmitted }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState('bug');
  const [severity, setSeverity] = useState('medium');
  const [area, setArea] = useState('');
  const [description, setDescription] = useState('');
  const [screenshots, setScreenshots] = useState([]); // { url, path, name }
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dialogRef = useRef(null);
  const fileInputRef = useRef(null);

  const reset = useCallback(() => {
    setTitle('');
    setType('bug');
    setSeverity('medium');
    setArea('');
    setDescription('');
    setScreenshots([]);
    setUploading(false);
    setSubmitting(false);
  }, []);

  // Reset when dialog closes, but only after the exit animation finishes.
  useEffect(() => {
    if (!open) {
      const t = setTimeout(reset, 300);
      return () => clearTimeout(t);
    }
  }, [open, reset]);

  const handleFiles = useCallback(async (files) => {
    const fileArr = Array.from(files || []).filter(f => f.type.startsWith('image/'));
    if (!fileArr.length) return;
    const roomLeft = MAX_IMAGES - screenshots.length;
    if (roomLeft <= 0) {
      toast.error(`You can attach up to ${MAX_IMAGES} images.`);
      return;
    }
    const accepted = fileArr.slice(0, roomLeft);
    if (fileArr.length > roomLeft) {
      toast.error(`Only ${roomLeft} more image${roomLeft === 1 ? '' : 's'} can be attached.`);
    }
    setUploading(true);
    try {
      const uploaded = [];
      for (const f of accepted) {
        if (f.size > MAX_IMAGE_BYTES) {
          toast.error(`"${f.name}" is over 5MB and was skipped.`);
          continue;
        }
        try {
          const { path, url } = await uploadToStorage(f);
          uploaded.push({ path, url, name: f.name || 'paste.png' });
        } catch (err) {
          toast.error(`Upload failed: ${err?.message || 'unknown error'}`);
        }
      }
      if (uploaded.length) {
        setScreenshots(prev => [...prev, ...uploaded]);
      }
    } finally {
      setUploading(false);
    }
  }, [screenshots.length]);

  // Ctrl+V paste — scoped to the dialog element so it doesn't fire when the
  // dialog is closed. The Radix dialog is portalled, so we listen on the
  // document but bail if the dialog isn't currently open.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        handleFiles(files);
      }
    };
    document.addEventListener('paste', handler);
    return () => document.removeEventListener('paste', handler);
  }, [open, handleFiles]);

  const removeScreenshot = (index) => {
    // Fire-and-forget delete from storage. If the user cancels the whole
    // submit we leave anything they've uploaded — the orphan cleanup is
    // out of scope for v1.
    const target = screenshots[index];
    if (target?.path) {
      api._supabase.storage.from(BUCKET).remove([target.path]).catch(() => { /* best effort */ });
    }
    setScreenshots(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error('Please enter a title.');
      return;
    }
    if (trimmedTitle.length > MAX_TITLE) {
      toast.error(`Title is too long (max ${MAX_TITLE} chars).`);
      return;
    }
    setSubmitting(true);
    try {
      let user;
      try { user = await api.auth.me(); } catch { /* ignore */ }
      const payload = {
        title: trimmedTitle,
        description: description.trim() || null,
        type,
        severity,
        area: area || null,
        status: 'new',
        screenshots: screenshots.map(s => ({ url: s.url, path: s.path, name: s.name })),
        page_url: typeof window !== 'undefined' ? window.location.href : null,
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        created_by: user?.id || null,
        created_by_name: user?.full_name || null,
        created_by_email: user?.email || null,
      };
      await api.entities.FeedbackItem.create(payload);
      toast.success("Thanks — we'll look at this.");
      refetchEntityList('FeedbackItem');
      onSubmitted?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err?.message || 'Failed to submit feedback.');
    } finally {
      setSubmitting(false);
    }
  };

  const remaining = MAX_DESCRIPTION - description.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl max-h-[90vh] overflow-y-auto"
        ref={dialogRef}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
        }}
      >
        <DialogHeader>
          <DialogTitle>Report an issue or idea</DialogTitle>
          <DialogDescription>
            Share what went wrong or what could be better. You can paste screenshots
            with Ctrl+V.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="fb-title">Title</Label>
            <Input
              id="fb-title"
              value={title}
              maxLength={MAX_TITLE}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short summary"
              autoFocus
            />
            <div className="text-[10px] text-muted-foreground text-right">{title.length}/{MAX_TITLE}</div>
          </div>

          {/* Type (segmented) */}
          <div className="space-y-1.5">
            <Label>Type</Label>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Type">
              {TYPE_CHOICES.map(choice => {
                const Icon = choice.icon;
                const active = type === choice.value;
                const meta = TYPE_META[choice.value];
                return (
                  <button
                    type="button"
                    key={choice.value}
                    role="radio"
                    aria-checked={active}
                    onClick={() => setType(choice.value)}
                    className={cn(
                      'flex items-center justify-center gap-1.5 py-2 px-2 rounded-md text-xs font-medium border transition-colors',
                      active ? meta.badge : 'bg-background hover:bg-muted border-border text-muted-foreground'
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {choice.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Severity + Area */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fb-severity">Severity</Label>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger id="fb-severity"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="critical">Critical</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fb-area">Area</Label>
              <Select value={area || '__none__'} onValueChange={(v) => setArea(v === '__none__' ? '' : v)}>
                <SelectTrigger id="fb-area"><SelectValue placeholder="Pick an area" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— none —</SelectItem>
                  {AREA_OPTIONS.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="fb-desc">Description</Label>
            <Textarea
              id="fb-desc"
              rows={6}
              value={description}
              maxLength={MAX_DESCRIPTION}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's wrong? What did you expect?"
              className="resize-y"
            />
            <div className={cn('text-[10px] text-right', remaining < 100 ? 'text-amber-600' : 'text-muted-foreground')}>
              {remaining} chars left
            </div>
          </div>

          {/* Screenshots */}
          <div className="space-y-1.5">
            <Label>Screenshots</Label>
            <div
              className={cn(
                'rounded-md border-2 border-dashed p-4 text-xs text-muted-foreground transition-colors cursor-pointer',
                isDragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/20 hover:border-muted-foreground/40'
              )}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="flex flex-col items-center justify-center gap-1 text-center">
                <Upload className="h-5 w-5" />
                <span>Drop images here, paste with Ctrl+V, or click to pick files</span>
                <span className="text-[10px] opacity-75">Max {MAX_IMAGES} · 5MB each</span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
              />
            </div>

            {screenshots.length > 0 && (
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 pt-2">
                {screenshots.map((s, i) => (
                  <div key={s.path} className="relative group">
                    <img
                      src={s.url}
                      alt={s.name}
                      className="w-full h-16 object-cover rounded-md border"
                    />
                    <button
                      type="button"
                      onClick={() => removeScreenshot(i)}
                      className="absolute -top-1.5 -right-1.5 bg-background rounded-full border shadow-sm p-0.5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive hover:text-destructive-foreground"
                      aria-label="Remove screenshot"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                {uploading && (
                  <div className="h-16 rounded-md border border-dashed flex items-center justify-center text-[10px] text-muted-foreground">
                    <ImageIcon className="h-3 w-3 mr-1 animate-pulse" /> Uploading…
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || uploading || !title.trim()}>
            {submitting ? 'Submitting…' : 'Submit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
