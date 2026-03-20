import React, { useState, useMemo, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, FileText, MessageSquare, Zap, Users, Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import Org2FeedItem from "./Org2FeedItem";
import { format } from "date-fns";

const ACTIVITY_TYPES = [
  { id: "all", label: "All", Icon: null },
  { id: "note", label: "Notes", Icon: FileText },
  { id: "project_note", label: "Project Notes", Icon: FileText },
  { id: "interaction", label: "Interactions", Icon: Users },
  { id: "status_change", label: "Status Changes", Icon: Zap },
];

// Date group header label
function dateSeparatorLabel(dateStr) {
  try {
    const d = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return format(d, 'd MMM yyyy');
  } catch { return ''; }
}

export default function Org2Feed({
  agency,
  projects = [],
  interactions = [],
  orgNotes = [],
  projectNotes = [],
}) {
  const [activeFilter, setActiveFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const scrollContainerRef = useRef(null);
  const scrollPositionRef = useRef({});

  // Build unified feed
  const feedItems = useMemo(() => {
    const items = [];

    // Org notes (root only for counting purposes, but show all)
    orgNotes?.forEach((note) => {
      items.push({
        id: `note-${note.id}`,
        rawId: note.id,
        entityType: 'OrgNote',
        date: note.created_date,
        type: note.parent_note_id ? null : "note", // skip replies from feed
        data: note,
      });
    });

    // Project notes
    projectNotes?.forEach((note) => {
      const project = projects.find((p) => p.id === note.project_id);
      items.push({
        id: `pnote-${note.id}`,
        rawId: note.id,
        entityType: 'ProjectNote',
        date: note.created_date,
        type: "project_note",
        data: { ...note, _project: project },
      });
    });

    // Interactions
    interactions?.forEach((interaction) => {
      items.push({
        id: `interaction-${interaction.id}`,
        rawId: interaction.id,
        entityType: 'InteractionLog',
        date: interaction.date_time || interaction.created_date,
        type: "interaction",
        data: interaction,
      });
    });

    // Project status changes
    projects?.forEach((project) => {
      if (project.last_status_change) {
        items.push({
          id: `status-${project.id}`,
          rawId: project.id,
          entityType: 'Project',
          date: project.last_status_change,
          type: "status_change",
          data: project,
        });
      }
    });

    // Filter out null-type items (note replies) then sort
    return items
      .filter(i => i.type !== null)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [orgNotes, projectNotes, interactions, projects]);

  // Filter and search items
  const filteredItems = useMemo(() => {
    let items = feedItems;
    if (activeFilter !== "all") {
      items = items.filter((item) => item.type === activeFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter((item) => {
        const data = item.data;
        if (item.type === "note" || item.type === "project_note") {
          return (
            data.content?.toLowerCase().includes(q) ||
            data.author_name?.toLowerCase().includes(q)
          );
        }
        if (item.type === "interaction") {
          return (
            data.summary?.toLowerCase().includes(q) ||
            data.details?.toLowerCase().includes(q) ||
            data.user_name?.toLowerCase().includes(q) ||
            data.interaction_type?.toLowerCase().includes(q)
          );
        }
        if (item.type === "status_change") {
          return data.title?.toLowerCase().includes(q);
        }
        return false;
      });
    }
    return items;
  }, [feedItems, activeFilter, searchQuery]);

  const activeCounts = useMemo(() => {
    const counts = { all: feedItems.length };
    ACTIVITY_TYPES.forEach((type) => {
      if (type.id !== "all") {
        counts[type.id] = feedItems.filter((item) => item.type === type.id).length;
      }
    });
    return counts;
  }, [feedItems]);

  // Root-only notes count for stats bar (no replies)
  const rootNoteCount = useMemo(
    () => orgNotes.filter(n => !n.parent_note_id).length,
    [orgNotes]
  );

  const interactionStats = useMemo(() => {
    return interactions?.reduce((acc, i) => {
      const method = i.interaction_type || 'other';
      acc[method] = (acc[method] || 0) + 1;
      return acc;
    }, {}) || {};
  }, [interactions]);

  // Pin a note
  const handlePin = async (itemId) => {
    const item = feedItems.find(i => i.id === itemId);
    if (!item || item.entityType !== 'OrgNote') return;
    const note = item.data;
    await base44.entities.OrgNote.update(item.rawId, { is_pinned: !note.is_pinned });
  };

  // Delete any feed item
  const handleDelete = async (itemId) => {
    const item = feedItems.find(i => i.id === itemId);
    if (!item) return;
    if (!confirm('Delete this item? This cannot be undone.')) return;
    if (item.entityType === 'OrgNote') {
      await base44.entities.OrgNote.delete(item.rawId);
    } else if (item.entityType === 'InteractionLog') {
      await base44.entities.InteractionLog.delete(item.rawId);
    }
    // Status changes and project notes are not deletable from the feed
  };

  // Scroll position preservation on filter change
  useEffect(() => {
    const key = `${activeFilter}:${searchQuery}`;
    if (scrollContainerRef.current) {
      if (scrollPositionRef.current[key] !== undefined) {
        scrollContainerRef.current.scrollTop = scrollPositionRef.current[key];
      } else {
        scrollContainerRef.current.scrollTop = 0;
      }
    }
  }, [activeFilter, searchQuery]);

  const handleScroll = (e) => {
    const key = `${activeFilter}:${searchQuery}`;
    scrollPositionRef.current[key] = e.target.scrollTop;
  };

  // Group filtered items by date for separators
  const groupedItems = useMemo(() => {
    const groups = [];
    let lastDateLabel = null;
    filteredItems.forEach(item => {
      const label = dateSeparatorLabel(item.date);
      if (label !== lastDateLabel) {
        groups.push({ type: 'separator', label, id: `sep-${label}` });
        lastDateLabel = label;
      }
      groups.push(item);
    });
    return groups;
  }, [filteredItems]);

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Search Bar */}
      <div className="shrink-0 border-b px-4 py-3">
        <Input
          placeholder="Search notes, interactions, projects..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-8 text-xs"
        />
      </div>

      {/* Stats Bar — root notes count only */}
      {(rootNoteCount > 0 || Object.keys(interactionStats).length > 0) && (
        <div className="shrink-0 border-b px-4 py-2 bg-muted/30 text-[11px] space-y-1">
          <div className="flex gap-4 flex-wrap">
            {rootNoteCount > 0 && <span><span className="font-semibold">{rootNoteCount}</span> notes</span>}
            {Object.entries(interactionStats).map(([method, count]) => (
              <span key={method}><span className="font-semibold">{count}</span> {method}</span>
            ))}
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          {ACTIVITY_TYPES.map((type) => {
            const TypeIcon = type.Icon;
            return (
              <Button
                key={type.id}
                variant={activeFilter === type.id ? "default" : "outline"}
                size="sm"
                onClick={() => setActiveFilter(type.id)}
                className="gap-1.5 text-xs whitespace-nowrap"
              >
                {TypeIcon && <TypeIcon className="h-3.5 w-3.5" />}
                <span>{type.label}</span>
                {activeCounts[type.id] > 0 && (
                  <span className="ml-1 text-xs opacity-75">({activeCounts[type.id]})</span>
                )}
              </Button>
            );
          })}
          {(activeFilter !== "all" || searchQuery) && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => { setActiveFilter("all"); setSearchQuery(""); }}
              title="Clear filters"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Feed Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2" ref={scrollContainerRef} onScroll={handleScroll}>
        {filteredItems.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <p className="font-medium text-sm">
              {searchQuery ? "No matches found" : activeFilter === "all" ? "No activity yet" : "No activities of this type"}
            </p>
            <p className="text-xs mt-1 opacity-70">
              {searchQuery
                ? "Try adjusting your search or filters"
                : activeFilter === "all"
                ? "Activities will appear here as they happen"
                : "Try selecting a different activity type"}
            </p>
          </div>
        ) : (
          groupedItems.map(entry => {
            if (entry.type === 'separator') {
              return (
                <div key={entry.id} className="flex items-center gap-2 py-1">
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">{entry.label}</span>
                  <div className="flex-1 h-px bg-border" />
                </div>
              );
            }
            return (
              <div key={entry.id} className="group relative">
                <Org2FeedItem
                  item={entry}
                  onPin={handlePin}
                  onDelete={handleDelete}
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}