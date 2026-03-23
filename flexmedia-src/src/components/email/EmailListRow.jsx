import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Paperclip, Lock, Users, Link2, Archive, Trash2, Copy, Eye, EyeOff } from "lucide-react";
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
import LabelBadge from "./LabelBadge";
import { FromHoverCard, AttachmentsHoverCard, ProjectHoverCard, VisibilityHoverCard } from "./EmailColumnHoverCard";
import { formatEmailDate } from "./emailDateUtils";
import { PRIORITY_LIST_STYLES, HOVER_CARD_DELAY_MS } from "./emailConstants";

// Distinct colors for multi-account indicator (left border + badge)
const ACCOUNT_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#22c55e', '#14b8a6'];

export default function EmailListRow({
  thread,
  columns,
  isSelected,
  onSelect,
  onOpen,
  labelData = [],
  emailAccounts = [],
  onLinkProject,
  onToggleVisibility,
  onContextMenu,
}) {
  const stripHtml = (html) => {
    if (!html) return '';
    let text = html
      // Remove entire <style>...</style> blocks (dotAll via [\s\S])
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      // Remove entire <script>...</script> blocks
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      // Remove HTML comments (including conditional IE comments)
      .replace(/<!--[\s\S]*?-->/g, '')
      // Remove <head>...</head> blocks (contains meta, title, style)
      .replace(/<head[\s\S]*?<\/head>/gi, '')
      // Remove all remaining HTML tags
      .replace(/<[^>]*>/g, ' ')
      // Decode common HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x[0-9a-fA-F]+;/g, ' ')
      .replace(/&#\d+;/g, ' ')
      // Remove CSS class/id selectors (.class-name, #id-name)
      .replace(/[.#][\w-]+(?:\s*[{,>+~])/g, ' ')
      .replace(/\.[\w-]{2,}/g, ' ')
      // Remove CSS property: value pairs (background-image: none, color: #fff, etc.)
      .replace(/[\w-]+\s*:\s*[^;]{1,80};/g, ' ')
      // Remove CSS values without semicolons (standalone property patterns)
      .replace(/\b(background|background-image|color|font|border|margin|padding|display|position|width|height|overflow|text-decoration|vertical-align|line-height|opacity|z-index|float|clear|visibility|content|cursor|outline|transform|transition|animation|box-shadow|text-align|white-space|word-break|max-width|min-width|min-height|max-height|flex|grid|align-items|justify-content)\s*:\s*[^.!?]{1,100}/gi, ' ')
      // Remove !important
      .replace(/!important/gi, '')
      // Remove CSS block remnants: braces, brackets
      .replace(/[{}\[\]]/g, ' ')
      // Remove CSS comment markers
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\*\//g, ' ')
      .replace(/\/\*/g, ' ')
      // Remove CSS media queries and @rules
      .replace(/@(media|import|charset|font-face|keyframes|supports|page)[^;{]*/gi, ' ')
      // Remove CSS units and values patterns (0px, 100%, #hex, rgb(), etc.)
      .replace(/\b\d+(px|em|rem|pt|%|vh|vw)\b/g, ' ')
      .replace(/#[0-9a-fA-F]{3,8}\b/g, ' ')
      .replace(/rgb\([^)]*\)/g, ' ')
      .replace(/rgba\([^)]*\)/g, ' ')
      .replace(/url\([^)]*\)/g, ' ')
      // Remove "none" as standalone word (CSS value remnant)
      .replace(/\bnone\b/g, ' ')
      // Fix mojibake: UTF-8 smart quotes/dashes decoded as Latin-1
      .replace(/\u00e2\u0080\u0099/g, "'")   // â€™ → '
      .replace(/\u00e2\u0080\u0098/g, "'")   // â€˜ → '
      .replace(/\u00e2\u0080\u009c/g, '"')   // â€œ → "
      .replace(/\u00e2\u0080\u009d/g, '"')   // â€ → "
      .replace(/\u00e2\u0080\u0093/g, '–')   // â€" → –
      .replace(/\u00e2\u0080\u0094/g, '—')   // â€" → —
      .replace(/\u00e2\u0080\u00a6/g, '...')  // â€¦ → ...
      .replace(/\u00c2\u00a0/g, ' ')          // Â  → space (non-breaking space)
      .replace(/â€™/g, "'")
      .replace(/â€˜/g, "'")
      .replace(/â€œ/g, '"')
      .replace(/â€\u009d/g, '"')
      .replace(/â€"/g, '–')
      .replace(/â€"/g, '—')
      .replace(/â€¦/g, '...')
      .replace(/Â©/g, '©')
      .replace(/Â /g, ' ')
      // Remove any remaining mojibake clusters
      .replace(/[\u00C0-\u00FF]{3,}/g, ' ')
      // Remove "Email Truncated" markers
      .replace(/Email\s*Truncat(ed|ion)[^.]*\.?/gi, ' ')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim();

    // If after all stripping the text is mostly garbage (very short or mostly non-alpha), return empty
    const alphaRatio = (text.match(/[a-zA-Z]/g) || []).length / (text.length || 1);
    if (text.length < 5 || alphaRatio < 0.4) return '';

    return text;
  };

  const priorityConfig = PRIORITY_LIST_STYLES;

  // Early guard: if thread has no messages, don't render
  if (!thread?.messages || thread.messages.length === 0) return null;
  
  const priority = thread.messages[0]?.priority;
  const priorityClass = priorityConfig[priority] || '';
  const isUnread = thread.unreadCount > 0;
  const labels = thread.messages[0]?.labels || [];
  const attachments = thread.messages[0]?.attachments || [];
  const displayDate = formatEmailDate(thread.lastMessage);

  // Collect all real attachments across ALL messages in the thread
  const allAttachments = thread.messages.flatMap(m => m.attachments || []);

  // Smart attachment filtering: exclude system junk but keep real files
  const isGarbage = (att) => {
    if (!att || !att.filename) return true;
    const name = (att.filename || '').toLowerCase();
    const size = att.size || 0;

    // Always keep files with attachment_id (Gmail reference — downloadable)
    // Size 0 is normal for Gmail attachments (size unknown until fetched)

    // Common junk: signature images, tracking pixels, smime
    if (name.match(/^(image|icon|logo|flag|pixel|spacer|blank)/i)) return true;
    if (name.includes('signature') || name.includes('smime')) return true;

    // Only filter by size if size is actually known (>0) and tiny
    if (size > 0 && size < 5120) {
      // Still keep PDFs, docs, spreadsheets, calendars regardless of size
      if (name.match(/\.(pdf|doc|docx|xls|xlsx|csv|ics|zip|rar)$/)) return false;
      return true;
    }

    // Tiny known-size images (tracking pixels etc)
    if (size > 0 && size < 50000 && name.match(/\.(gif|png|jpg|jpeg|webp)$/)) return true;

    return false;
  };

  const realAttachments = allAttachments.filter(att => !isGarbage(att));

  const totalRowWidth = columns.reduce((sum, c) => sum + (c.width ?? 0), 0);
  const isShared = thread.messages[0]?.visibility === 'shared';

  // Account indicator — only meaningful when multiple accounts exist (All Inboxes view)
  const accountId = thread.email_account_id;
  const accountIndex = emailAccounts.findIndex(a => a.id === accountId);
  const accountColor = emailAccounts.length > 1 && accountIndex >= 0 ? ACCOUNT_COLORS[accountIndex % ACCOUNT_COLORS.length] : null;
  const accountEmail = emailAccounts.length > 1 ? emailAccounts[accountIndex]?.email_address : null;
  // Short account label: first part before @ (e.g. "info" from "info@flexmedia.sydney")
  const accountShort = accountEmail ? accountEmail.split('@')[0] : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group relative flex items-center gap-0 border-b cursor-pointer select-none",
            "h-[56px] transition-all duration-150",
            "hover:bg-blue-50",
            isSelected && "bg-blue-100 shadow-sm",
            isUnread && !isSelected && "bg-blue-50 font-medium",
            !isUnread && !isSelected && priorityClass
          )}
          style={{
            minWidth: `${totalRowWidth}px`,
            borderLeftWidth: accountColor || isSelected || (isUnread && !isSelected) ? '3px' : undefined,
            borderLeftColor: isSelected ? '#2563eb' : (isUnread && !isSelected) ? '#3b82f6' : (accountColor || undefined),
          }}
          onClick={() => onOpen(thread)}
        >
      {/* Checkbox */}
      {columns.some(c => c.id === 'checkbox') && (() => {
        const col = columns.find(c => c.id === 'checkbox');
        const w = col?.width ?? 36;
        return (
          <div
            style={{ width: `${w}px`, minWidth: `${w}px` }}
            className="flex-shrink-0 flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => onSelect(thread.threadId)}
              className="h-3.5 w-3.5 cursor-pointer rounded border accent-blue-600"
              aria-label={`Select email: ${thread.subject || 'no subject'}`}
            />
          </div>
        );
      })()}

      {/* From */}
      {columns.some(c => c.id === 'from') && (() => {
        const col = columns.find(c => c.id === 'from');
        const w = col?.width ?? 140;
        return (
        <div style={{ width: `${w}px`, minWidth: `${w}px` }} className="flex-shrink-0 px-2 text-left overflow-hidden">
           <FromHoverCard email={thread.from_email} name={thread.from_name}>
             <div
               className={cn(
                 "truncate text-[14px] cursor-help leading-tight font-medium",
                 isUnread ? "font-bold text-foreground" : "text-foreground/75"
               )}
               title={thread.from_name ? `${thread.from_name} <${thread.from_email}>` : thread.from_email}
             >
               {thread.from_name || thread.from_email}
             </div>
           </FromHoverCard>
           {thread.agent_name && (
             <span
               className="inline-flex items-center gap-0.5 mt-0.5 text-[10px] font-medium text-violet-700 bg-violet-50 rounded px-1.5 py-0 leading-4 truncate max-w-full"
               title={thread.agency_name ? `${thread.agent_name} @ ${thread.agency_name}` : thread.agent_name}
             >
               {thread.agent_name}{thread.agency_name ? ` \u00b7 ${thread.agency_name}` : ''}
             </span>
           )}
           {/* Account indicator — shows which inbox this email belongs to (multi-account) */}
           {accountShort && !thread.agent_name && (
             <span
               className="inline-flex items-center mt-0.5 text-[9px] font-semibold rounded px-1.5 py-0 leading-4 truncate max-w-full opacity-60"
               style={{ color: accountColor, backgroundColor: accountColor ? `${accountColor}10` : undefined }}
               title={accountEmail}
             >
               {accountShort}
             </span>
           )}
        </div>
        );
      })()}

      {/* Subject + Labels + Preview */}
      {columns.some(c => c.id === 'subject') && (() => {
        const col = columns.find(c => c.id === 'subject');
        const w = col?.width ?? 400;
        const lastMsg = thread.messages[thread.messages.length - 1] || thread.messages[0];
        const bodyText = stripHtml(lastMsg.body);
        const preview = bodyText.substring(0, 200);
        const cleanSubject = thread.subject?.replace(/^(Re:|Fwd?:)\s*/gi, '').trim();
        return (
          <div
            style={{ width: `${w}px`, minWidth: `${w}px` }}
            className="flex-shrink-0 px-2 overflow-hidden flex flex-col justify-center gap-0.5"
          >
            {/* Top line: unread dot + thread count + project link + subject */}
            <div className="flex items-center gap-1.5 min-w-0">
              {/* Unread dot */}
              {isUnread && (
                <span className="flex-shrink-0 w-2 h-2 rounded-full bg-blue-600 shadow-sm animate-pulse" />
              )}
              {/* Thread count badge */}
              {thread.messages.length > 1 && (
                <span className="flex-shrink-0 text-[11px] font-bold text-slate-600 bg-slate-200 rounded-full px-2 leading-5">
                  {thread.messages.length}
                </span>
              )}
              {/* Project link icon */}
                {thread.project_id && (
                  <ProjectHoverCard projectTitle={thread.project_title} projectId={thread.project_id}>
                    <span className="flex-shrink-0 cursor-help p-1 rounded-lg bg-emerald-50/60 hover:bg-emerald-100/60 transition-colors">
                      <Link2 className="h-4 w-4 text-emerald-600" />
                    </span>
                  </ProjectHoverCard>
                )}
              {/* Subject text */}
              <span className={cn(
                  "truncate text-[14px] leading-snug cursor-default min-w-0 block font-medium",
                  isUnread ? "font-bold text-foreground" : "text-foreground/80"
                )}
                title={cleanSubject}
              >
                {cleanSubject || <em className="text-muted-foreground/40 not-italic">(no subject)</em>}
              </span>
            </div>

            {/* Bottom line: compact label chips + preview text */}
            <div className="flex items-center gap-1.5 min-w-0">
              {/* Compact label chips — tiny, inline, non-overflowing */}
              {labels.length > 0 && (
                <HoverCard openDelay={400}>
                  <HoverCardTrigger asChild>
                    <div className="flex items-center gap-1 flex-shrink-0 cursor-pointer">
                      {labels.slice(0, 3).map((label) => {
                        const color = labelData.find(l => l.name === label)?.color || '#6b7280';
                        return (
                          <span
                            key={label}
                            className="inline-block px-2 rounded-full text-[10px] font-bold text-white leading-5 whitespace-nowrap shadow-sm"
                            style={{ backgroundColor: color }}
                            title={label}
                          >
                            {label}
                          </span>
                        );
                      })}
                      {labels.length > 3 && (
                        <span className="text-[10px] text-muted-foreground/70 font-semibold">+{labels.length - 3}</span>
                      )}
                    </div>
                  </HoverCardTrigger>
                  <HoverCardContent side="top" align="start" className="w-56 p-3">
                    <p className="text-[11px] font-bold text-muted-foreground mb-2 uppercase tracking-wide">Labels</p>
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
              {/* Preview snippet */}
              {preview && (
                <span className="text-[12px] text-muted-foreground/60 truncate min-w-0">
                  {preview}
                </span>
              )}
            </div>
          </div>
        );
      })()}

      {/* Attachments */}
      {columns.some(c => c.id === 'attachments') && (() => {
        const col = columns.find(c => c.id === 'attachments');
        const w = col?.width ?? 28;
        return (
          <div style={{ width: `${w}px`, minWidth: `${w}px` }} className="flex-shrink-0 flex items-center justify-center">
            {realAttachments.length > 0 && (
              <AttachmentsHoverCard attachments={realAttachments}>
                <button
                  className="p-2 rounded-lg hover:bg-slate-100 transition-colors"
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`${realAttachments.length} attachment${realAttachments.length !== 1 ? 's' : ''}`}
                        title={`${realAttachments.length} attachment${realAttachments.length !== 1 ? 's' : ''}`}
                >
                  <Paperclip className="h-3.5 w-3.5 text-blue-500" />
                </button>
              </AttachmentsHoverCard>
            )}
          </div>
        );
      })()}

      {/* Visibility — clickable toggle */}
      {columns.some(c => c.id === 'visibility') && (() => {
        const col = columns.find(c => c.id === 'visibility');
        const w = col?.width ?? 32;
        return (
          <div style={{ width: `${w}px`, minWidth: `${w}px` }} className="flex-shrink-0 flex items-center justify-center">
            <TooltipProvider delayDuration={400}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    "w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-150 active:scale-95",
                    isShared
                      ? "text-blue-600 hover:bg-blue-100/60 bg-blue-50/30"
                      : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-slate-100/40"
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleVisibility?.(thread, isShared ? 'private' : 'shared');
                  }}
                  aria-label={isShared ? "Make private" : "Share with team"}
                  title={isShared ? "Shared with team" : "Private to you"}
                >
                  {isShared
                    ? <Users className="h-4 w-4" />
                    : <Lock className="h-4 w-4" />
                  }
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs max-w-[200px]">
                {isShared
                  ? "🌐 Shared — visible in linked projects"
                  : "🔒 Private — only you can see"}
              </TooltipContent>
            </Tooltip>
            </TooltipProvider>
          </div>
        );
      })()}



      {/* Thread/unread indicators moved into subject column — this space intentionally empty */}

      {/* Date */}
      {columns.some(c => c.id === 'date') && (() => {
        const col = columns.find(c => c.id === 'date');
        const w = col?.width ?? 76;
        return (
          <div style={{ width: `${w}px`, minWidth: `${w}px` }} className="flex-shrink-0 px-2 flex items-center justify-end">
            <TooltipProvider delayDuration={600}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={cn(
                    "text-[12px] whitespace-nowrap tabular-nums cursor-default font-medium",
                    isUnread ? "font-bold text-foreground" : "text-muted-foreground/70"
                  )}>
                    {displayDate}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left" className="text-xs">
                  {thread.lastMessage ? new Date(thread.lastMessage).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown date'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        );
      })()}

      {/* Actions column — wired to onLinkProject */}
      {columns.some(c => c.id === 'actions') && (() => {
        const col = columns.find(c => c.id === 'actions');
        const w = col?.width ?? 210;
        return (
          <div
            style={{ width: `${w}px`, minWidth: `${w}px` }}
            className="flex-shrink-0 px-2 flex items-center justify-between gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Project name or link button */}
            <div className="flex-1 min-w-0 overflow-hidden flex items-center">
              {thread.project_id ? (
                <button
                  onClick={() => onLinkProject?.(thread)}
                  className="flex items-center gap-1.5 min-w-0 group/proj hover:bg-muted/50 rounded px-1.5 py-0.5 -mx-1.5 transition-colors"
                  title={`Linked: ${thread.project_title} (click to change)`}
                >
                  <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  <span className="text-[12px] font-medium text-foreground/75 truncate group-hover/proj:text-foreground">
                    {thread.project_title}
                  </span>
                </button>
              ) : (
                <button
                  onClick={() => onLinkProject?.(thread)}
                  className="text-[11px] text-muted-foreground/40 hover:text-muted-foreground flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Link to project"
                >
                  <Link2 className="h-3 w-3" />
                  Link
                </button>
              )}
            </div>
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
          onClick={(e) => { e.stopPropagation(); onToggleVisibility?.(thread, isShared ? 'private' : 'shared'); }}
        >
          {isShared
            ? <EyeOff className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
            : <Eye className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
          }
          {isShared ? "Make private" : "Share with team"}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={(e) => { e.stopPropagation(); onLinkProject?.(thread); }}
        >
          <Link2 className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
          {thread.project_id ? `Change project` : "Link to project"}
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
          onClick={(e) => { e.stopPropagation(); onContextMenu?.(thread, 'archive'); }}
          className="text-muted-foreground"
        >
          <Archive className="h-3.5 w-3.5 mr-2" />
          Archive
        </ContextMenuItem>
        <ContextMenuItem
          onClick={(e) => { e.stopPropagation(); onContextMenu?.(thread, 'delete'); }}
          className="text-red-600 focus:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5 mr-2" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}