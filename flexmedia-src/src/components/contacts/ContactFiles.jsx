import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/api/supabaseClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Upload, Search, Download, Trash2, FileText, Image, FileSpreadsheet,
  Film, File, Loader2, MoreVertical, X
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { retryWithBackoff } from '@/lib/networkResilience';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// ── File type helpers ────────────────────────────────────────────────────────

const FILE_TYPE_CONFIG = {
  pdf:         { icon: FileText,        color: 'text-red-500',    bg: 'bg-red-50' },
  doc:         { icon: FileText,        color: 'text-blue-600',   bg: 'bg-blue-50' },
  docx:        { icon: FileText,        color: 'text-blue-600',   bg: 'bg-blue-50' },
  xls:         { icon: FileSpreadsheet, color: 'text-green-600',  bg: 'bg-green-50' },
  xlsx:        { icon: FileSpreadsheet, color: 'text-green-600',  bg: 'bg-green-50' },
  csv:         { icon: FileSpreadsheet, color: 'text-green-600',  bg: 'bg-green-50' },
  png:         { icon: Image,           color: 'text-blue-500',   bg: 'bg-blue-50' },
  jpg:         { icon: Image,           color: 'text-blue-500',   bg: 'bg-blue-50' },
  jpeg:        { icon: Image,           color: 'text-blue-500',   bg: 'bg-blue-50' },
  gif:         { icon: Image,           color: 'text-blue-500',   bg: 'bg-blue-50' },
  svg:         { icon: Image,           color: 'text-blue-500',   bg: 'bg-blue-50' },
  webp:        { icon: Image,           color: 'text-blue-500',   bg: 'bg-blue-50' },
  mp4:         { icon: Film,            color: 'text-purple-500', bg: 'bg-purple-50' },
  mov:         { icon: Film,            color: 'text-purple-500', bg: 'bg-purple-50' },
  avi:         { icon: Film,            color: 'text-purple-500', bg: 'bg-purple-50' },
  webm:        { icon: Film,            color: 'text-purple-500', bg: 'bg-purple-50' },
};

function getFileConfig(fileName) {
  const ext = (fileName || '').split('.').pop()?.toLowerCase();
  return FILE_TYPE_CONFIG[ext] || { icon: File, color: 'text-gray-400', bg: 'bg-gray-50' };
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const now = new Date();
  const day = d.getDate();
  const mon = d.toLocaleString('en-US', { month: 'short' });
  const year = d.getFullYear();
  if (year === now.getFullYear()) return `${day} ${mon}`;
  return `${day} ${mon} ${year}`;
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ContactFiles({ entityType, entityId, entityLabel }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [deleteId, setDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const fileInputRef = useRef(null);
  const dropRef = useRef(null);

  // ── Load files ──────────────────────────────────────────────────────────
  const loadFiles = useCallback(async () => {
    if (!entityId) return;
    setLoading(true);
    try {
      const data = await api.entities.EntityFile.filter(
        { entity_type: entityType, entity_id: entityId },
        '-created_date'
      );
      setFiles(data || []);
    } catch (err) {
      console.error('Failed to load files:', err);
      toast.error('Failed to load files');
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  // ── Upload handler ──────────────────────────────────────────────────────
  const uploadFiles = useCallback(async (fileList) => {
    if (!fileList?.length || !entityId) return;
    setUploading(true);

    let currentUser = null;
    try {
      currentUser = await api.auth.me();
    } catch { /* ignore */ }

    const bucket = 'entity-files';
    const supabase = api._supabase;
    let successCount = 0;

    for (const file of fileList) {
      try {
        const ts = Date.now();
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const storagePath = `${entityType}/${entityId}/${ts}_${safeName}`;

        const { data, error } = await retryWithBackoff(
          () => supabase.storage.from(bucket).upload(storagePath, file, { contentType: file.type || 'application/octet-stream' })
            .then(res => { if (res.error) throw res.error; return res; }),
          { maxRetries: 2, onRetry: (err, attempt) => console.warn(`Upload retry ${attempt} for ${file.name}:`, err.message) }
        );

        if (error) throw error;

        const { data: urlData } = supabase.storage
          .from(bucket)
          .getPublicUrl(data.path);

        await api.entities.EntityFile.create({
          entity_type: entityType,
          entity_id: entityId,
          file_name: file.name,
          file_url: urlData.publicUrl,
          file_type: file.type || 'application/octet-stream',
          file_size: file.size,
          uploaded_by_name: currentUser?.full_name || currentUser?.email || 'Unknown',
          uploaded_by_email: currentUser?.email || null,
        });

        successCount++;
      } catch (err) {
        console.error(`Failed to upload ${file.name}:`, err);
        toast.error(`Failed to upload ${file.name}`);
      }
    }

    if (successCount > 0) {
      toast.success(`Uploaded ${successCount} file${successCount > 1 ? 's' : ''}`);
      await loadFiles();
    }
    setUploading(false);
  }, [entityType, entityId, loadFiles]);

  // ── Delete handler ──────────────────────────────────────────────────────
  const handleDelete = useCallback(async () => {
    if (!deleteId) return;
    setDeleting(true);
    try {
      // Find the file record to get the storage path
      const fileRecord = files.find(f => f.id === deleteId);
      if (fileRecord?.file_url) {
        // Extract storage path from URL
        const url = new URL(fileRecord.file_url);
        const pathParts = url.pathname.split('/storage/v1/object/public/entity-files/');
        if (pathParts[1]) {
          await api._supabase.storage
            .from('entity-files')
            .remove([decodeURIComponent(pathParts[1])]);
        }
      }
      await api.entities.EntityFile.delete(deleteId);
      toast.success('File deleted');
      await loadFiles();
    } catch (err) {
      console.error('Failed to delete file:', err);
      toast.error('Failed to delete file');
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
  }, [deleteId, files, loadFiles]);

  // ── Drag and drop ──────────────────────────────────────────────────────
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only leave if we're actually leaving the drop zone
    if (!dropRef.current?.contains(e.relatedTarget)) {
      setDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const droppedFiles = e.dataTransfer?.files;
    if (droppedFiles?.length) {
      uploadFiles(Array.from(droppedFiles));
    }
  }, [uploadFiles]);

  // ── Filtered files ──────────────────────────────────────────────────────
  const filteredFiles = searchQuery
    ? files.filter(f => f.file_name?.toLowerCase().includes(searchQuery.toLowerCase()))
    : files;

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div
      ref={dropRef}
      className="h-full flex flex-col relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <h3 className="text-sm font-semibold text-foreground">
          Files{!loading && ` (${files.length})`}
        </h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="h-8 gap-1.5 text-xs"
        >
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          Upload File
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              uploadFiles(Array.from(e.target.files));
              e.target.value = '';
            }
          }}
        />
      </div>

      {/* Search */}
      {files.length > 0 && (
        <div className="px-4 py-2 border-b shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files..."
              className="pl-8 h-8 text-xs"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
              <FileText className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground mb-1">No files yet</p>
            <p className="text-xs text-muted-foreground mb-4">
              Upload files to keep everything organized.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              className="gap-1.5 text-xs"
            >
              <Upload className="h-3.5 w-3.5" />
              Upload File
            </Button>
          </div>
        ) : filteredFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">No files matching "{searchQuery}"</p>
          </div>
        ) : (
          <div>
            {/* Table header */}
            <div className="grid grid-cols-[1fr_80px_120px_80px_40px] gap-2 px-4 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b bg-muted/30">
              <span>Name</span>
              <span>Size</span>
              <span>Uploaded by</span>
              <span>Date</span>
              <span></span>
            </div>

            {/* File rows */}
            {filteredFiles.map((file) => {
              const config = getFileConfig(file.file_name);
              const IconComp = config.icon;

              return (
                <div
                  key={file.id}
                  className="grid grid-cols-[1fr_80px_120px_80px_40px] gap-2 px-4 py-2.5 items-center border-b border-border/50 hover:bg-muted/20 transition-colors group"
                >
                  {/* Name + icon */}
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={cn('w-7 h-7 rounded flex items-center justify-center shrink-0', config.bg)}>
                      <IconComp className={cn('h-4 w-4', config.color)} />
                    </div>
                    <a
                      href={file.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-foreground hover:text-primary hover:underline truncate"
                      title={file.file_name}
                    >
                      {file.file_name}
                    </a>
                  </div>

                  {/* Size */}
                  <span className="text-xs text-muted-foreground">
                    {formatFileSize(file.file_size)}
                  </span>

                  {/* Uploaded by */}
                  <span className="text-xs text-muted-foreground truncate" title={file.uploaded_by_name}>
                    {file.uploaded_by_name || '—'}
                  </span>

                  {/* Date */}
                  <span className="text-xs text-muted-foreground">
                    {formatDate(file.created_at || file.created_date)}
                  </span>

                  {/* Actions */}
                  <div className="flex justify-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="p-1 rounded hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity">
                          <MoreVertical className="h-4 w-4 text-muted-foreground" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-36">
                        <DropdownMenuItem
                          onClick={() => {
                            // Use a hidden anchor with download attribute to trigger real download
                            const a = document.createElement('a');
                            a.href = file.file_url;
                            a.download = file.file_name || 'download';
                            a.target = '_blank';
                            a.rel = 'noopener noreferrer';
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                          }}
                          className="gap-2 text-xs"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Download
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setDeleteId(file.id)}
                          className="gap-2 text-xs text-destructive focus:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Drag overlay */}
      {dragOver && (
        <div className="absolute inset-0 bg-primary/5 border-2 border-dashed border-primary rounded-lg z-10 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <Upload className="h-8 w-8 text-primary" />
            <p className="text-sm font-medium text-primary">Drop files here to upload</p>
          </div>
        </div>
      )}

      {/* Upload progress overlay */}
      {uploading && (
        <div className="absolute inset-0 bg-background/60 z-20 flex items-center justify-center">
          <div className="flex items-center gap-2 bg-background border rounded-lg px-4 py-3 shadow-lg">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-sm font-medium">Uploading...</span>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteId && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={() => setDeleteId(null)}>
          <div className="bg-background rounded-lg border shadow-xl p-6 max-w-sm mx-4" onClick={e => e.stopPropagation()}>
            <h4 className="text-sm font-semibold mb-2">Delete file?</h4>
            <p className="text-xs text-muted-foreground mb-4">
              This will permanently delete "{files.find(f => f.id === deleteId)?.file_name}". This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setDeleteId(null)} disabled={deleting}>
                Cancel
              </Button>
              <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
