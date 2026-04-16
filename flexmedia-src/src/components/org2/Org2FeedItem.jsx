import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { formatDistanceToNow, format } from "date-fns";
import {
  StickyNote, Camera, Activity, Mail, Phone,
  Users, MessageSquare, ArrowRight, Pin, Trash2, MoreVertical, FileText
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function safeFormatDistance(date) {
  try { return formatDistanceToNow(date, { addSuffix: true }); } catch { return ''; }
}

function safeFormat(date, fmt) {
  try { return format(date, fmt); } catch { return ''; }
}

function TimeStamp({ date }) {
  const d = date ? new Date(date) : null;
  const rel = d && !isNaN(d) ? safeFormatDistance(d) : '—';
  const abs = d && !isNaN(d) ? safeFormat(d, 'PPpp') : '';
  return (
    <span className="text-[11px] text-muted-foreground whitespace-nowrap" title={abs}>
      {rel}
    </span>
  );
}

function ProjectLink({ project }) {
  const price = project.calculated_price || project.price;
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <Link
        to={createPageUrl("ProjectDetails") + `?id=${project.id}`}
        className="text-primary hover:underline font-semibold text-xs"
      >
        {project.title}
      </Link>
      {price > 0 && (
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-semibold">
          A${price.toLocaleString()}
        </Badge>
      )}
    </span>
  );
}

function ItemMenu({ item, onPin, onDelete }) {
  const canPin = item.entityType === 'OrgNote';
  const canDelete = item.entityType === 'OrgNote' || item.entityType === 'InteractionLog';
  if (!canPin && !canDelete) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <MoreVertical className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-32">
        {canPin && (
          <DropdownMenuItem onClick={() => onPin?.(item.id)}>
            <Pin className="h-3.5 w-3.5 mr-2" />
            {item.data?.is_pinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>
        )}
        {canDelete && (
          <DropdownMenuItem className="text-red-600" onClick={() => onDelete?.(item.id)}>
            <Trash2 className="h-3.5 w-3.5 mr-2" />
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Note ──────────────────────────────────────────────────────────────────────
function NoteItem({ item, onPin, onDelete }) {
  const { data, date } = item;
  return (
    <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StickyNote className="h-3.5 w-3.5 text-yellow-600 shrink-0" />
          <span className="text-xs font-semibold text-yellow-900">{data.author_name || 'Note'}</span>
          {data.is_pinned && <Pin className="h-3 w-3 text-yellow-600" />}
        </div>
        <div className="flex items-center gap-1">
          <TimeStamp date={date} />
          <ItemMenu item={item} onPin={onPin} onDelete={onDelete} />
        </div>
      </div>
      <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap line-clamp-6">{data.content}</p>
      {data.focus_tags?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {data.focus_tags.map(tag => (
            <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">{tag}</Badge>
          ))}
        </div>
      )}
      {data.attachments?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-yellow-200">
          {data.attachments.map((att, i) => (
            <a
              key={i}
              href={att.file_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-2 py-1 bg-yellow-100 border border-yellow-300 rounded-md text-[11px] text-yellow-800 hover:bg-yellow-200 transition-colors"
            >
              📎 {att.file_name}
              {att.file_size != null && <span className="opacity-60">· {Math.round(att.file_size / 1024)}KB</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Project Note ──────────────────────────────────────────────────────────────
function ProjectNoteItem({ item }) {
  const { data, date } = item;
  const project = data._project;
  return (
    <div className="bg-white border border-border rounded-xl p-3.5 space-y-2 shadow-sm">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
            <FileText className="h-3.5 w-3.5 text-blue-600" />
          </div>
          <span className="text-xs font-semibold">Project Note</span>
          {data.author_name && <span className="text-[11px] text-muted-foreground">· {data.author_name}</span>}
        </div>
        <TimeStamp date={date} />
      </div>
      {project && (
        <div className="text-[11px]">
          <ProjectLink project={project} />
        </div>
      )}
      <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap line-clamp-4">{data.content}</p>
      {data.attachments?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1 border-t">
          {data.attachments.map((att, i) => (
            <a
              key={i}
              href={att.file_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-2 py-1 bg-blue-50 border border-blue-200 rounded-md text-[11px] text-blue-700 hover:bg-blue-100 transition-colors"
            >
              📎 {att.file_name}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Interaction ───────────────────────────────────────────────────────────────
const INTERACTION_ICONS = {
  'Email Sent':       Mail,
  'Email Received':   Mail,
  'Phone Call':       Phone,
  'LinkedIn Message': Users,
  'Meeting':          Users,
  'Note Added':       StickyNote,
  'Status Change':    Activity,
};

const SENTIMENT_STYLES = {
  Positive: 'text-green-600 bg-green-50 border-green-200',
  Neutral:  'text-gray-600 bg-gray-50 border-gray-200',
  Negative: 'text-red-600 bg-red-50 border-red-200',
};

function InteractionItem({ item, onDelete }) {
  const { data, date } = item;
  const Icon = INTERACTION_ICONS[data.interaction_type] || MessageSquare;
  const sentimentStyle = data.sentiment ? SENTIMENT_STYLES[data.sentiment] : null;

  return (
    <div className="bg-white border border-border rounded-xl p-3.5 space-y-2 shadow-sm">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
            <Icon className="h-3.5 w-3.5 text-blue-600" />
          </div>
          <span className="text-xs font-semibold">{data.interaction_type}</span>
          {data.user_name && (
            <span className="text-[11px] text-muted-foreground">· {data.user_name}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {sentimentStyle && (
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${sentimentStyle}`}>
              {data.sentiment}
            </span>
          )}
          <TimeStamp date={date} />
          <ItemMenu item={item} onPin={null} onDelete={onDelete} />
        </div>
      </div>
      <p className="text-sm font-medium leading-snug">{data.summary}</p>
      {data.details && (
        <p className="text-xs text-muted-foreground leading-relaxed border-t pt-2 mt-1">{data.details}</p>
      )}
    </div>
  );
}

// ── Project Created ────────────────────────────────────────────────────────────
function ProjectCreatedItem({ item }) {
  const { data, date } = item;
  return (
    <div className="bg-white border border-border rounded-xl p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
            <Camera className="h-3 w-3 text-blue-500" />
          </div>
          <span className="text-[11px] text-muted-foreground font-medium">Project created</span>
          {data.project_owner_name && (
            <span className="text-[11px] text-muted-foreground">· {data.project_owner_name}</span>
          )}
        </div>
        <TimeStamp date={date} />
      </div>
      <ProjectLink project={data} />
      {data.property_address && (
        <p className="text-[11px] text-muted-foreground mt-1">{data.property_address}</p>
      )}
    </div>
  );
}

// ── Status Change ─────────────────────────────────────────────────────────────
const STATUS_LABELS = {
  to_be_scheduled: 'To Schedule',
  scheduled: 'Scheduled',
  onsite: 'Onsite',
  uploaded: 'Uploaded',
  submitted: 'Submitted',
  in_progress: 'In Progress',
  ready_for_partial: 'Partial',
  in_revision: 'In Revision',
  delivered: 'Delivered',
};

function StatusChangeItem({ item }) {
  const { data, date } = item;
  const statusLabel = STATUS_LABELS[data.status] || data.status;

  return (
    <div className="bg-white border border-border rounded-xl p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="h-5 w-5 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
              <Activity className="h-3 w-3 text-amber-500" />
            </div>
            <span className="text-[11px] text-muted-foreground font-medium">
              Status → <span className="font-semibold text-foreground">{statusLabel}</span>
            </span>
          </div>
          <ProjectLink project={data} />
        </div>
        <TimeStamp date={date} />
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function Org2FeedItem({ item, onPin, onDelete }) {
  const { type } = item;
  if (type === 'note')            return <NoteItem item={item} onPin={onPin} onDelete={onDelete} />;
  if (type === 'project_note')    return <ProjectNoteItem item={item} />;
  if (type === 'interaction')     return <InteractionItem item={item} onDelete={onDelete} />;
  if (type === 'project_created') return <ProjectCreatedItem item={item} />;
  if (type === 'status_change')   return <StatusChangeItem item={item} />;
  return null;
}