import React, { useState, lazy, Suspense } from 'react';
import { api } from '@/api/supabaseClient';
import { useQueryClient } from '@tanstack/react-query';
const UnifiedNoteComposer = lazy(() => import('@/components/notes/UnifiedNoteComposer'));
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
    iconBg: 'bg-blue-100 dark:bg-blue-900/40',
    iconColor: 'text-blue-600 dark:text-blue-300',
    borderColor: 'border-blue-200 dark:border-blue-800',
    bgColor: 'bg-blue-50 dark:bg-blue-950/30',
    label: 'Note',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800',
  },
  email: {
    icon: Mail,
    iconBg: 'bg-purple-100 dark:bg-purple-900/40',
    iconColor: 'text-purple-600 dark:text-purple-300',
    borderColor: 'border-purple-200 dark:border-purple-800',
    bgColor: 'bg-purple-50 dark:bg-purple-950/30',
    label: 'Email',
    badgeClass: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800',
  },
  activity: {
    icon: Activity,
    iconBg: 'bg-muted',
    iconColor: 'text-muted-foreground',
    borderColor: 'border-border',
    bgColor: 'bg-muted/50',
    label: 'Activity',
    badgeClass: 'bg-muted text-muted-foreground border-border',
  },
};

export default function ProjectActivityFeedItem({
  item,
  projectId,
  project,
  isLast = false,
  // For notes
  onNoteRefresh,
  currentUser,
  noteReplies = [],
  // For emails
  isEmailOwner = false,
  // Optional smart timestamp formatter from parent
  smartTimestamp,
}) {
  const [expanded, setExpanded] = useState(false);
  const [replyType, setReplyType] = useState(null);
  const [isReplying, setIsReplying] = useState(false);
  const [repliesExpanded, setRepliesExpanded] = useState(true);

  // Sort note replies oldest-first for natural conversation flow
  const sortedReplies = noteReplies.length > 0
    ? [...noteReplies].sort((a, b) => new Date(fixTimestamp(a.created_date)) - new Date(fixTimestamp(b.created_date)))
    : [];
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

  const timestamp = smartTimestamp
    ? smartTimestamp(item.timestamp)
    : fmtTimestampCustom(item.timestamp, {
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
              <span className="text-sm font-semibold text-foreground truncate max-w-[160px]" title={item.author || 'Unknown'}>
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
                      ? 'text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/30'
                      : 'text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  <Pin className={`h-3.5 w-3.5 ${item._raw.is_pinned ? 'fill-amber-400' : ''}`} />
                </button>
              )}

              {/* Expand/collapse for emails. Notes always render in full now —
                  the activity feed is allowed to grow vertically; truncating
                  multi-paragraph notes was causing real content loss
                  (24 Carrington's 12-line note clipped to 6). */}
              {item.type === 'email' && (
                <button onClick={() => setExpanded(e => !e)} className="p-1 rounded text-muted-foreground hover:bg-muted/60 transition-colors">
                  {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
              )}

              {/* Email actions menu */}
              {item.type === 'email' && isEmailOwner && item._raw && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="p-1 rounded text-muted-foreground hover:bg-muted/60 transition-colors" aria-label="Email actions">
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
              {item._raw?.content_html ? (
                <div
                  className="text-sm text-foreground/80 prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(item._raw.content_html) }}
                />
              ) : (
                <p className="text-sm text-foreground/80 whitespace-pre-wrap">
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
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline bg-card/60 px-1.5 py-0.5 rounded border border-blue-100"
                    >
                      {att.file_name || 'Attachment'}
                    </a>
                  ))}
                </div>
              )}

              {/* Reply button + thread count */}
              <div className="flex items-center gap-3 mt-2 pt-1.5 border-t border-blue-100">
                <button
                  onClick={() => { setIsReplying(true); setRepliesExpanded(true); }}
                  className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  {isReplying ? 'Commenting...' : 'Add comment'}
                </button>
                {sortedReplies.length > 0 && (
                  <button
                    onClick={() => setRepliesExpanded(e => !e)}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors ml-auto"
                  >
                    {repliesExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    {sortedReplies.length} {sortedReplies.length === 1 ? 'comment' : 'comments'}
                  </button>
                )}
              </div>

              {/* Reply thread */}
              {(sortedReplies.length > 0 || isReplying) && (
                <div className="mt-2 border-t border-blue-100 dark:border-blue-900/40 pt-2">
                  {repliesExpanded && sortedReplies.map(reply => (
                    <div key={reply.id} className="flex gap-2 py-1.5">
                      <div className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 flex items-center justify-center text-[9px] font-bold shrink-0">
                        {(reply.author_name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-xs font-semibold text-foreground">{reply.author_name || 'Unknown'}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {fmtTimestampCustom(reply.created_date, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                          </span>
                        </div>
                        {reply.content_html ? (
                          <div
                            className="text-xs text-foreground/80 mt-0.5 prose prose-xs max-w-none"
                            dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(reply.content_html) }}
                          />
                        ) : (
                          <p className="text-xs text-foreground/80 mt-0.5 whitespace-pre-wrap">{reply.content}</p>
                        )}
                      </div>
                    </div>
                  ))}
                  {isReplying && (
                    <div className={sortedReplies.length > 0 && repliesExpanded ? 'pt-2 border-t border-blue-50 mt-1' : ''}>
                      <Suspense fallback={<div className="h-16 animate-pulse bg-muted/30 rounded" />}>
                        <UnifiedNoteComposer
                          agencyId={item._raw.agency_id || project?.agency_id}
                          projectId={projectId}
                          contextType="project"
                          contextLabel={project?.title || project?.property_address || 'Project'}
                          currentUser={currentUser}
                          isReply
                          parentNoteId={item._raw.id}
                          replyToAuthor={item._raw.author_name}
                          parentNoteAuthorEmail={item._raw.author_email}
                          onSave={() => { setIsReplying(false); onNoteRefresh?.(); }}
                          onCancel={() => setIsReplying(false)}
                        />
                      </Suspense>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {item.type === 'email' && (
            <>
              <p className="text-sm font-medium text-foreground/80 mt-1 truncate" title={item._raw?.subject || item.subject}>{item._raw?.subject || item.subject}</p>
              {!expanded && (
                <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">
                  {item._raw?.body?.replace(/<[^>]*>/g, '').substring(0, 150) || item.preview}
                </p>
              )}
              {expanded && item._raw && (
                <div className="mt-2 space-y-2 bg-muted/50 rounded-lg p-3 border">
                  <div className="space-y-1.5">
                    <div className="text-xs">
                      <span className="text-muted-foreground">From: </span>
                      <span className="text-foreground/80">{item._raw.from}</span>
                    </div>
                    <div className="text-xs">
                      <span className="text-muted-foreground">To: </span>
                      <span className="text-foreground/80">{item._raw.to?.join(', ')}</span>
                    </div>
                  </div>
                  <div className="border-t pt-2">
                    <div
                      className="text-sm text-foreground/80 prose prose-sm max-w-none"
                      dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(item._raw.body) }}
                    />
                  </div>
                  {item._raw.attachments?.length > 0 && (
                    <div className="border-t pt-2">
                      <p className="text-xs font-medium text-muted-foreground mb-1">
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
                          {att.size && <span className="text-muted-foreground/70">({(att.size / 1024).toFixed(1)} KB)</span>}
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
          onSent={() => {
            queryClient.invalidateQueries({ queryKey: ['project-emails'] });
            setReplyType(null);
          }}
          projectId={projectId}
        />
      )}
    </div>
  );
}
