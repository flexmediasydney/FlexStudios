import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Paperclip, Lock, Users, Star, Link2, Archive, Trash2, Copy, Eye, EyeOff } from "lucide-react";
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
import { FromHoverCard, SubjectHoverCard, AttachmentsHoverCard, ProjectHoverCard, VisibilityHoverCard } from "./EmailColumnHoverCard";
import { formatEmailDate } from "./emailDateUtils";
import { PRIORITY_LIST_STYLES, HOVER_CARD_DELAY_MS } from "./emailConstants";

export default function EmailListRow({ 
  thread, 
  columns, 
  isSelected, 
  onSelect, 
  onOpen,
  labelData = [],
  onLinkProject,
  onToggleVisibility,
  onToggleStar,
  onContextMenu,
}) {
  const stripHtml = (html) => {
    if (!html) return '';
    return html
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  };

  const priorityConfig = PRIORITY_LIST_STYLES;

  if (!thread?.messages || thread.messages.length === 0) return null;
  
  const priority = thread.messages[0]?.priority;
  const priorityClass = priorityConfig[priority] || '';
  const isUnread = thread.unreadCount > 0;
  const isStarred = thread.is_starred;
  const labels = thread.messages[0]?.labels || [];
  const attachments = thread.messages[0]?.attachments || [];
  const displayDate = formatEmailDate(thread.lastMessage);

  const isGarbage = (att) => {
    if (!att) return true;
    const size = att.size || 0;
    const name = (att.filename || '').toLowerCase();
    if (size < 5120) return true;
    if (name.match(/\.(gif|png|jpg|jpeg|webp)$/) && size < 50000) return true;
    if (name.match(/^(image|icon|logo|flag|pixel|spacer|blank)/i)) return true;
    if (name.includes('signature') || name.includes('smime')) return true;
    return false;
  };
  
  const realAttachments = attachments.filter(att => !isGarbage(att));

  const totalRowWidth = columns.reduce((sum, c) => sum + (c.width ?? 0), 0);
  const isShared = thread.messages[0]?.visibility === 'shared';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group relative flex items-center gap-0 border-b cursor-pointer select-none",
            "h-14 transition-all duration-150 ease-out",
            "hover:bg-blue-50/80 active:bg-blue-100/40",
            isSelected && "bg-blue-50 border-l-4 border-l-blue-600 shadow-sm",
            isUnread && !isSelected && "bg-white border-l-4 border-l-blue-500",
            !isUnread && !isSelected && priorityClass,
            "focus-within:ring-2 focus-within:ring-offset-0 focus-within:ring-blue-500"
          )}
          style={{ minWidth: `${totalRowWidth}px` }}
          onClick={() => onOpen(thread)}
          onKeyDown={(e) => e.key === 'Enter' && onOpen(thread)}
          tabIndex={0}
          role="button"
          aria-selected={isSelected}
          aria-label={`Email from ${thread.from_name || thread.from_email}: ${thread.subject || '(no subject)'}`}
        >
          {/* Checkbox */}
          {columns.some(c => c.id === 'checkbox') && (() => {
            const col = columns.find(c => c.id === 'checkbox');
            const w = col?.width ?? 44;
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
                  className="h-4 w-4 cursor-pointer rounded border-2 accent-blue-600 transition-all"
                  aria-label={`Select email: ${thread.subject || 'no subject'}`}
                />
              </div>
            );
          })()}

          {/* Star */}
          {columns.some(c => c.id === 'star') && (
            <TooltipProvider delayDuration={400}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className={cn(
                      "flex-shrink-0 w-10 h-10 flex items-center justify-center transition-all duration-150 rounded",
                      "hover:bg-amber-100/60 active:scale-95",
                      isStarred
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-60 hover:!opacity-100 focus:opacity-100"
                    )}
                    onClick={(e) => { e.stopPropagation(); onToggleStar?.(thread); }}
                    aria-label={isStarred ? "Remove star" : "Star this email"}
                    tabIndex={-1}
                  >
                    <Star className={cn(
                      "h-4.5 w-4.5 transition-all",
                      isStarred ? "fill-amber-400 text-amber-500 drop-shadow-sm" : "text-amber-300/40"
                    )} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs font-medium">
                  {isStarred ? "Remove star" : "Star"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* From */}
          {columns.some(c => c.id === 'from') && (() => {
            const col = columns.find(c => c.id === 'from');
            const w = col?.width ?? 160;
            return (
              <div style={{ width: `${w}px`, minWidth: `${w}px` }} className="flex-shrink-0 px-3 text-left overflow-hidden">
                <FromHoverCard email={thread.from_email} name={thread.from_name}>
                  <div 
                    className={cn(
                      "truncate text-sm cursor-help leading-tight",
                      isUnread ? "font-bold text-foreground" : "font-medium text-foreground/70"
                    )}
                    title={thread.from_name ? `${thread.from_name} <${thread.from_email}>` : thread.from_email}
                  >
                    {thread.from_name || thread.from_email}
                  </div>
                </FromHoverCard>
              </div>
            );
          })()}

          {/* Subject + Preview */}
          {columns.some(c => c.id === 'subject') && (() => {
            const col = columns.find(c => c.id === 'subject');
            const w = col?.width ?? 420;
            const preview = stripHtml(thread.messages[0].body).substring(0, 140);
            const cleanSubject = thread.subject?.replace(/^(Re:|Fwd?:)\s*/gi, '').trim();
            return (
              <div
                style={{ width: `${w}px`, minWidth: `${w}px` }}
                className="flex-shrink-0 px-3 overflow-hidden flex flex-col justify-center gap-1"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isUnread && (
                    <span className="flex-shrink-0 w-2.5 h-2.5 rounded-full bg-blue-600 shadow-sm" />
                  )}
                  {thread.messages.length > 1 && (
                    <span className="flex-shrink-0 text-xs font-bold text-white bg-slate-500 rounded px-1.5 leading-5">
                      {thread.messages.length}
                    </span>
                  )}
                  {thread.project_id && (
                    <ProjectHoverCard projectTitle={thread.project_title} projectId={thread.project_id}>
                      <span className="flex-shrink-0 cursor-help">
                        <Link2 className="h-4 w-4 text-emerald-600" />
                      </span>
                    </ProjectHoverCard>
                  )}
                  <SubjectHoverCard subject={cleanSubject} preview={preview} labels={labels}>
                    <span className={cn(
                      "truncate text-sm leading-tight cursor-default min-w-0 block",
                      isUnread ? "font-bold text-foreground" : "font-medium text-foreground/75"
                    )}>
                      {cleanSubject || <em className="text-muted-foreground/50 not-italic">(no subject)</em>}
                    </span>
                  </SubjectHoverCard>
                </div>

                <div className="flex items-center gap-2 min-w-0">
                  {labels.length > 0 && (
                    <HoverCard openDelay={HOVER_CARD_DELAY_MS}>
                      <HoverCardTrigger asChild>
                        <div className="flex items-center gap-1 flex-shrink-0 cursor-pointer">
                          {labels.slice(0, 2).map((label) => {
                            const color = labelData.find(l => l.name === label)?.color || '#6b7280';
                            return (
                              <span
                                key={label}
                                className="inline-block px-2 rounded text-xs font-bold text-white leading-5 whitespace-nowrap"
                                style={{ backgroundColor: color }}
                              >
                                {label}
                              </span>
                            );
                          })}
                          {labels.length > 2 && (
                            <span className="text-xs text-muted-foreground font-bold">+{labels.length - 2}</span>
                          )}
                        </div>
                      </HoverCardTrigger>
                      <HoverCardContent side="top" align="start" className="w-56 p-3">
                        <p className="text-xs font-bold text-muted-foreground mb-2 uppercase tracking-wider">All Labels</p>
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
                  <span className="text-xs text-muted-foreground/60 truncate min-w-0">
                    {preview}
                  </span>
                </div>
              </div>
            );
          })()}

          {/* Attachments */}
          {columns.some(c => c.id === 'attachments') && (() => {
            const col = columns.find(c => c.id === 'attachments');
            const w = col?.width ?? 40;
            return (
              <div style={{ width: `${w}px`, minWidth: `${w}px` }} className="flex-shrink-0 flex items-center justify-center">
                {realAttachments.length > 0 && (
                  <AttachmentsHoverCard attachments={realAttachments}>
                    <button
                      className="p-2 rounded hover:bg-blue-100/60 transition-all active:scale-95"
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`${realAttachments.length} attachment${realAttachments.length !== 1 ? 's' : ''}`}
                      tabIndex={-1}
                    >
                      <Paperclip className="h-4 w-4 text-blue-600" />
                    </button>
                  </AttachmentsHoverCard>
                )}
              </div>
            );
          })()}

          {/* Visibility */}
          {columns.some(c => c.id === 'visibility') && (() => {
            const isShared = thread.messages[0]?.visibility === 'shared';
            return (
              <div className="flex-shrink-0 w-10 flex items-center justify-center">
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className={cn(
                          "p-2 rounded transition-all duration-150 active:scale-95",
                          isShared
                            ? "text-blue-600 hover:bg-blue-100/60"
                            : "text-muted-foreground/40 hover:text-muted-foreground/70 hover:bg-muted/60"
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleVisibility?.(thread, isShared ? 'private' : 'shared');
                        }}
                        aria-label={isShared ? "Make private" : "Share with team"}
                        tabIndex={-1}
                      >
                        {isShared
                          ? <Users className="h-4 w-4" />
                          : <Lock className="h-4 w-4" />
                        }
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-xs font-medium max-w-xs">
                      {isShared
                        ? "Shared with team — click to make private"
                        : "Private — click to share with team"}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            );
          })()}

          {/* Date */}
          {columns.some(c => c.id === 'date') && (() => {
            const col = columns.find(c => c.id === 'date');
            const w = col?.width ?? 90;
            return (
              <div style={{ width: `${w}px`, minWidth: `${w}px` }} className="flex-shrink-0 px-3 flex items-center justify-end">
                <TooltipProvider delayDuration={600}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className={cn(
                        "text-sm whitespace-nowrap tabular-nums cursor-default",
                        isUnread ? "font-bold text-foreground" : "text-muted-foreground/70"
                      )}>
                        {displayDate}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-xs font-medium">
                      {thread.lastMessage ? new Date(thread.lastMessage).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown'}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            );
          })()}

          {/* Actions */}
          {columns.some(c => c.id === 'actions') && (() => {
            const col = columns.find(c => c.id === 'actions');
            const w = col?.width ?? 240;
            return (
              <div
                style={{ width: `${w}px`, minWidth: `${w}px` }}
                className="flex-shrink-0 px-3 flex items-center justify-between gap-2"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex-1 min-w-0 overflow-hidden">
                  {thread.project_id ? (
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="flex-shrink-0 w-2 h-2 rounded-full bg-emerald-500" />
                      <span className="text-xs font-semibold text-foreground/80 truncate" title={thread.project_title}>
                        {thread.project_title}
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground/50 flex items-center gap-1">
                      <Link2 className="h-3 w-3" />
                      Unlinked
                    </span>
                  )}
                </div>

                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onLinkProject?.(thread)}
                        className={cn(
                          "flex-shrink-0 h-8 px-3 rounded-full text-xs font-bold",
                          "transition-all duration-150 flex items-center gap-1 active:scale-95",
                          thread.project_id
                            ? "bg-emerald-100 hover:bg-emerald-150 text-emerald-700 border border-emerald-300"
                            : "bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg"
                        )}
                        aria-label={thread.project_id ? "Change linked project" : "Link to project"}
                        tabIndex={-1}
                      >
                        <Link2 className="h-3.5 w-3.5" />
                        {thread.project_id ? "Change" : "Link"}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-xs font-medium">
                      {thread.project_id ? `Change project (current: ${thread.project_title})` : "Link to project"}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            );
          })()}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={() => onOpen(thread)}>
          <Eye className="h-4 w-4 mr-2 text-muted-foreground" />
          <span className="text-sm">Open thread</span>
        </ContextMenuItem>
        <ContextMenuItem
          onClick={(e) => { e.stopPropagation(); onToggleStar?.(thread); }}
        >
          <Star className={cn("h-4 w-4 mr-2", isStarred ? "text-amber-500 fill-amber-400" : "text-muted-foreground")} />
          <span className="text-sm">{isStarred ? "Remove star" : "Star"}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={(e) => { e.stopPropagation(); onToggleVisibility?.(thread, isShared ? 'private' : 'shared'); }}
        >
          {isShared
            ? <EyeOff className="h-4 w-4 mr-2 text-muted-foreground" />
            : <Eye className="h-4 w-4 mr-2 text-muted-foreground" />
          }
          <span className="text-sm">{isShared ? "Make private" : "Share with team"}</span>
        </ContextMenuItem>
        <ContextMenuItem
          onClick={(e) => { e.stopPropagation(); onLinkProject?.(thread); }}
        >
          <Link2 className="h-4 w-4 mr-2 text-muted-foreground" />
          <span className="text-sm">{thread.project_id ? "Change project" : "Link to project"}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(thread.from_email || '');
          }}
        >
          <Copy className="h-4 w-4 mr-2 text-muted-foreground" />
          <span className="text-sm">Copy email</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={(e) => { e.stopPropagation(); onContextMenu?.(thread, 'archive'); }}
          className="text-muted-foreground"
        >
          <Archive className="h-4 w-4 mr-2" />
          <span className="text-sm">Archive</span>
        </ContextMenuItem>
        <ContextMenuItem
          onClick={(e) => { e.stopPropagation(); onContextMenu?.(thread, 'delete'); }}
          className="text-red-600 focus:text-red-600"
        >
          <Trash2 className="h-4 w-4 mr-2" />
          <span className="text-sm">Delete</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}