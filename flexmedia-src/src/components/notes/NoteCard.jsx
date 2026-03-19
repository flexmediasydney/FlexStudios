import React, { useState } from 'react';
import { format } from 'date-fns';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MessageCircle, MoreVertical, Pin, Trash2, FileIcon, Link as LinkIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { base44 } from '@/api/base44Client';

export default function NoteCard({ 
  note, 
  onReply,
  onRefresh,
  isReply = false,
  replyCount = 0
}) {
  const [isLoading, setIsLoading] = useState(false);

  const handlePin = async () => {
    setIsLoading(true);
    try {
      await base44.entities.OrgNote.update(note.id, { is_pinned: !note.is_pinned });
      onRefresh?.();
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (confirm('Delete this note?')) {
      setIsLoading(true);
      try {
        await base44.entities.OrgNote.delete(note.id);
        onRefresh?.();
      } finally {
        setIsLoading(false);
      }
    }
  };

  return (
    <Card className={`p-3 space-y-2 border-l-2 ${isReply ? 'border-l-blue-400 bg-blue-50/20' : 'border-l-amber-400 bg-amber-50/20'}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{note.author_name}</span>
            <span className="text-xs text-muted-foreground">
              {(() => { try { if (!note.created_date) return '—'; return format(new Date(note.created_date), 'dd MMM yyyy, HH:mm'); } catch { return '—'; } })()}
            </span>
            {note.is_pinned && (
              <Badge variant="secondary" className="text-xs gap-1 bg-orange-100 text-orange-700">
                <Pin className="h-3 w-3" />
                Pinned
              </Badge>
            )}
          </div>
        </div>
        
        {/* Actions */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handlePin}>
              <Pin className="h-4 w-4 mr-2" />
              {note.is_pinned ? 'Unpin' : 'Pin'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onReply?.(note.id)}>
              <MessageCircle className="h-4 w-4 mr-2" />
              Reply
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleDelete} className="text-red-600">
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Mentions */}
      {note.mentions && note.mentions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {note.mentions.map(m => (
            <Badge key={m.email} className="bg-blue-100 text-blue-700 text-xs">
              @{m.name}
            </Badge>
          ))}
        </div>
      )}

      {/* Focus Tags */}
      {note.focus_tags && note.focus_tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {note.focus_tags.map(tag => (
            <Badge key={tag} variant="outline" className="text-xs bg-purple-50 text-purple-700">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
        {note.content}
      </div>

      {/* Attachments */}
      {note.attachments && note.attachments.length > 0 && (
        <div className="space-y-2 pt-2 border-t">
          <div className="text-xs font-medium text-muted-foreground">Attachments ({note.attachments.length})</div>
          <div className="space-y-1">
            {note.attachments.map((att, idx) => (
              <a
                key={idx}
                href={att.file_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 p-2 rounded bg-white hover:bg-gray-50 border text-xs hover:text-blue-600 transition-colors"
              >
                <FileIcon className="h-4 w-4 shrink-0" />
                <span className="truncate flex-1">{att.file_name}</span>
                {att.file_size != null && (
                  <span className="text-muted-foreground text-xs shrink-0">
                    {(att.file_size / 1024).toFixed(0)}KB
                  </span>
                )}
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Reply actions row */}
      {!isReply && (
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={() => onReply?.(note.id)}
            className="text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
          >
            <MessageCircle className="h-3 w-3" />
            {replyCount > 0 ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Reply'}
          </button>
        </div>
      )}
    </Card>
  );
}