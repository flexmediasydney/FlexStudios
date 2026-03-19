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
      // Remove entire <style>...</style> and <script>...</script> blocks including their content
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      // Remove all remaining HTML tags
      .replace(/<[^>]*>/g, ' ')
      // Decode common HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim();
  };

  const priorityConfig = PRIORITY_LIST_STYLES;

  // Early guard: if thread has no messages, don't render
  if (!thread?.messages || thread.messages.length === 0) return null;
  
  const priority = thread.messages[0]?.priority;
  const priorityClass = priorityConfig[priority] || '';
  const isUnread = thread.unreadCount > 0;
  const isStarred = thread.is_starred;
  const labels = thread.messages[0]?.labels || [];
  const attachments = thread.messages[0]?.attachments || [];
  const displayDate = formatEmailDate(thread.lastMessage);

  // Smart attachment filtering: exclude tiny files (<5KB) and common system icons
  const isGarbage = (att) => {
    if (!att) return true;
    const size = att.size || 0;
    const name = (att.filename || '').toLowerCase();
    
    // Exclude files under 5KB (likely icons/metadata)
    if (size < 5120) return true;
    
    // Common junk files
    if (name.match(/\.(gif|png|jpg|jpeg|webp)$/) && size < 50000) return true; // Tiny images
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
            "h-[56px] transition-all duration-150",
            "hover:bg-blue-50",
            isSelected && "bg-blue-100 border-l-[4px] border-l-blue-600 shadow-sm",
            isUnread && !isSelected && "bg-blue-50 border-l-[4px] border-l-blue-500 font-medium",
            !isUnread && !isSelected && priorityClass
          )}
          style={{ minWidth: `${totalRowWidth}px` }}
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

      {/* Star — fully wired */}
      {columns.some(c => c.id === 'star') && (
        <TooltipProvider delayDuration={400}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  "flex-shrink-0 w-8 h-8 flex items-center justify-center transition-all duration-150 rounded-lg",
                  "hover:bg-amber-100/60 active:scale-95",
                  isStarred
                    ? "opacity-100 text-amber-500"
                    : "opacity-40 group-hover:opacity-70 hover:!opacity-100 text-muted-foreground"
                )}
                onClick={(e) => { e.stopPropagation(); onToggleStar?.(thread); }}
                aria-label={isStarred ? "Remove star" : "Star this email"}
                title={isStarred ? "Remove star" : "Star this email"}
              >
                <Star className={cn(
                  "h-4 w-4 transition-all",
                  isStarred ? "fill-current" : ""
                )} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {isStarred ? "Remove star" : "Star"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

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
        </div>
        );
      })()}

      {/* Subject + Labels + Preview */}
      {columns.some(c => c.id === 'subject') && (() => {
        const col = columns.find(c => c.id === 'subject');
        const w = col?.width ?? 400;
        const bodyText = stripHtml(thread.messages[0].body);
        const preview = bodyText.substring(0, 250);
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
              <SubjectHoverCard
                subject={cleanSubject}
                preview={preview}
                labels={labels}
                from={thread.from_name}
                fromEmail={thread.from_email}
                date={thread.lastMessage ? new Date(thread.lastMessage).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : undefined}
                messageCount={thread.messages.length}
                attachmentCount={realAttachments.length}
              >
                <span className={cn(
                    "truncate text-[14px] leading-snug cursor-default min-w-0 block font-medium",
                    isUnread ? "font-bold text-foreground" : "text-foreground/80"
                  )}>
                    {cleanSubject || <em className="text-muted-foreground/40 not-italic">(no subject)</em>}
                  </span>
              </SubjectHoverCard>
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
              <span className="text-[12px] text-muted-foreground/65 truncate min-w-0 italic">
                {preview}
              </span>
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
        const isShared = thread.messages[0]?.visibility === 'shared';
        return (
          <div className="flex-shrink-0 w-8 flex items-center justify-center">
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
            {/* Project name or placeholder */}
            <div className="flex-1 min-w-0 overflow-hidden">
              {thread.project_id ? (
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-green-500" />
                  <span className="text-[12px] font-medium text-foreground/75 truncate" title={thread.project_title}>
                    {thread.project_title}
                  </span>
                </div>
              ) : (
                <span className="text-[11px] text-muted-foreground/40 flex items-center gap-1">
                  <Link2 className="h-3 w-3" />
                  No project
                </span>
              )}
            </div>

            {/* Link / Change button */}
            <TooltipProvider delayDuration={400}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onLinkProject?.(thread)}
                    className={cn(
                      "flex-shrink-0 h-8 px-3 rounded-lg text-[12px] font-bold",
                      "transition-all duration-150 flex items-center gap-1.5 active:scale-95",
                      thread.project_id
                        ? "bg-emerald-100 hover:bg-emerald-200 text-emerald-800 border border-emerald-300"
                        : "bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg"
                    )}
                    aria-label={thread.project_id ? "Change linked project" : "Link to project"}
                    title={thread.project_id ? `Linked: ${thread.project_title}` : "Link to project"}
                  >
                    <Link2 className="h-4 w-4" />
                    {thread.project_id ? "Change" : "Link"}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" className="text-xs">
                  {thread.project_id
                    ? `Change project (currently: ${thread.project_title})`
                    : "Link this email thread to a project"}
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
          onClick={(e) => { e.stopPropagation(); onToggleStar?.(thread); }}
        >
          <Star className={cn("h-3.5 w-3.5 mr-2", isStarred ? "text-amber-400 fill-amber-400" : "text-muted-foreground")} />
          {isStarred ? "Remove star" : "Star"}
        </ContextMenuItem>
        <ContextMenuSeparator />
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