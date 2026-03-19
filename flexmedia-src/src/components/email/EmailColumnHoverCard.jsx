import React from 'react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Badge } from "@/components/ui/badge";
import { Users, Lock, FileText, AlertCircle } from 'lucide-react';
import { cn } from "@/lib/utils";

export function FromHoverCard({ email, name, children }) {
  if (!email) return children;
  
  return (
    <HoverCard openDelay={400} closeDelay={100}>
      <HoverCardTrigger asChild>
        {children}
      </HoverCardTrigger>
      <HoverCardContent side="right" className="w-64 p-3">
        <div className="space-y-2">
          <div>
            <p className="text-xs font-semibold text-muted-foreground">From</p>
            <p className="text-sm font-medium break-all">{name || email}</p>
            <p className="text-xs text-muted-foreground font-mono">{email}</p>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export function SubjectHoverCard({ subject, preview, labels = [], from, fromEmail, date, messageCount, attachmentCount, children }) {
  if (!subject && !preview) return children;

  return (
    <HoverCard openDelay={500} closeDelay={150}>
      <HoverCardTrigger asChild>
        {children}
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" className="w-96 p-0 overflow-hidden">
        <div className="space-y-0">
          {/* Header */}
          <div className="px-4 pt-3 pb-2 bg-slate-50/80 border-b border-slate-100">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-bold text-foreground line-clamp-2 leading-snug flex-1">{subject || '(no subject)'}</p>
              {messageCount > 1 && (
                <span className="flex-shrink-0 text-[10px] font-bold text-slate-500 bg-slate-200 rounded-full px-1.5 py-0.5">{messageCount}</span>
              )}
            </div>
            {(from || fromEmail) && (
              <p className="text-xs text-muted-foreground mt-1 truncate">
                {from && <span className="font-medium text-foreground/80">{from}</span>}
                {fromEmail && from && <span className="mx-1 text-muted-foreground/40">&middot;</span>}
                {fromEmail && <span className="font-mono text-[11px]">{fromEmail}</span>}
              </p>
            )}
            {date && (
              <p className="text-[10px] text-muted-foreground/70 mt-0.5">{date}</p>
            )}
          </div>

          {/* Body preview */}
          {preview && (
            <div className="px-4 py-3">
              <p className="text-xs text-foreground/75 line-clamp-5 leading-relaxed whitespace-pre-wrap">{preview}</p>
            </div>
          )}

          {/* Footer: labels + attachment count */}
          {(labels.length > 0 || attachmentCount > 0) && (
            <div className="px-4 py-2 border-t border-slate-100 bg-slate-50/40 flex items-center gap-2 flex-wrap">
              {labels.map((label) => (
                <Badge key={label} variant="secondary" className="text-[10px] h-5">
                  {label}
                </Badge>
              ))}
              {attachmentCount > 0 && (
                <span className="text-[10px] text-muted-foreground/70 flex items-center gap-1">
                  📎 {attachmentCount} file{attachmentCount !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export function AttachmentsHoverCard({ attachments = [], children }) {
  if (!attachments || attachments.length === 0) return children;
  
  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };
  
  const getFileIcon = (mimeType) => {
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('video/')) return '🎥';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.includes('pdf')) return '📄';
    if (mimeType.includes('word') || mimeType.includes('document')) return '📝';
    if (mimeType.includes('sheet') || mimeType.includes('excel')) return '📊';
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '🎯';
    return '📎';
  };
  
  return (
    <HoverCard openDelay={400} closeDelay={100}>
      <HoverCardTrigger asChild>
        {children}
      </HoverCardTrigger>
      <HoverCardContent side="right" className="w-72 p-3">
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">
            {attachments.length} attachment{attachments.length !== 1 ? 's' : ''}
          </p>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {attachments.map((att, idx) => (
              <div key={idx} className="flex items-start gap-2 p-2 rounded-md bg-muted/30 border border-border/40">
                <span className="text-lg flex-shrink-0">{getFileIcon(att.mime_type)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate break-all">{att.filename || 'Unknown'}</p>
                  <p className="text-[10px] text-muted-foreground">{formatBytes(att.size || 0)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export function ProjectHoverCard({ projectTitle, projectId, children }) {
  if (!projectTitle) return children;
  
  return (
    <HoverCard openDelay={400} closeDelay={100}>
      <HoverCardTrigger asChild>
        {children}
      </HoverCardTrigger>
      <HoverCardContent side="right" className="w-64 p-3">
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">Linked Project</p>
          <div className="flex items-start gap-2">
            <FileText className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium line-clamp-2">{projectTitle}</p>
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{projectId}</p>
            </div>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export function VisibilityHoverCard({ visibility, isShared, children }) {
  const message = isShared 
    ? "This email is visible in linked projects"
    : "This email is private and only visible to you";
  
  return (
    <HoverCard openDelay={400} closeDelay={100}>
      <HoverCardTrigger asChild>
        {children}
      </HoverCardTrigger>
      <HoverCardContent side="right" className="w-56 p-3">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {isShared ? (
              <Users className="h-4 w-4 text-blue-600" />
            ) : (
              <Lock className="h-4 w-4 text-muted-foreground" />
            )}
            <p className="text-sm font-medium">
              {isShared ? 'Shared' : 'Private'}
            </p>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{message}</p>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}