import React, { useState, lazy, Suspense } from 'react';
import { api } from '@/api/supabaseClient';
import { useQueryClient } from '@tanstack/react-query';
const UnifiedNoteComposer = lazy(() => import('@/components/notes/UnifiedNoteComposer'));
import {
  MessageSquare, Mail, Activity, Pin, ChevronDown, ChevronUp,
  MoreVertical, Lock, Users, Reply, Share2, ArrowRight, Trash2,
  Edit, Paperclip, ListChecks, GitPullRequest,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { fmtTimestampCustom, fixTimestamp } from '@/components/utils/dateUtils';
import { toast } from 'sonner';
import ActivityLogItem from './ActivityLogItem';
import EmailComposeDialog from '@/components/email/EmailComposeDialog';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import AttachmentLightbox from '@/components/common/AttachmentLightbox';
import { usePermissions } from '@/components/auth/PermissionGuard';

// Use centralized sanitizer — covers script, style, iframe, object, embed, on* handlers,
// javascript:/data:/vbscript: URIs, base, form, meta, HTML comments, and head blocks.
import { sanitizeEmailHtml } from '@/utils/sanitizeHtml';

// Per-link-kind colour palette. The whole note "thread card" picks up these
// colours when `link_kind` is set on the note. Keep in sync with NoteLinkPicker.
const LINK_THEMES = {
  email: {
    border: 'border-green-200 dark:border-green-800',
    bg:     'bg-green-50 dark:bg-green-950/30',
    chip:   'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800',
    divider:'border-green-100 dark:border-green-900/40',
    Icon:   Mail,
    label:  'Email',
  },
  task: {
    border: 'border-orange-200 dark:border-orange-800',
    bg:     'bg-orange-50 dark:bg-orange-950/30',
    chip:   'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800',
    divider:'border-orange-100 dark:border-orange-900/40',
    Icon:   ListChecks,
    label:  'Task',
  },
  revision: {
    border: 'border-red-200 dark:border-red-800',
    bg:     'bg-red-50 dark:bg-red-950/30',
    chip:   'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
    divider:'border-red-100 dark:border-red-900/40',
    Icon:   GitPullRequest,
    label:  'Revision',
  },
  change_request: {
    border: 'border-purple-200 dark:border-purple-800',
    bg:     'bg-purple-50 dark:bg-purple-950/30',
    chip:   'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800',
    divider:'border-purple-100 dark:border-purple-900/40',
    Icon:   GitPullRequest,
    label:  'Change request',
  },
};

// Default note theme when there's no link.
const DEFAULT_NOTE_THEME = {
  border: 'border-blue-200 dark:border-blue-800',
  bg:     'bg-blue-50 dark:bg-blue-950/30',
  divider:'border-blue-100 dark:border-blue-900/40',
};

// TYPE_CONFIG drives the timeline icon dot + the type badge in the header.
// Email moved purple → green per the new linked-note colour scheme so the
// chrome stays consistent whether an email shows up directly in the feed or
// as a note's link target.
const TYPE_CONFIG = {
  note: {
    icon: MessageSquare,
    iconBg: 'bg-blue-100 dark:bg-blue-900/40',
    iconColor: 'text-blue-600 dark:text-blue-300',
    label: 'Note',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800',
  },
  email: {
    icon: Mail,
    iconBg: 'bg-green-100 dark:bg-green-900/40',
    iconColor: 'text-green-600 dark:text-green-300',
    label: 'Email',
    badgeClass: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800',
  },
  activity: {
    icon: Activity,
    iconBg: 'bg-muted',
    iconColor: 'text-muted-foreground',
    label: 'Activity',
    badgeClass: 'bg-muted text-muted-foreground border-border',
  },
};

// Hashed pastel avatar — same author always gets the same colour so threads
// are visually scannable. Lifted from UnifiedNoteCard.
const AVATAR_COLORS = [
  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
];

function avatarColor(name = '') {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function AuthorAvatar({ name, size = 'sm' }) {
  const initials = (name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const sizeCls = size === 'sm' ? 'w-6 h-6 text-[9px]' : 'w-7 h-7 text-[10px]';
  return (
    <div className={`${sizeCls} rounded-full ${avatarColor(name)} flex items-center justify-center font-bold shrink-0`}>
      {initials}
    </div>
  );
}

function isImageFile(name = '') {
  return /\.(jpg|jpeg|png|gif|webp|svg|bmp|tiff?)$/i.test(name);
}

// Image attachments render as 64-px thumbnails; non-images render as compact
// pill chips. Both open the lightbox on click. `tint` lets the parent push a
// link-themed colour so an emailed-linked note's pills feel consistent.
function AttachmentRow({ attachments, onOpen, tint = 'blue' }) {
  if (!attachments?.length) return null;
  const tintCls =
    tint === 'green'   ? 'bg-green-50 text-green-700 border-green-100 hover:bg-green-100' :
    tint === 'orange'  ? 'bg-orange-50 text-orange-700 border-orange-100 hover:bg-orange-100' :
    tint === 'red'     ? 'bg-red-50 text-red-700 border-red-100 hover:bg-red-100' :
    tint === 'purple'  ? 'bg-purple-50 text-purple-700 border-purple-100 hover:bg-purple-100' :
                         'bg-blue-50 text-blue-700 border-blue-100 hover:bg-blue-100';
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((a, i) => (
        isImageFile(a.file_name) ? (
          <button
            key={i}
            onClick={() => onOpen(i)}
            className="block rounded border border-border/60 overflow-hidden hover:ring-2 hover:ring-primary/40 transition-all cursor-pointer"
            aria-label={`Open ${a.file_name || 'attachment'}`}
          >
            <img src={a.file_url} alt={a.file_name} className="h-16 w-auto object-cover" draggable={false} />
          </button>
        ) : (
          <button
            key={i}
            onClick={() => onOpen(i)}
            className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border ${tintCls} transition-colors`}
          >
            <Paperclip className="h-3 w-3" />
            {a.file_name || `File ${i + 1}`}
          </button>
        )
      ))}
    </div>
  );
}

// Resolve link_kind on a note row → theme (or default). Treat is_deleted=true
// as no theme; the deleted placeholder always uses muted styling.
function themeForNote(rawNote) {
  if (!rawNote || rawNote.is_deleted) return DEFAULT_NOTE_THEME;
  const t = LINK_THEMES[rawNote.link_kind];
  return t || DEFAULT_NOTE_THEME;
}

// Small inline chip showing what a note links to. Click bubbles up so the
// parent can scroll/navigate to the linked entity if it wants — for now we
// just show, no navigation, since linked items already live on this same
// project page.
function LinkChip({ rawNote }) {
  const theme = LINK_THEMES[rawNote?.link_kind];
  if (!theme || !rawNote?.link_label) return null;
  const Icon = theme.Icon;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border ${theme.chip} max-w-full`}
      title={`Linked to ${theme.label}: ${rawNote.link_label}`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate max-w-[200px]">{rawNote.link_label}</span>
    </span>
  );
}

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
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [lightboxIdx, setLightboxIdx] = useState(null);

  const { isMasterAdmin } = usePermissions();
  const queryClient = useQueryClient();

  // Sort note replies oldest-first for natural conversation flow
  const sortedReplies = noteReplies.length > 0
    ? [...noteReplies].sort((a, b) => new Date(fixTimestamp(a.created_date)) - new Date(fixTimestamp(b.created_date)))
    : [];
  const config = TYPE_CONFIG[item.type] || TYPE_CONFIG.activity;
  const IconComponent = config.icon;

  // Theme: notes pick up the link's colour; everything else uses defaults.
  const noteTheme = item.type === 'note' ? themeForNote(item._raw) : DEFAULT_NOTE_THEME;
  const linkTint =
    item._raw?.link_kind === 'email' ? 'green' :
    item._raw?.link_kind === 'task'  ? 'orange' :
    item._raw?.link_kind === 'revision' ? 'red' :
    item._raw?.link_kind === 'change_request' ? 'purple' : 'blue';

  // ── Activity items delegate to ActivityLogItem ──
  if (item.type === 'activity' && item._raw) {
    return (
      <div className="relative">
        <ActivityLogItem activity={item._raw} />
      </div>
    );
  }

  const canEditNote = item.type === 'note' && item._raw && !item._raw.is_deleted &&
    (item._raw.author_email === currentUser?.email || isMasterAdmin);

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

  // ── Note delete (soft) ──
  // We use `is_deleted=true` rather than a hard DELETE so threads with replies
  // don't lose their parent — the thread still renders with a "[deleted]"
  // placeholder. The activity-hub query filters these out, but we keep the row
  // so parent_note_id pointers stay valid.
  const handleNoteDelete = async () => {
    if (item.type !== 'note' || !item._raw) return;
    try {
      await api.entities.OrgNote.update(item._raw.id, { is_deleted: true });
      toast.success('Note deleted');
      onNoteRefresh?.();
    } catch (err) {
      toast.error(err?.message || 'Failed to delete note');
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

  // Build the existing-link payload for the editor so toggling Edit on a
  // linked note pre-populates the picker rather than starting empty.
  const editorInitialLink = item._raw?.link_kind && item._raw?.link_kind !== null
    ? {
        kind:  item._raw.link_kind,
        id:    item._raw.linked_email_id || item._raw.linked_task_id || item._raw.linked_revision_id,
        label: item._raw.link_label,
      }
    : null;

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
              {item.type === 'note' && item._raw?.link_kind && (
                <LinkChip rawNote={item._raw} />
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
              {item.type === 'note' && item._raw && !item._raw.is_deleted && (
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

              {/* Note actions (edit / delete) — author or master_admin only */}
              {canEditNote && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="p-1 rounded text-muted-foreground hover:bg-muted/60 transition-colors" aria-label="Note actions">
                      <MoreVertical className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem onClick={() => setIsEditing(true)}>
                      <Edit className="h-3.5 w-3.5 mr-2" />Edit
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setShowDeleteConfirm(true)} className="text-destructive focus:text-destructive">
                      <Trash2 className="h-3.5 w-3.5 mr-2" />Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
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

          {/* Note body — editor when editing, themed card otherwise */}
          {item.type === 'note' && (
            isEditing && item._raw ? (
              <div className="mt-1.5">
                <Suspense fallback={<div className="h-24 animate-pulse bg-muted/30 rounded" />}>
                  <UnifiedNoteComposer
                    agencyId={item._raw.agency_id || project?.agency_id}
                    projectId={projectId}
                    contextType="project"
                    contextLabel={project?.title || project?.property_address || 'Project'}
                    currentUser={currentUser}
                    noteId={item._raw.id}
                    initialHtml={item._raw.content_html || item._raw.content}
                    initialMentions={Array.isArray(item._raw.mentions) ? item._raw.mentions : []}
                    initialLink={editorInitialLink}
                    onSave={() => { setIsEditing(false); onNoteRefresh?.(); }}
                    onCancel={() => setIsEditing(false)}
                  />
                </Suspense>
              </div>
            ) : (
            <div className={`mt-1.5 rounded-lg p-2.5 ${noteTheme.bg} border ${noteTheme.border}`}>
              {item._raw?.is_deleted ? (
                <p className="text-sm text-muted-foreground italic">
                  [Note deleted{item._raw.author_name ? ` by ${item._raw.author_name}` : ''}]
                </p>
              ) : item._raw?.content_html ? (
                <div
                  className="text-sm text-foreground/80 prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(item._raw.content_html) }}
                />
              ) : (
                <p className="text-sm text-foreground/80 whitespace-pre-wrap">
                  {item.content || item._raw?.content}
                </p>
              )}
              {/* Attachments — image thumbnails + lightbox */}
              {!item._raw?.is_deleted && item._raw?.attachments?.length > 0 && (
                <AttachmentRow
                  attachments={item._raw.attachments}
                  tint={linkTint}
                  onOpen={(i) => setLightboxIdx(i)}
                />
              )}
              {lightboxIdx != null && item._raw?.attachments?.length > 0 && (
                <AttachmentLightbox
                  files={item._raw.attachments}
                  initialIndex={lightboxIdx}
                  onClose={() => setLightboxIdx(null)}
                />
              )}

              {/* Reply button + thread count */}
              <div className={`flex items-center gap-3 mt-2 pt-1.5 border-t ${noteTheme.divider}`}>
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
                <div className={`mt-2 border-t ${noteTheme.divider} pt-2`}>
                  {repliesExpanded && sortedReplies.map(reply => (
                    <ReplyRow
                      key={reply.id}
                      reply={reply}
                      currentUser={currentUser}
                      isMasterAdmin={isMasterAdmin}
                      project={project}
                      projectId={projectId}
                      onRefresh={onNoteRefresh}
                    />
                  ))}
                  {isReplying && (
                    <div className={sortedReplies.length > 0 && repliesExpanded ? `pt-2 border-t ${noteTheme.divider} mt-1` : ''}>
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
            )
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

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete note?"
        description="This will hide the note from the activity feed. Replies will be preserved."
        confirmText="Delete"
        onConfirm={async () => { setShowDeleteConfirm(false); await handleNoteDelete(); }}
        onCancel={() => setShowDeleteConfirm(false)}
        danger
      />
    </div>
  );
}

// ── Reply row — author avatar + body + per-reply edit/delete ─────────────────
// Replies live inside the parent's themed card; their own theming is just a
// small link chip if they themselves link to something.
function ReplyRow({ reply, currentUser, isMasterAdmin, project, projectId, onRefresh }) {
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [lightboxIdx, setLightboxIdx] = useState(null);

  const canEdit = !reply.is_deleted &&
    (reply.author_email === currentUser?.email || isMasterAdmin);

  const initialLink = reply.link_kind
    ? {
        kind:  reply.link_kind,
        id:    reply.linked_email_id || reply.linked_task_id || reply.linked_revision_id,
        label: reply.link_label,
      }
    : null;

  const linkTint =
    reply.link_kind === 'email' ? 'green' :
    reply.link_kind === 'task'  ? 'orange' :
    reply.link_kind === 'revision' ? 'red' :
    reply.link_kind === 'change_request' ? 'purple' : 'blue';

  const handleDelete = async () => {
    try {
      await api.entities.OrgNote.update(reply.id, { is_deleted: true });
      toast.success('Comment deleted');
      onRefresh?.();
    } catch (err) {
      toast.error(err?.message || 'Failed to delete comment');
    }
  };

  if (isEditing) {
    return (
      <div className="py-1.5">
        <Suspense fallback={<div className="h-16 animate-pulse bg-muted/30 rounded" />}>
          <UnifiedNoteComposer
            agencyId={reply.agency_id || project?.agency_id}
            projectId={projectId}
            contextType="project"
            contextLabel={project?.title || project?.property_address || 'Project'}
            currentUser={currentUser}
            isReply
            parentNoteId={reply.parent_note_id}
            noteId={reply.id}
            initialHtml={reply.content_html || reply.content}
            initialMentions={Array.isArray(reply.mentions) ? reply.mentions : []}
            initialLink={initialLink}
            onSave={() => { setIsEditing(false); onRefresh?.(); }}
            onCancel={() => setIsEditing(false)}
          />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="flex gap-2 py-1.5 group/reply">
      <AuthorAvatar name={reply.author_name} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="text-xs font-semibold text-foreground">{reply.author_name || 'Unknown'}</span>
          <span className="text-[10px] text-muted-foreground">
            {fmtTimestampCustom(reply.created_date, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
          </span>
          {reply.link_kind && <LinkChip rawNote={reply} />}
          {canEdit && (
            <span className="ml-auto opacity-0 group-hover/reply:opacity-100 transition-opacity">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="p-0.5 rounded text-muted-foreground hover:bg-muted/60 transition-colors" aria-label="Comment actions">
                    <MoreVertical className="h-3 w-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-36">
                  <DropdownMenuItem onClick={() => setIsEditing(true)}>
                    <Edit className="h-3.5 w-3.5 mr-2" />Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setShowDeleteConfirm(true)} className="text-destructive focus:text-destructive">
                    <Trash2 className="h-3.5 w-3.5 mr-2" />Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          )}
        </div>
        {reply.is_deleted ? (
          <p className="text-xs text-muted-foreground italic mt-0.5">[Comment deleted]</p>
        ) : reply.content_html ? (
          <div
            className="text-xs text-foreground/80 mt-0.5 prose prose-xs max-w-none"
            dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(reply.content_html) }}
          />
        ) : (
          <p className="text-xs text-foreground/80 mt-0.5 whitespace-pre-wrap">{reply.content}</p>
        )}
        {!reply.is_deleted && reply.attachments?.length > 0 && (
          <AttachmentRow
            attachments={reply.attachments}
            tint={linkTint}
            onOpen={(i) => setLightboxIdx(i)}
          />
        )}
        {lightboxIdx != null && reply.attachments?.length > 0 && (
          <AttachmentLightbox
            files={reply.attachments}
            initialIndex={lightboxIdx}
            onClose={() => setLightboxIdx(null)}
          />
        )}
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete comment?"
        description="This will hide the comment from the thread."
        confirmText="Delete"
        onConfirm={async () => { setShowDeleteConfirm(false); await handleDelete(); }}
        onCancel={() => setShowDeleteConfirm(false)}
        danger
      />
    </div>
  );
}
