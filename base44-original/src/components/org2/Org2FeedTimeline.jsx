import React from "react";
import { cn } from "@/lib/utils";
import {
  FileText, MessageSquare, CheckCircle2, Clock, Package, 
  Zap, MoreVertical, Pin, Trash2, Edit2, PaperclipIcon
} from "lucide-react";
import { format } from "date-fns";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Icon mapping for artifact types
const ARTIFACT_ICONS = {
  note: { Icon: FileText, color: "bg-amber-100 text-amber-700", priority: 1 },
  project_note: { Icon: FileText, color: "bg-yellow-100 text-yellow-700", priority: 1 },
  interaction: { Icon: MessageSquare, color: "bg-blue-100 text-blue-700", priority: 2 },
  status_change: { Icon: Zap, color: "bg-purple-100 text-purple-700", priority: 3 },
  project_created: { Icon: Package, color: "bg-green-100 text-green-700", priority: 2 },
};

function TimelineItem({ item, onPin, onDelete, onEdit }) {
  const artifactConfig = ARTIFACT_ICONS[item.type] || { Icon: Clock, color: "bg-gray-100 text-gray-700" };
  const { Icon, color } = artifactConfig;
  const data = item.data;

  let title = "";
  let subtitle = "";
  let metadata = [];
  let attachments = [];

  if (item.type === "note") {
    title = data.content?.substring(0, 100) || "Note";
    subtitle = data.author_name || "Unknown";
    metadata = [{ label: "Author", value: data.author_email }];
    attachments = data.attachments || [];
  } else if (item.type === "project_note") {
    title = data.content?.substring(0, 100) || "Project note";
    subtitle = data.author_name || "Unknown";
    const project = data._project;
    metadata = [
      ...(project ? [{ label: "Project", value: project.title, href: createPageUrl("ProjectDetails") + `?id=${project.id}` }] : []),
      { label: "Author", value: data.author_email },
    ];
    attachments = data.attachments || [];
  } else if (item.type === "interaction") {
    title = `Activity: ${data.subject || "Interaction"}`;
    subtitle = data.notes?.substring(0, 80) || "—";
    metadata = [
      { label: "Type", value: data.type || "—" },
      { label: "User", value: data.user_name || "Unknown" },
    ];
  } else if (item.type === "status_change") {
    title = `Status changed: ${data.status?.replace(/_/g, " ").toUpperCase() || "—"}`;
    subtitle = `${data.title}`;
    metadata = [
      { label: "Project", value: data.title, href: createPageUrl("ProjectDetails") + `?id=${data.id}` },
    ];
  } else if (item.type === "project_created") {
    title = `Project created: ${data.title}`;
    subtitle = data.property_address || "—";
    metadata = [
      { label: "Client", value: data.client_name || "—" },
      { label: "Status", value: data.status?.replace(/_/g, " ").toUpperCase() || "—" },
    ];
  }

  return (
    <div className="flex gap-3 pb-4">
      {/* Timeline dot and line */}
      <div className="flex flex-col items-center gap-1 relative">
        <div className={cn("h-8 w-8 rounded-full flex items-center justify-center shrink-0 shadow-sm border border-background", color)}>
          <Icon className="h-4 w-4" />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pt-0.5">
        <div className={`bg-white border rounded-lg p-3 hover:shadow-sm transition-shadow group ${artifactConfig.priority === 1 ? 'border-l-2 border-l-amber-400' : ''}`}>
          {/* Header with time and controls */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-foreground leading-tight">{title}</p>
              {subtitle && <p className="text-xs text-muted-foreground mt-0.5 truncate">{subtitle}</p>}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <MoreVertical className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-32">
                {(item.type === "note" || item.type === "project_note") && (
                  <>
                    <DropdownMenuItem onClick={() => onPin?.(item.id)}>
                      <Pin className="h-3.5 w-3.5 mr-2" />
                      Pin note
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onEdit?.(item.id)}>
                      <Edit2 className="h-3.5 w-3.5 mr-2" />
                      Edit
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuItem className="text-red-600" onClick={() => onDelete?.(item.id)}>
                  <Trash2 className="h-3.5 w-3.5 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Metadata tags */}
          {metadata.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {metadata.map((meta, idx) => (
                <div key={idx} className="text-[10px] text-muted-foreground inline-block">
                  {meta.href ? (
                    <Link to={meta.href} className="text-blue-600 hover:underline font-medium">
                      {meta.value}
                    </Link>
                  ) : (
                    <span>
                      <span className="font-medium">{meta.label}:</span> {meta.value}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Attachments */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2 pt-1.5 border-t">
              {attachments.map((att, idx) => (
                <a
                  key={idx}
                  href={att.file_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-200 rounded-md hover:bg-blue-100 transition-colors"
                >
                  <PaperclipIcon className="h-3 w-3" />
                  {att.file_name}
                  {att.file_size && <span className="opacity-60">· {Math.round(att.file_size / 1024)}KB</span>}
                </a>
              ))}
            </div>
          )}

          {/* Timestamp */}
          <p className="text-[10px] text-muted-foreground mt-1.5 pt-1.5 border-t">
            {item.date && new Date(item.date).getTime() ? format(new Date(item.date), "d MMM yyyy, h:mm a") : "—"}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Org2FeedTimeline({ items = [], onPin, onDelete, onEdit }) {
  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        <p className="font-medium">No activity</p>
        <p className="text-xs mt-1 opacity-70">Events will appear here as they happen</p>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {items.map(item => (
        <TimelineItem
          key={item.id}
          item={item}
          onPin={onPin}
          onDelete={onDelete}
          onEdit={onEdit}
        />
      ))}
    </div>
  );
}