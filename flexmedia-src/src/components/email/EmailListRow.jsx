import React, { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  Paperclip,
  Lock,
  Users,
  Link2,
  Archive,
  Trash2,
  Copy,
  Eye,
  EyeOff,
  DollarSign,
  ChevronDown,
} from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import LabelBadge from "./LabelBadge";
import {
  FromHoverCard,
  AttachmentsHoverCard,
  ProjectHoverCard,
} from "./EmailColumnHoverCard";
import { formatInboxTime } from "./emailDateUtils";
import { PRIORITY_LIST_STYLES } from "./emailConstants";

// Distinct colors for the multi-account left-edge stripe
const ACCOUNT_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#22c55e', '#14b8a6'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Deterministic tailwind color class for an actor's avatar. Pipedrive uses a
// small palette; here we bias David -> sky, Joseph -> amber, Flex/team -> slate.
const AVATAR_PALETTE = [
  'bg-sky-600 text-white',
  'bg-amber-500 text-white',
  'bg-slate-800 text-white',
  'bg-emerald-600 text-white',
  'bg-violet-600 text-white',
  'bg-rose-600 text-white',
  'bg-indigo-600 text-white',
  'bg-teal-600 text-white',
];

function getActorColor(name = '') {
  const n = (name || '').toLowerCase();
  if (n.startsWith('david')) return 'bg-sky-600 text-white';
  if (n.startsWith('joseph') || n.startsWith('joe')) return 'bg-amber-500 text-white';
  if (n.startsWith('flex')) return 'bg-slate-900 text-white';
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function getInitial(name = '') {
  const trimmed = (name || '').trim();
  if (!trimmed) return '?';
  // If email, take first alpha char; else first letter of first word
  const first = trimmed.replace(/[^A-Za-z]/g, '').charAt(0);
  return (first || trimmed.charAt(0)).toUpperCase();
}

// Cheap HTML -> text for previews. Kept lightweight (not the aggressive stripper
// used for full-body extraction) since we only render ~120 chars here.
function quickPreview(html, snippet) {
  if (snippet && snippet.trim()) return snippet.trim();
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isGarbageAttachment(att) {
  if (!att || !att.filename) return true;
  const name = (att.filename || '').toLowerCase();
  const size = att.size || 0;
  if (name.match(/^(image|icon|logo|flag|pixel|spacer|blank)/i)) return true;
  if (name.includes('signature') || name.includes('smime')) return true;
  if (size > 0 && size < 5120) {
    if (name.match(/\.(pdf|doc|docx|xls|xlsx|csv|ics|zip|rar)$/)) return false;
    return true;
  }
  if (size > 0 && size < 50000 && name.match(/\.(gif|png|jpg|jpeg|webp)$/)) return true;
  return false;
}

// Extract a short suburb/street label from a project title. The stored title
// is typically "5A Josephine Cres, Moorebank" — we keep the full string but
// the pill will CSS-truncate, so callers can just pass it through.
function shortProjectLabel(title) {
  if (!title) return '';
  return title;
}

// Compact label for the connected-inbox indicator shown in "All Inboxes" view.
// We prefer the email's local-part (before @) since names like "joseph", "janet",
// "david", "info", "dom" are what the user recognises at a glance. Truncate
// anything long so it stays on a single line in the dense 52px row.
function getAccountLabel(account) {
  if (!account) return '';
  const email = account.email_address || '';
  const local = email.split('@')[0] || account.display_name || '';
  if (!local) return '';
  return local.length > 10 ? local.slice(0, 9) + '…' : local;
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

const EmailListRow = React.memo(function EmailListRow({
  thread,
  columns,
  isSelected,
  onSelect,
  onOpen,
  labelData = [],
  emailAccounts = [],
  showAccount = false,
  onLinkProject,
  onToggleVisibility,
  onContextMenu,
}) {
  if (!thread?.messages || thread.messages.length === 0) return null;

  const priority = thread.messages[0]?.priority;
  const priorityClass = PRIORITY_LIST_STYLES[priority] || '';
  const isUnread = thread.unreadCount > 0;
  const labels = thread.messages[0]?.labels || [];
  const displayDate = formatInboxTime(thread.lastMessage);

  // Attachments: search all messages, then drop signature/tracking junk
  const realAttachments = useMemo(() => {
    const all = thread.messages.flatMap(m => m.attachments || []);
    return all.filter(a => !isGarbageAttachment(a));
  }, [thread.messages]);

  const totalRowWidth = columns.reduce((sum, c) => sum + (c.width ?? 0), 0);
  const isShared = thread.messages[0]?.visibility === 'shared';

  // Account stripe (only when multiple accounts in view)
  const accountId = thread.email_account_id;
  const accountIndex = emailAccounts.findIndex(a => a.id === accountId);
  const accountColor = emailAccounts.length > 1 && accountIndex >= 0
    ? ACCOUNT_COLORS[accountIndex % ACCOUNT_COLORS.length]
    : null;
  const account = accountIndex >= 0 ? emailAccounts[accountIndex] : null;
  const accountEmail = emailAccounts.length > 1 ? account?.email_address : null;

  // Inline account indicator — shown only in the aggregated "All Inboxes" view.
  // Uses the account's stripe color so stripe + suffix read as one visual cue.
  const accountLabel = showAccount ? getAccountLabel(account) : '';
  const accountLabelColor = accountColor || '#6b7280'; // slate-500 fallback

  // Last message drives preview + actor avatar
  const lastMsg = thread.messages[thread.messages.length - 1] || thread.messages[0];
  const preview = quickPreview(lastMsg.body, lastMsg.snippet).slice(0, 180);
  const cleanSubject = (thread.subject || '').replace(/^(Re:|Fwd?:)\s*/gi, '').trim();
  const senderLabel = thread.from_name || thread.from_email || 'Unknown';

  // Actor = whoever sent the latest message; use first initial of display name
  const actorName = lastMsg.from_name || lastMsg.from || senderLabel;
  const actorInitial = getInitial(actorName);
  const actorColorCls = getActorColor(actorName);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group relative flex items-center gap-0 border-b border-border/60 cursor-pointer select-none",
            "h-[52px] transition-[background-color,box-shadow] duration-150",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
            isSelected
              ? "bg-blue-50 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.2)] hover:bg-blue-100/80"
              : "hover:bg-muted/40",
            !isSelected && priorityClass
          )}
          style={{
            minWidth: `${totalRowWidth}px`,
            borderLeftWidth: accountColor ? '3px' : undefined,
            borderLeftColor: accountColor || undefined,
          }}
          role="row"
          tabIndex={0}
          aria-selected={isSelected}
          aria-label={`${isUnread ? 'Unread: ' : ''}${senderLabel} — ${cleanSubject || 'No subject'}`}
          onClick={() => onOpen(thread)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpen(thread);
            }
          }}
        >
          {/* ---- Checkbox + unread dot rail -------------------------------- */}
          {columns.some(c => c.id === 'checkbox') && (() => {
            const col = columns.find(c => c.id === 'checkbox');
            const w = col?.width ?? 32;
            return (
              <div
                style={{ width: `${w}px`, minWidth: `${w}px` }}
                className="flex-shrink-0 flex items-center justify-center relative"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Unread dot overlaps slightly left of the checkbox */}
                {isUnread && (
                  <span
                    className="absolute left-1 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-blue-600"
                    aria-label="unread"
                  />
                )}
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onSelect(thread.threadId)}
                  className="h-3.5 w-3.5 cursor-pointer rounded border accent-blue-600"
                  aria-label={`Select email: ${cleanSubject || 'no subject'}`}
                />
              </div>
            );
          })()}

          {/* ---- Sender (bold when unread) + thread count pill ------------ */}
          {columns.some(c => c.id === 'from') && (() => {
            const col = columns.find(c => c.id === 'from');
            const w = col?.width ?? 200;
            return (
              <div
                style={{ width: `${w}px`, minWidth: `${w}px` }}
                className="flex-shrink-0 px-3 flex items-center gap-1.5 overflow-hidden"
              >
                <FromHoverCard email={thread.from_email} name={thread.from_name}>
                  <span
                    className={cn(
                      "truncate text-[13px] leading-tight cursor-help",
                      isUnread
                        ? "font-semibold text-foreground"
                        : "font-normal text-foreground/70"
                    )}
                    title={thread.from_name
                      ? `${thread.from_name} <${thread.from_email}>`
                      : thread.from_email}
                  >
                    {senderLabel}
                  </span>
                </FromHoverCard>
                {thread.messages.length > 1 && (
                  <span
                    className={cn(
                      "flex-shrink-0 text-[11px] rounded-full px-1.5 leading-[18px] min-w-[20px] text-center tabular-nums font-medium",
                      isUnread
                        ? "bg-blue-100 text-blue-700 ring-1 ring-blue-200/70"
                        : "bg-muted/70 text-muted-foreground"
                    )}
                    title={`${thread.messages.length} messages`}
                  >
                    {thread.messages.length}
                  </span>
                )}
                {accountLabel && (
                  <span
                    className="flex-shrink-0 text-[10px] leading-tight whitespace-nowrap opacity-80 group-hover:opacity-100 transition-opacity"
                    style={{ color: accountLabelColor }}
                    title={account?.email_address || accountLabel}
                  >
                    <span className="text-muted-foreground/50">·&nbsp;</span>
                    {accountLabel}
                  </span>
                )}
              </div>
            );
          })()}

          {/* ---- Labels + Subject + Preview (flex) ------------------------ */}
          {columns.some(c => c.id === 'subject') && (() => {
            const col = columns.find(c => c.id === 'subject');
            const w = col?.width ?? 500;
            return (
              <div
                style={{ width: `${w}px`, minWidth: `${w}px` }}
                className="flex-shrink-0 pr-3 overflow-hidden min-w-0"
              >
                <div className="flex items-center gap-1.5 min-w-0 w-full">
                  {/* Inline label pills — tight uppercase Pipedrive style */}
                  {labels.length > 0 && (
                    <HoverCard openDelay={400}>
                      <HoverCardTrigger asChild>
                        <div className="flex items-center gap-1 flex-shrink-0 cursor-pointer">
                          {labels.slice(0, 3).map((label) => {
                            const color = labelData.find(l => l.name === label)?.color || '#6b7280';
                            return (
                              <span
                                key={label}
                                className="inline-block px-1.5 py-0.5 rounded-sm text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap max-w-[140px] truncate"
                                style={{
                                  backgroundColor: `${color}1a`, // 10% tint
                                  color,
                                }}
                                title={label}
                              >
                                {label}
                              </span>
                            );
                          })}
                          {labels.length > 3 && (
                            <span className="text-[10px] text-muted-foreground/70 font-semibold flex-shrink-0">
                              +{labels.length - 3}
                            </span>
                          )}
                        </div>
                      </HoverCardTrigger>
                      <HoverCardContent side="top" align="start" className="w-56 p-3">
                        <p className="text-[11px] font-bold text-muted-foreground mb-2 uppercase tracking-wide">
                          Labels
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {labels.map((label) => (
                            <LabelBadge
                              key={label}
                              label={label}
                              color={labelData.find(l => l.name === label)?.color || '#6b7280'}
                            />
                          ))}
                        </div>
                      </HoverCardContent>
                    </HoverCard>
                  )}

                  {/* Subject + preview on one line, preview muted and truncated */}
                  <span
                    className={cn(
                      "truncate text-[13px] leading-tight min-w-0 block",
                      isUnread ? "font-semibold text-foreground" : "font-normal text-foreground/80"
                    )}
                    title={cleanSubject}
                  >
                    {cleanSubject || (
                      <em className="text-muted-foreground/40 not-italic">(no subject)</em>
                    )}
                    {preview && (
                      <span className="text-muted-foreground/60 font-normal ml-1.5">
                        &mdash; {preview}
                      </span>
                    )}
                  </span>

                  {/* Hover-only "Link item" quick action */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onLinkProject?.(thread);
                    }}
                    className="ml-auto flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-background"
                    title="Link item to project"
                  >
                    <Link2 className="h-3 w-3" />
                    Link item
                  </button>
                </div>
              </div>
            );
          })()}

          {/* ---- Project pill (outlined, $ icon) -------------------------- */}
          {columns.some(c => c.id === 'actions') && (() => {
            const col = columns.find(c => c.id === 'actions');
            const w = col?.width ?? 180;
            return (
              <div
                style={{ width: `${w}px`, minWidth: `${w}px` }}
                className="flex-shrink-0 px-2 flex items-center justify-start"
                onClick={(e) => e.stopPropagation()}
              >
                {thread.project_id ? (
                  <ProjectHoverCard projectTitle={thread.project_title} projectId={thread.project_id}>
                    <button
                      onClick={() => onLinkProject?.(thread)}
                      className="group/proj inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-300 transition-colors"
                      title={`Linked: ${thread.project_title} (click to change)`}
                    >
                      <DollarSign className="h-3 w-3 flex-shrink-0" />
                      <span className="text-[11px] font-medium truncate">
                        {shortProjectLabel(thread.project_title)}
                      </span>
                    </button>
                  </ProjectHoverCard>
                ) : (
                  <button
                    onClick={() => onLinkProject?.(thread)}
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/40 hover:text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity px-2 py-0.5 rounded-full border border-dashed border-muted-foreground/30"
                    title="Link to project"
                  >
                    <DollarSign className="h-3 w-3" />
                    Link
                  </button>
                )}
              </div>
            );
          })()}

          {/* ---- Visibility / lock dropdown ------------------------------- */}
          {columns.some(c => c.id === 'visibility') && (() => {
            const col = columns.find(c => c.id === 'visibility');
            const w = col?.width ?? 36;
            return (
              <div
                style={{ width: `${w}px`, minWidth: `${w}px` }}
                className="flex-shrink-0 flex items-center justify-center"
                onClick={(e) => e.stopPropagation()}
              >
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className={cn(
                        "inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 transition-colors",
                        isShared
                          ? "text-blue-600 hover:bg-blue-100/70"
                          : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/60"
                      )}
                      title={isShared ? "Shared with team" : "Private to you"}
                      aria-label={isShared ? "Visibility: shared" : "Visibility: private"}
                    >
                      {isShared ? <Users className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                      <ChevronDown className="h-3 w-3 opacity-60" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleVisibility?.(thread, 'shared');
                      }}
                    >
                      <Users className="h-3.5 w-3.5 mr-2 text-blue-600" />
                      Share with team
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleVisibility?.(thread, 'private');
                      }}
                    >
                      <Lock className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                      Mark as confidential
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        onLinkProject?.(thread);
                      }}
                    >
                      <Link2 className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                      Link item
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })()}

          {/* ---- Attachment paperclip ------------------------------------- */}
          {columns.some(c => c.id === 'attachments') && (() => {
            const col = columns.find(c => c.id === 'attachments');
            const w = col?.width ?? 28;
            return (
              <div
                style={{ width: `${w}px`, minWidth: `${w}px` }}
                className="flex-shrink-0 flex items-center justify-center"
              >
                {realAttachments.length > 0 && (
                  <AttachmentsHoverCard attachments={realAttachments}>
                    <button
                      className="relative w-7 h-7 rounded-md flex items-center justify-center hover:bg-muted/70 transition-colors"
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`${realAttachments.length} attachment${realAttachments.length !== 1 ? 's' : ''}`}
                      title={`${realAttachments.length} attachment${realAttachments.length !== 1 ? 's' : ''}`}
                    >
                      <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                      {realAttachments.length > 1 && (
                        <span className="absolute -top-0.5 -right-0.5 min-w-[13px] h-[13px] rounded-full bg-slate-500 text-white text-[9px] font-bold flex items-center justify-center leading-none px-0.5">
                          {realAttachments.length}
                        </span>
                      )}
                    </button>
                  </AttachmentsHoverCard>
                )}
              </div>
            );
          })()}

          {/* ---- Actor avatar --------------------------------------------- */}
          {columns.some(c => c.id === 'avatar') && (() => {
            const col = columns.find(c => c.id === 'avatar');
            const w = col?.width ?? 36;
            return (
              <div
                style={{ width: `${w}px`, minWidth: `${w}px` }}
                className="flex-shrink-0 flex items-center justify-center"
              >
                <TooltipProvider delayDuration={400}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className={cn(
                          "w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold",
                          actorColorCls
                        )}
                        aria-label={`Last actor: ${actorName}`}
                      >
                        {actorInitial}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-xs">
                      {actorName}
                      {accountEmail && (
                        <span className="block text-muted-foreground/70 text-[10px] mt-0.5">
                          via {accountEmail}
                        </span>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            );
          })()}

          {/* ---- Timestamp (right) ---------------------------------------- */}
          {columns.some(c => c.id === 'date') && (() => {
            const col = columns.find(c => c.id === 'date');
            const w = col?.width ?? 72;
            return (
              <div
                style={{ width: `${w}px`, minWidth: `${w}px` }}
                className="flex-shrink-0 px-2 flex items-center justify-end"
              >
                <TooltipProvider delayDuration={600}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          "text-[11px] tabular-nums whitespace-nowrap cursor-default",
                          isUnread
                            ? "font-semibold text-foreground"
                            : "font-normal text-muted-foreground/70"
                        )}
                      >
                        {displayDate}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-xs">
                      {thread.lastMessage
                        ? new Date(thread.lastMessage).toLocaleString('en-AU', {
                            timeZone: 'Australia/Sydney',
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : 'Unknown date'}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            );
          })()}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={() => onOpen(thread)}>
          <Eye className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
          Open thread
        </ContextMenuItem>
        <ContextMenuItem
          onClick={(e) => {
            e.stopPropagation();
            onToggleVisibility?.(thread, isShared ? 'private' : 'shared');
          }}
        >
          {isShared
            ? <EyeOff className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
            : <Eye className="h-3.5 w-3.5 mr-2 text-muted-foreground" />}
          {isShared ? "Make private" : "Share with team"}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={(e) => {
            e.stopPropagation();
            onLinkProject?.(thread);
          }}
        >
          <Link2 className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
          {thread.project_id ? "Change project" : "Link to project"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(thread.from_email || '');
          }}
        >
          <Copy className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
          Copy sender email
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={(e) => {
            e.stopPropagation();
            onContextMenu?.(thread, 'archive');
          }}
          className="text-muted-foreground"
        >
          <Archive className="h-3.5 w-3.5 mr-2" />
          Archive
        </ContextMenuItem>
        <ContextMenuItem
          onClick={(e) => {
            e.stopPropagation();
            onContextMenu?.(thread, 'delete');
          }}
          className="text-red-600 focus:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5 mr-2" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

export default EmailListRow;
