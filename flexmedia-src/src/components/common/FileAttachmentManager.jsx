import React, { useState, useRef } from "react";
import { api } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { 
  Paperclip, Upload, X, Download, Loader2,
  FileText, Image, Music, Video, File
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { safeWindowOpen } from '@/utils/sanitizeHtml';

/**
 * Unified file attachment manager with:
 * - Multi-file upload with progress
 * - File type detection & icons
 * - Image preview
 * - Download affordances
 * - Remove capability
 * - Read-only mode
 */

const getFileIcon = (mimeType) => {
  if (!mimeType) return FileText;
  if (mimeType.startsWith('image')) return Image;
  if (mimeType.startsWith('audio') || mimeType.startsWith('video/audio')) return Music;
  if (mimeType.startsWith('video')) return Video;
  return FileText;
};

const formatFileSize = (bytes) => {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1) + " " + sizes[i];
};

export default function FileAttachmentManager({
  attachments = [],
  onChange,
  readOnly = false,
  maxFiles = 10,
  maxSizeBytes = 50 * 1024 * 1024, // 50MB default
  showLabel = true,
  label = "Attachments"
}) {
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef();
  const dragRef = useRef();

  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    // Validate count
    if (attachments.length + files.length > maxFiles) {
      toast.error(`Maximum ${maxFiles} files allowed`);
      return;
    }

    // Validate sizes
    const invalid = files.filter(f => f.size > maxSizeBytes);
    if (invalid.length > 0) {
      toast.error(`File size must be under ${Math.round(maxSizeBytes / 1024 / 1024)}MB`);
      return;
    }

    setUploading(true);
    try {
      const uploaded = [];
      for (const file of files) {
        const { file_url } = await api.integrations.Core.UploadFile({ file });
        uploaded.push({
          file_url,
          file_name: file.name,
          file_type: file.type,
          file_size: file.size,
          uploaded_at: new Date().toISOString()
        });
      }
      onChange([...attachments, ...uploaded]);
      toast.success(`${uploaded.length} file(s) attached`);
    } catch (e) {
      console.error("File upload error:", e);
      toast.error("File upload failed. Please check the file and try again.");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const remove = (idx) => {
    onChange(attachments.filter((_, i) => i !== idx));
  };

  const isImage = (mimeType) => mimeType?.startsWith('image');

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (readOnly || uploading) return;
    
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) {
      const event = { target: { files, value: "" } };
      await handleFileChange(event);
    }
  };

  return (
    <div className="space-y-3">
       {/* Header */}
       {showLabel && (
         <div className="flex items-center gap-2">
           <label className="text-xs font-medium flex items-center gap-1.5">
             <Paperclip className="h-3.5 w-3.5" />
             {label}
             {!readOnly && <span className="text-muted-foreground">({attachments.length}/{maxFiles})</span>}
           </label>
           {!readOnly && (
             <Button
               type="button"
               size="sm"
               variant="outline"
               className="h-7 text-xs ml-auto"
               onClick={() => inputRef.current?.click()}
               disabled={uploading || attachments.length >= maxFiles}
               title={attachments.length >= maxFiles ? `Maximum ${maxFiles} files reached` : 'Add files'}
             >
               {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Upload className="h-3.5 w-3.5 mr-1" />}
               {uploading ? "Uploading..." : "Add Files"}
             </Button>
           )}
           <input
             ref={inputRef}
             type="file"
             multiple
             className="hidden"
             accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip"
             onChange={handleFileChange}
             disabled={uploading || attachments.length >= maxFiles}
           />
         </div>
       )}

       {/* Drag & Drop Zone */}
       {!readOnly && attachments.length < maxFiles && (
         <div
           ref={dragRef}
           onDragEnter={handleDrag}
           onDragLeave={handleDrag}
           onDragOver={handleDrag}
           onDrop={handleDrop}
           className={cn(
             "border-2 border-dashed rounded-lg p-4 text-center transition-all cursor-pointer",
             dragActive
               ? "border-primary bg-primary/5 scale-105"
               : "border-muted-foreground/30 bg-muted/20 hover:border-muted-foreground/50 hover:bg-muted/30"
           )}
           onClick={() => !uploading && inputRef.current?.click()}
           title="Drag files here or click to select"
         >
           <Upload className={cn("h-5 w-5 mx-auto mb-2 transition-colors", dragActive ? "text-primary" : "text-muted-foreground")} />
           <p className="text-xs font-medium">
             {dragActive ? "Drop files here" : "Drag files or click to upload"}
           </p>
           <p className="text-xs text-muted-foreground mt-0.5">
             Max {Math.round(maxSizeBytes / 1024 / 1024)}MB per file
           </p>
         </div>
       )}

       {/* Empty state */}
       {attachments.length === 0 && readOnly && (
         <p className="text-xs text-muted-foreground italic">
           No attachments
         </p>
       )}

      {/* Attachments list */}
      {attachments.length > 0 && (
        <div className="space-y-2">
          {attachments.map((att, i) => {
            const Icon = getFileIcon(att.file_type);
            const isImg = isImage(att.file_type);

            return (
              <div key={i} className={cn(
                "rounded-lg overflow-hidden transition-all",
                isImg ? "bg-muted" : "bg-muted/30 border"
              )}>
                {isImg ? (
                  // Image preview
                  <div className="group/img relative max-w-xs">
                    <img
                      src={att.file_url}
                      alt={att.file_name || 'Attached image'}
                      loading="lazy"
                      className="w-full h-auto max-h-48 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                      onClick={() => safeWindowOpen(att.file_url)}
                      onError={(e) => { e.target.style.display = 'none'; }}
                      title="Click to open full size"
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/5 transition-colors flex items-center justify-center">
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() => remove(i)}
                          className="opacity-0 group-hover/img:opacity-100 transition-opacity p-1 bg-destructive text-white rounded hover:bg-destructive/90"
                          title="Remove attachment"
                          aria-label={`Remove ${att.file_name || 'attachment'}`}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                    {/* Filename overlay at bottom */}
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2">
                      <p className="text-xs text-white font-medium truncate">
                        {att.file_name}
                      </p>
                    </div>
                  </div>
                ) : (
                  // File link
                  <div className="flex items-center gap-2 p-2.5 group/file">
                    <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <a
                        href={att.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium truncate text-primary hover:underline block"
                        title={att.file_name}
                      >
                        {att.file_name}
                      </a>
                      {att.file_size && (
                        <p className="text-xs text-muted-foreground">
                          {formatFileSize(att.file_size)}
                        </p>
                      )}
                    </div>
                    <a
                      href={att.file_url}
                      download={att.file_name}
                      className="text-muted-foreground hover:text-primary opacity-0 group-hover/file:opacity-100 transition-opacity flex-shrink-0"
                      title="Download file"
                      aria-label={`Download ${att.file_name || 'file'}`}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() => remove(i)}
                        className="text-muted-foreground hover:text-destructive opacity-0 group-hover/file:opacity-100 transition-opacity flex-shrink-0"
                        title="Remove attachment"
                        aria-label={`Remove ${att.file_name || 'attachment'}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}