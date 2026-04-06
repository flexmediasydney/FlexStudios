import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Building2, MapPin, User, Users, Pin, Edit, Trash2, MessageSquare, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { api } from '@/api/supabaseClient';
import { toast } from 'sonner';
import ActionMenu from '@/components/common/ActionMenu';
import { fixTimestamp } from '@/components/utils/dateUtils';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import UnifiedNoteComposer from './UnifiedNoteComposer';

const CONTEXT_ICON = { agency: Building2, project: MapPin, agent: User, team: Users };

const AVATAR_COLORS = [
  'bg-blue-100 text-blue-700',
  'bg-purple-100 text-purple-700',
  'bg-green-100 text-green-700',
  'bg-orange-100 text-orange-700',
  'bg-pink-100 text-pink-700',
  'bg-teal-100 text-teal-700',
  'bg-indigo-100 text-indigo-700',
  'bg-rose-100 text-rose-700',
];

function avatarColor(name = '') {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function AuthorAvatar({ name, size = 'md' }) {
  const initials = (name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const colorCls = avatarColor(name);
  const sizeCls = size === 'sm' ? 'w-6 h-6 text-[9px]' : 'w-8 h-8 text-[11px]';
  return (
    <div className={`${sizeCls} rounded-full ${colorCls} flex items-center justify-center font-bold shrink-0`}>
      {initials}
    </div>
  );
}

const APP_TZ = 'Australia/Sydney';

function toSydneyDateStr(utcStr) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(fixTimestamp(utcStr)));
}

function relativeTime(utcStr) {
  if (!utcStr) return '';
  try {
    const date = new Date(fixTimestamp(utcStr));
    const sydneyDate = toSydneyDateStr(utcStr);
    const todayStr = toSydneyDateStr(new Date().toISOString());
    const yesterdayStr = toSydneyDateStr(
      new Date(Date.now() - 86400000).toISOString()
    );
    const timeStr = new Intl.DateTimeFormat('en-AU', {
      timeZone: APP_TZ, hour: 'numeric', minute: '2-digit', hour12: true
    }).format(date);
    const weekdayStr = new Intl.DateTimeFormat('en-AU', {
      timeZone: APP_TZ, weekday: 'long'
    }).format(date);
    const fullDateStr = new Intl.DateTimeFormat('en-AU', {
      timeZone: APP_TZ, day: 'numeric', month: 'short'
    }).format(date);

    const diffDays = Math.floor(
      (Date.now() - date.getTime()) / 86400000
    );

    if (sydneyDate === todayStr) return `Today at ${timeStr}`;
    if (sydneyDate === yesterdayStr) return `Yesterday at ${timeStr}`;
    if (diffDays < 7) return `${weekdayStr} at ${timeStr}`;
    return `${fullDateStr} at ${timeStr}`;
  } catch { return ''; }
}

// Use centralized sanitizer — covers script, iframe, object, embed, on* handlers,
// javascript:/data:/vbscript: URIs, base, form, meta, and HTML comments.
import { sanitizeDisplayHtml as sanitizeDisplay } from '@/utils/sanitizeHtml';

function ReplyBubble({ reply }) {
  const replyAttachments = Array.isArray(reply.attachments) ? reply.attachments : [];
  return (
    <div className="flex gap-2.5 py-2">
      <AuthorAvatar name={reply.author_name} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
           <span className="text-xs font-semibold text-foreground">{reply.author_name || 'Unknown'}</span>
           <span className="text-[10px] text-muted-foreground">{relativeTime(reply.created_at || reply.created_date)}</span>
         </div>
        {reply.content_html ? (
          <div
            className="text-xs text-foreground/80 mt-0.5 prose prose-xs max-w-none"
            dangerouslySetInnerHTML={{ __html: sanitizeDisplay(reply.content_html) }}
          />
        ) : (
          <p className="text-xs text-foreground/80 mt-0.5 whitespace-pre-wrap">{reply.content}</p>
        )}
        {replyAttachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {replyAttachments.map((att, i) => {
              const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(att.file_name || '');
              return isImage ? (
                <a key={i} href={att.file_url} target="_blank" rel="noopener noreferrer" className="block">
                  <img src={att.file_url} alt={att.file_name} className="h-16 w-auto rounded border hover:opacity-80 transition-opacity" />
                </a>
              ) : (
                <a key={i} href={att.file_url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-muted hover:bg-muted/80 text-foreground border transition-colors">
                  📎 {att.file_name || `File ${i + 1}`}
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function UnifiedNoteCard({ note, replies = [], showContext, onRefresh, currentUser, isMasterAdmin }) {
  const [isReplying, setIsReplying] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [repliesExpanded, setRepliesExpanded] = useState(true);
  const [pinLoading, setPinLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const isLegacy = note._isLegacy;
  const canEdit = !isLegacy && (note.author_email === currentUser?.email || isMasterAdmin);
  const ContextIcon = CONTEXT_ICON[note.context_type] || Building2;

  // Sort replies oldest-first for natural conversation flow
  const sortedReplies = [...replies].sort((a, b) => new Date(fixTimestamp(a.created_date)) - new Date(fixTimestamp(b.created_date)));

  const contextLink = note.context_type === 'project' && note.project_id
    ? createPageUrl(`ProjectDetails?id=${note.project_id}`)
    : note.context_type === 'agent' && note.agent_id
    ? createPageUrl(`PersonDetails?id=${note.agent_id}`)
    : note.context_type === 'team' && note.team_id
    ? createPageUrl(`TeamDetails?id=${note.team_id}`)
    : null;

  const handleTogglePin = async () => {
    setPinLoading(true);
    try {
      await api.entities.OrgNote.update(note.id, { is_pinned: !note.is_pinned });
      onRefresh?.();
    } catch {
      toast.error('Failed to update pin');
    } finally {
      setPinLoading(false);
    }
  };

  const handleDelete = async () => {
    setDeleteLoading(true);
    try {
      await api.entities.OrgNote.delete(note.id);
      onRefresh?.();
    } catch {
      toast.error('Failed to delete note');
    } finally {
      setDeleteLoading(false);
    }
  };

  const menuActions = [
    ...(canEdit ? [
      { label: 'Edit', icon: Edit, onClick: () => setIsEditing(true) },
      { separator: true },
      { label: deleteLoading ? 'Deleting...' : 'Delete', icon: Trash2, onClick: () => setShowDeleteConfirm(true), danger: true, disabled: deleteLoading },
    ] : []),
  ];

  const hasThread = sortedReplies.length > 0 || isReplying;

  return (
    <div className="bg-card border border-border/60 rounded-xl shadow-sm mx-3 my-2.5 overflow-hidden transition-shadow hover:shadow-md">
      {/* Header: avatar + author + time + context + actions */}
      <div className="flex items-start justify-between px-4 pt-3.5 pb-1 gap-2">
        <div className="flex items-start gap-2.5 min-w-0">
          <AuthorAvatar name={note.author_name} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-semibold text-foreground">{note.author_name || 'Unknown'}</span>
              {note.is_pinned && <Pin className="h-3 w-3 fill-amber-400 text-amber-500" />}
              {isLegacy && (
                <span className="bg-gray-100 text-gray-500 text-[9px] font-semibold px-1.5 py-0.5 rounded">Legacy</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground flex-wrap mt-0.5">
              <span>{note._created_date_relative || ''}</span>
              {showContext && note.context_label && (
                <>
                  <span className="text-border">·</span>
                  <ContextIcon className="h-3 w-3 shrink-0" />
                  {contextLink ? (
                    <Link to={contextLink} className="hover:underline hover:text-foreground truncate max-w-[160px]">
                      {note.context_label}
                    </Link>
                  ) : (
                    <span className="truncate max-w-[160px]">{note.context_label}</span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Pin + menu */}
        {!isLegacy && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={handleTogglePin}
              disabled={pinLoading}
              title={note.is_pinned ? 'Unpin' : 'Pin'}
              className={`p-1.5 rounded-md transition-colors ${
                note.is_pinned
                  ? 'text-amber-500 hover:bg-amber-50'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              } ${pinLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {pinLoading
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Pin className={`h-3.5 w-3.5 ${note.is_pinned ? 'fill-amber-400' : ''}`} />}
            </button>
            {menuActions.length > 0 && <ActionMenu actions={menuActions} />}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="px-4 pb-3 pt-1">
        {isEditing ? (
          <UnifiedNoteComposer
            agencyId={note.agency_id}
            projectId={note.project_id}
            agentId={note.agent_id}
            teamId={note.team_id}
            contextType={note.context_type}
            contextLabel={note.context_label}
            currentUser={currentUser}
            noteId={note.id}
            initialHtml={note.content_html || note.content}
            onSave={() => { setIsEditing(false); onRefresh?.(); }}
            onCancel={() => setIsEditing(false)}
          />
        ) : note.content_html ? (
          <div
            className="text-sm text-foreground/90 prose prose-sm max-w-none leading-relaxed"
            dangerouslySetInnerHTML={{ __html: sanitizeDisplay(note.content_html) }}
          />
        ) : (
          <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">{note.content}</p>
        )}

        {/* Attachments */}
        {note.attachments?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {note.attachments.map((a, i) => (
              <a
                key={i}
                href={a.file_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded border border-blue-100 hover:bg-blue-100 transition-colors"
              >
                {a.file_name}
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Footer: Add comment + thread toggle */}
      {!isEditing && !isLegacy && (
        <div className="px-4 pb-2.5 flex items-center gap-3 border-t border-border/30 pt-2">
          <button
            onClick={() => { setIsReplying(true); setRepliesExpanded(true); }}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {isReplying ? 'Commenting…' : 'Add comment'}
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
      )}

      {/* Thread section */}
      {hasThread && (
        <div className="bg-muted/20 border-t border-border/30 px-4 py-2">
          {repliesExpanded && sortedReplies.length > 0 && (
            <div className="divide-y divide-border/20">
              {sortedReplies.map(reply => <ReplyBubble key={reply.id} reply={reply} />)}
            </div>
          )}
          {isReplying && (
            <div className={sortedReplies.length > 0 && repliesExpanded ? 'pt-2 border-t border-border/20 mt-1' : ''}>
              <UnifiedNoteComposer
                agencyId={note.agency_id}
                projectId={note.project_id}
                agentId={note.agent_id}
                teamId={note.team_id}
                contextType={note.context_type}
                contextLabel={note.context_label}
                currentUser={currentUser}
                isReply
                parentNoteId={note.id}
                replyToAuthor={note.author_name}
                onSave={() => { setIsReplying(false); onRefresh?.(); }}
                onCancel={() => setIsReplying(false)}
              />
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete note?"
        description="This will permanently delete the note and cannot be undone."
        confirmText="Delete"
        onConfirm={() => { setShowDeleteConfirm(false); handleDelete(); }}
        onCancel={() => setShowDeleteConfirm(false)}
        danger
      />
    </div>
  );
}