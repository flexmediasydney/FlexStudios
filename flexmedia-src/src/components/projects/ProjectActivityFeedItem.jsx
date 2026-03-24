import React, { useState } from 'react';
import { api } from '@/api/supabaseClient';
import { useQueryClient } from '@tanstack/react-query';
import {
  MessageSquare, Mail, Activity, Pin, ChevronDown, ChevronUp,
  MoreVertical, Lock, Users, Reply, Share2, ArrowRight, Trash2
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { fmtTimestampCustom } from '@/components/utils/dateUtils';
import { toast } from 'sonner';
import ActivityLogItem from './ActivityLogItem';
import EmailComposeDialog from '@/components/email/EmailComposeDialog';

// Use centralized sanitizer — covers script, style, iframe, object, embed, on* handlers,
// javascript:/data:/vbscript: URIs, base, form, meta, HTML comments, and head blocks.
import { sanitizeEmailHtml } from '@/utils/sanitizeHtml';

const TYPE_CONFIG = {
  note: {
    icon: MessageSquare,
    iconBg: 'bg-blue-100',
    iconColor: 'text-blue-600',
    borderColor: 'border-blue-200',
    bgColor: 'bg-blue-50',
    label: 'Note',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
  },
  email: {
    icon: Mail,
    iconBg: 'bg-purple-100',
    iconColor: 'text-purple-600',
    borderColor: 'border-purple-200',
    bgColor: 'bg-purple-50',
    label: 'Email',
    badgeClass: 'bg-purple-50 text-purple-700 border-purple-200',
  },
  activity: {
    icon: Activity,
    iconBg: 'bg-gray-100',
    iconColor: 'text-gray-600',
    borderColor: 'border-gray-200',
    bgColor: 'bg-gray-50',
    label: 'Activity',
    badgeClass: 'bg-gray-50 text-gray-700 border-gray-200',
  },
};

export default function ProjectActivityFeedItem({
  item,
  projectId,
  isLast = false,
  // For notes
  onNoteRefresh,
  currentUser,
  // For emails
  isEmailOwner = false,
}) {
  const [expanded, setExpanded] = useState(false);
  const [replyType, setReplyType] = useState(null);
  const queryClient = useQueryClient();
  const config = TYPE_CONFIG[item.type] || TYPE_CONFIG.activity;
  const IconComponent = config.icon;

  // ── Activity items delegate to ActivityLogItem ──
  if (item.type === 'activity' && item._raw) {
    return (
      <div className="relative">
        <ActivityLogItem activity={item._raw} />
      </div>
    );
  }

  // ── Note pin toggle ──
  const handleTogglePin = async () => {
    if (item.type !== 'note' || !item._raw) return;
    try {
      await api.entities.OrgNote.update(item._raw.id, { is_pinned: !item._raw.is_pinned });
      onNoteRefresh?.();
    } catch {
      toast.error('Failed to update pin');
    }
  };

  // ── Email mutations ──
  const handleEmailDelete = async () => {
    if (item.type !== 'email' || !item._raw) return;
    try {
      await api.entities.EmailMessage.update(item._raw.id, {
        is_deleted: true, project_id: null, project_title: null,
      });
      queryClient.invalidateQueries({ queryKey: ['project-emails'] });
      toast.success('Email removed from project');
    } catch (err) {
      toast.error(err?.message || 'Failed to remove email');
    }
  };

  const handleEmailVisibilityToggle = async () => {
    if (!isEmailOwner || !item._raw) return;
    const next = item._raw.visibility === 'shared' ? 'private' : 'shared';
    try {
      await api.entities.EmailMessage.update(item._raw.id, { visibility: next });
      queryClient.invalidateQueries({ queryKey: ['project-emails'] });
      toast.success('Updated');
    } catch (err) {
      toast.error(err?.message || 'Failed to update');
    }
  };

  const timestamp = fmtTimestampCustom(item.timestamp, {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });

  return (
    <div className="relative group">
      <div className="flex gap-3">
        {/* Timeline icon + connector */}
        <div className="flex flex-col items-center flex-shrink-0">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${config.iconBg}`}>
            <IconComponent className={`h-4 w-4 ${config.iconColor}`} />
          </div>
          {!isLast && <div className="w-0.5 flex-1 bg-border mt-1 min-h-[16px]" />}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 pb-5">
          {/* Header row */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <span className="text-sm font-semibold text-foreground truncate">
                {item.author || 'Unknown'}
              </span>
              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${config.badgeClass} border`}>
                {config.label}
              </Badge>
              {item.type === 'note' && item._raw?.is_pinned && (
                <Pin className="h-3 w-3 fill-amber-400 text-amber-500 flex-shrink-0" />
              )}
              {item.type === 'email' && item._raw && (
                <span className="flex items-center gap-0.5">
                  {item._raw.visibility === 'shared'
                    ? <Users className="h-3 w-3 text-blue-500" />
                    : <Lock className="h-3 w-3 text-muted-foreground" />
                  }
                </span>
              )}
              <span className="text-xs text-muted-foreground flex-shrink-0">{timestamp}</span>
            </div>

            {/* Right-side actions */}
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
              {/* Pin toggle for notes */}
              {item.type === 'note' && item._raw && (
                <button
                  onClick={handleTogglePin}
                  title={item._raw.is_pinned ? 'Unpin' : 'Pin'}
                  className={`p-1 rounded transition-colors ${
                    item._raw.is_pinned
                      ? 'text-amber-500 hover:bg-amber-50'
                      : 'text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  <Pin className={`h-3.5 w-3.5 ${item._raw.is_pinned ? 'fill-amber-400' : ''}`} />
                </button>
              )}

              {/* Expand/collapse for emails and notes with long content */}
              {(item.type === 'email' || (item.type === 'note' && (item._raw?.content_html || '').length > 200)) && (
                <button onClick={() => setExpanded(e => !e)} className="p-1 rounded text-muted-foreground hover:bg-muted/60 transition-colors">
                  {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
              )}

              {/* Email actions menu */}
              {item.type === 'email' && isEmailOwner && item._raw && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="p-1 rounded text-muted-foreground hover:bg-muted/60 transition-colors">
                      <MoreVertical className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onClick={handleEmailVisibilityToggle}>
                      {item._raw.visibility === 'shared'
                        ? <><Lock className="h-3.5 w-3.5 mr-2" />Make Private</>
                        : <><Users className="h-3.5 w-3.5 mr-2" />Make Shared</>
                      }
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setReplyType('reply')}>
                      <Reply className="h-3.5 w-3.5 mr-2" />Reply
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setReplyType('replyAll')}>
                      <Share2 className="h-3.5 w-3.5 mr-2" />Reply All
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setReplyType('forward')}>
                      <ArrowRight className="h-3.5 w-3.5 mr-2" />Forward
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleEmailDelete} className="text-destructive focus:text-destructive">
                      <Trash2 className="h-3.5 w-3.5 mr-2" />Remove from project
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>

          {/* Content preview / body */}
          {item.type === 'note' && (
            <div className={`mt-1.5 rounded-lg p-2.5 ${config.bgColor} border ${config.borderColor}`}>
              {item._raw?.content_html && !expanded ? (
                <p className="text-sm text-gray-700 line-clamp-3 whitespace-pre-wrap">
                  {item._raw.content || item._raw.content_html?.replace(/<[^>]*>/g, '').substring(0, 200)}
                </p>
              ) : item._raw?.content_html && expanded ? (
                <div
                  className="text-sm text-gray-700 prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(item._raw.content_html) }}
                />
              ) : (
                <p className="text-sm text-gray-700 whitespace-pre-wrap">
                  {item.content || item._raw?.content}
                </p>
              )}
              {/* Attachments */}
              {item._raw?.attachments?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {item._raw.attachments.map((att, i) => (
                    <a
                      key={i}
                      href={att.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline bg-white/60 px-1.5 py-0.5 rounded border border-blue-100"
                    >
                      {att.file_name || 'Attachment'}
                    </a>
                  ))}
                </div>
              )}
              {/* Reply thread */}
              {item._replies?.length > 0 && (
                <div className="mt-2 border-t border-blue-100 pt-2 space-y-1.5">
                  <p className="text-[11px] font-medium text-blue-600">
                    {item._replies.length} {item._replies.length === 1 ? 'reply' : 'replies'}
                  </p>
                  {item._replies.map(reply => (
                    <div key={reply.id} className="flex gap-2 pl-1">
                      <div className="w-5 h-5 rounded-full bg-blue-200 flex items-center justify-center text-[8px] font-bold text-blue-700 shrink-0 mt-0.5">
                        {(reply.author_name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}
                      </div>
                      <div className="min-w-0">
                        <span className="text-[11px] font-semibold text-gray-700">{reply.author_name || 'Unknown'}</span>
                        <p className="text-xs text-gray-600 whitespace-pre-wrap">{reply.content}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {item.type === 'email' && (
            <>
              <p className="text-sm font-medium text-gray-700 mt-1">{item._raw?.subject || item.subject}</p>
              {!expanded && (
                <p className="text-sm text-gray-500 mt-0.5 line-clamp-2">
                  {item._raw?.body?.replace(/<[^>]*>/g, '').substring(0, 150) || item.preview}
                </p>
              )}
              {expanded && item._raw && (
                <div className="mt-2 space-y-2 bg-gray-50 rounded-lg p-3 border border-gray-200">
                  <div className="space-y-1.5">
                    <div className="text-xs">
                      <span className="text-gray-500">From: </span>
                      <span className="text-gray-700">{item._raw.from}</span>
                    </div>
                    <div className="text-xs">
                      <span className="text-gray-500">To: </span>
                      <span className="text-gray-700">{item._raw.to?.join(', ')}</span>
                    </div>
                  </div>
                  <div className="border-t pt-2">
                    <div
                      className="text-sm text-gray-700 prose prose-sm max-w-none"
                      dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(item._raw.body) }}
                    />
                  </div>
                  {item._raw.attachments?.length > 0 && (
                    <div className="border-t pt-2">
                      <p className="text-xs font-medium text-gray-600 mb-1">
                        Attachments ({item._raw.attachments.length})
                      </p>
                      {item._raw.attachments.map((att, i) => (
                        <a
                          key={i}
                          href={att.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
                        >
                          {att.filename}
                          {att.size && <span className="text-gray-400">({(att.size / 1024).toFixed(1)} KB)</span>}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {/* Non-owner read-only notice */}
              {!isEmailOwner && item._raw && (
                <p className="text-[11px] text-muted-foreground mt-1 italic">
                  View only — reply from your own inbox if you are part of this thread
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Email reply/forward compose */}
      {replyType && isEmailOwner && item._raw && (
        <EmailComposeDialog
          email={item._raw}
          account={{ id: item._raw.email_account_id, email_address: item._raw.from }}
          type={replyType}
          onClose={() => setReplyType(null)}
          onSent={() => queryClient.invalidateQueries({ queryKey: ['project-emails'] })}
          projectId={projectId}
        />
      )}
    </div>
  );
}
