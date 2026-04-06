import React from 'react';
import { fixTimestamp } from '@/components/utils/dateUtils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Pin, Trash2, Download, FileText, Image, Music, Video } from 'lucide-react';
import { cn } from '@/lib/utils';

const getFileIcon = (fileType) => {
  if (!fileType) return FileText;
  if (fileType.startsWith('image')) return Image;
  if (fileType.startsWith('audio')) return Music;
  if (fileType.startsWith('video')) return Video;
  return FileText;
};

export default function ChatMessage({ message, currentUserEmail, onPin, onDelete, isEditable }) {
  const FileIcon = getFileIcon(message.attachments?.[0]?.file_type);

  return (
    <div
      className={cn(
        'group p-3 rounded-xl border transition-all duration-200',
        message.is_pinned 
          ? 'bg-amber-50 border-amber-200 shadow-sm' 
          : 'bg-white border-border hover:border-primary/30 hover:shadow-sm'
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-sm">{message.author_name}</p>
            {message.is_pinned && (
              <Pin className="h-3 w-3 text-amber-500 fill-amber-500" />
            )}
          </div>
          <p className="text-xs text-muted-foreground">
             {new Date(fixTimestamp(message.created_date)).toLocaleString('en-AU', {
               timeZone: 'Australia/Sydney',
               month: 'short',
               day: 'numeric',
               hour: '2-digit',
               minute: '2-digit',
               hour12: true
             })}
             {message.edited_at && ` (edited ${new Date(fixTimestamp(message.edited_at)).toLocaleString('en-AU', {
               timeZone: 'Australia/Sydney',
               month: 'short',
               day: 'numeric',
               hour: '2-digit',
               minute: '2-digit',
               hour12: true
             })})`}
           </p>
        </div>
        {isEditable && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => onPin(message.id, message.is_pinned)}
              title={message.is_pinned ? 'Unpin' : 'Pin'}
            >
              <Pin className={cn('h-3 w-3', message.is_pinned && 'fill-current text-amber-500')} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-destructive hover:text-destructive"
              onClick={() => onDelete(message.id)}
              title="Delete"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>

      {/* Content */}
      <p className="text-sm whitespace-pre-wrap break-words text-foreground leading-relaxed mb-2">
        {message.content}
      </p>

      {/* Mentions */}
      {message.mentions?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {message.mentions.map(mention => (
            <Badge key={mention} variant="secondary" className="text-xs font-medium">
              @{mention.split('@')[0]}
            </Badge>
          ))}
        </div>
      )}

      {/* Attachments */}
      {message.attachments?.length > 0 && (
        <div className="space-y-2">
          {message.attachments.map((attachment, idx) => {
            const Icon = getFileIcon(attachment.file_type);
            const isImage = attachment.file_type?.startsWith('image');
            
            return (
              <div key={idx}>
                {isImage ? (
                  <div className="rounded-lg overflow-hidden max-w-xs bg-muted">
                    <img
                      src={attachment.file_url}
                      alt={attachment.file_name || 'Attached image'}
                      loading="lazy"
                      className="w-full h-auto max-h-64 object-cover cursor-pointer hover:opacity-90"
                      onClick={() => window.open(attachment.file_url, '_blank')}
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  </div>
                ) : (
                  <a
                    href={attachment.file_url}
                    download={attachment.file_name}
                    className="flex items-center gap-2 p-2 rounded-lg bg-muted hover:bg-muted/80 transition-colors group/file"
                  >
                    <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span className="text-xs font-medium truncate flex-1">
                      {attachment.file_name}
                    </span>
                    <Download className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover/file:opacity-100 transition-opacity flex-shrink-0" />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}