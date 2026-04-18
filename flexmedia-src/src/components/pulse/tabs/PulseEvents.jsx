/**
 * PulseEvents — Events tab for Industry Pulse.
 * Card-based layout with status tracking and add-event dialog.
 */
import React, { useState, useMemo, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Calendar,
  Plus,
  ExternalLink,
  MapPin,
  Clock,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

// ── Category config ───────────────────────────────────────────────────────────

const CATEGORIES = {
  conference: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  networking: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
  training: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  cpd: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  awards: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  other: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const SOURCE_BADGE = {
  reinsw: "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-200 dark:border-blue-800",
  reb: "bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-300 border border-violet-200 dark:border-violet-800",
  arec: "bg-teal-50 text-teal-600 dark:bg-teal-900/30 dark:text-teal-300 border border-teal-200 dark:border-teal-800",
  eventbrite: "bg-orange-50 text-orange-600 dark:bg-orange-900/30 dark:text-orange-300 border border-orange-200 dark:border-orange-800",
  manual: "bg-gray-50 text-gray-500 dark:bg-gray-800 dark:text-gray-400 border border-gray-200 dark:border-gray-700",
};

const STATUS_BADGE = {
  upcoming: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  attended: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  skipped: "bg-muted text-muted-foreground",
};

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "upcoming", label: "Upcoming" },
  { value: "attended", label: "Attended" },
  { value: "skipped", label: "Skipped" },
];

const CATEGORY_OPTIONS = [
  "conference",
  "networking",
  "training",
  "cpd",
  "awards",
  "other",
];

const SOURCE_OPTIONS = [
  "reinsw",
  "reb",
  "arec",
  "eventbrite",
  "manual",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtEventDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-AU", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function fmtTime(d) {
  if (!d) return null;
  try {
    const t = new Date(d).toLocaleTimeString("en-AU", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    // Suppress midnight (00:00) as it usually means no time set
    if (t === "12:00 am") return null;
    return t;
  } catch {
    return null;
  }
}

function deriveStatus(event) {
  if (event.status) return event.status;
  if (!event.event_date) return "upcoming";
  const d = new Date(event.event_date);
  return d < new Date() ? "attended" : "upcoming";
}

function relevanceChipClass(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
  if (n <= 20) return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
  if (n <= 40) return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
  if (n <= 60) return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300";
  if (n <= 80) return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
  return "bg-red-100 text-red-700 font-bold dark:bg-red-900/40 dark:text-red-300";
}

// ── Add Event Dialog ──────────────────────────────────────────────────────────

const EMPTY_FORM = {
  title: "",
  event_date: "",
  organiser: "",
  category: "other",
  source: "manual",
  location: "",
  source_url: "",
  description: "",
};

function AddEventDialog({ open, onClose }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const set = useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!form.title.trim()) {
      toast.error("Title is required");
      return;
    }
    setSaving(true);
    try {
      await api.entities.PulseEvent.create({
        ...form,
        status: "upcoming",
        event_date: form.event_date || null,
      });
      await refetchEntityList("PulseEvent");
      toast.success("Event added");
      setForm(EMPTY_FORM);
      onClose();
    } catch (err) {
      toast.error("Failed to save event: " + (err?.message || "Unknown error"));
    } finally {
      setSaving(false);
    }
  }, [form, onClose]);

  const handleClose = useCallback(() => {
    setForm(EMPTY_FORM);
    onClose();
  }, [onClose]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-primary" />
            Add Event
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 py-1">
          {/* Title */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Title *</label>
            <Input
              placeholder="Event title"
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          {/* Date */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Date & Time</label>
            <Input
              type="datetime-local"
              value={form.event_date}
              onChange={(e) => set("event_date", e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          {/* Organiser */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Organiser</label>
            <Input
              placeholder="e.g. REINSW"
              value={form.organiser}
              onChange={(e) => set("organiser", e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          {/* Category + Source */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Category</label>
              <select
                value={form.category}
                onChange={(e) => set("category", e.target.value)}
                className="w-full h-8 text-sm rounded-md border border-input bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c} value={c} className="capitalize">
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Source</label>
              <select
                value={form.source}
                onChange={(e) => set("source", e.target.value)}
                className="w-full h-8 text-sm rounded-md border border-input bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {SOURCE_OPTIONS.map((s) => (
                  <option key={s} value={s} className="uppercase">
                    {s.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Location */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Location</label>
            <Input
              placeholder="Venue or city"
              value={form.location}
              onChange={(e) => set("location", e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          {/* URL */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">URL</label>
            <Input
              placeholder="https://…"
              value={form.source_url}
              onChange={(e) => set("source_url", e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          {/* Description */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <textarea
              placeholder="Optional notes…"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              rows={3}
              className="w-full text-sm rounded-md border border-input bg-background px-3 py-2 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Add Event"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Event Card ────────────────────────────────────────────────────────────────

function EventCard({ event, onUpdateStatus }) {
  const status = deriveStatus(event);
  const time = fmtTime(event.event_date);
  const isPast = event.event_date && new Date(event.event_date) < new Date();

  return (
    <Card
      className={cn(
        "rounded-xl border shadow-sm transition-opacity",
        status === "skipped" && "opacity-60"
      )}
    >
      <CardContent className="p-4 space-y-3">
        {/* Top row: title + status */}
        <div className="flex items-start justify-between gap-2">
          <h3
            className={cn(
              "text-sm font-semibold leading-snug",
              status === "skipped" && "line-through text-muted-foreground"
            )}
          >
            {event.title || "Untitled Event"}
          </h3>
          <span
            className={cn(
              "flex-shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full capitalize",
              STATUS_BADGE[status] || "bg-muted text-muted-foreground"
            )}
          >
            {status}
          </span>
        </div>

        {/* Date + time */}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {event.event_date && (
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5 flex-shrink-0" />
              {fmtEventDate(event.event_date)}
            </span>
          )}
          {time && (
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5 flex-shrink-0" />
              {time}
            </span>
          )}
        </div>

        {/* Organiser + location */}
        {(event.organiser || event.location || event.venue) && (
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {event.organiser && (
              <span className="font-medium text-foreground">{event.organiser}</span>
            )}
            {(event.venue || event.location) && (
              <span className="flex items-start gap-1">
                <MapPin className="h-3 w-3 flex-shrink-0 mt-0.5" />
                <span className="flex flex-col leading-tight">
                  {event.venue && (
                    <span className="text-foreground">{event.venue}</span>
                  )}
                  {event.location && <span>{event.location}</span>}
                </span>
              </span>
            )}
          </div>
        )}

        {/* Badges row */}
        <div className="flex flex-wrap gap-1.5">
          {event.category && CATEGORIES[event.category] && (
            <span
              className={cn(
                "text-[10px] font-medium px-2 py-0.5 rounded-full capitalize",
                CATEGORIES[event.category]
              )}
            >
              {event.category}
            </span>
          )}
          {event.source && (
            <span
              className={cn(
                "text-[10px] font-medium px-2 py-0.5 rounded-full uppercase",
                SOURCE_BADGE[event.source] || SOURCE_BADGE.manual
              )}
            >
              {event.source}
            </span>
          )}
          {Number.isFinite(Number(event.relevance_score)) && (
            <span
              className={cn(
                "text-[10px] font-medium px-2 py-0.5 rounded-full",
                relevanceChipClass(event.relevance_score)
              )}
              title="Relevance score"
            >
              {Number(event.relevance_score)}
            </span>
          )}
        </div>

        {/* Tags */}
        {Array.isArray(event.tags) && event.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {event.tags.map((tag, i) => (
              <span
                key={`${tag}-${i}`}
                className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border/60"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* URL */}
        {event.source_url && (
          <a
            href={event.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="h-3 w-3" />
            Event details
          </a>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 pt-1 border-t border-border/40">
          {status !== "attended" && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-2 text-emerald-600 border-emerald-200 hover:bg-emerald-50 dark:border-emerald-800 dark:hover:bg-emerald-900/20"
              onClick={() => onUpdateStatus(event.id, "attended")}
            >
              Mark Attended
            </Button>
          )}
          {status !== "skipped" && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-2 text-muted-foreground hover:text-foreground"
              onClick={() => onUpdateStatus(event.id, "skipped")}
            >
              Skip
            </Button>
          )}
          {(status === "attended" || status === "skipped") && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-2 text-muted-foreground"
              onClick={() => onUpdateStatus(event.id, "upcoming")}
            >
              Reset
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

const EVENTS_PAGE_SIZE = 20;

export default function PulseEventsTab({ pulseEvents = [], search = "" }) {
  const [eventStatus, setEventStatus] = useState("all");
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [eventPage, setEventPage] = useState(0);

  // ── Update status ───────────────────────────────────────────────────────────
  const handleUpdateStatus = useCallback(async (id, status) => {
    try {
      await api.entities.PulseEvent.update(id, { status });
      await refetchEntityList("PulseEvent");
    } catch (err) {
      toast.error("Failed to update: " + (err?.message || "Unknown error"));
    }
  }, []);

  // ── Filtered + sorted events ────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const lc = (s) => (s || "").toLowerCase();
    const q = lc(search);

    return pulseEvents
      .filter((e) => {
        // Status filter
        if (eventStatus !== "all") {
          const s = deriveStatus(e);
          if (s !== eventStatus) return false;
        }
        // Search filter (title, organiser)
        if (q) {
          const hay = [e.title, e.organiser].map(lc).join(" ");
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Sort by event_date ascending (nulls last)
        const da = a.event_date ? new Date(a.event_date).getTime() : Infinity;
        const db = b.event_date ? new Date(b.event_date).getTime() : Infinity;
        return da - db;
      });
  }, [pulseEvents, eventStatus, search]);

  const upcomingCount = useMemo(
    () =>
      pulseEvents.filter(
        (e) => deriveStatus(e) === "upcoming"
      ).length,
    [pulseEvents]
  );

  return (
    <div className="space-y-4">
      {/* ── Header bar ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => { setEventStatus(value); setEventPage(0); }}
              className={cn(
                "text-[11px] px-2.5 py-1 rounded-md border font-medium transition-colors",
                eventStatus === value
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
              )}
            >
              {label}
              {value === "upcoming" && upcomingCount > 0 && (
                <span className="ml-1 bg-primary/20 text-primary text-[9px] px-1 rounded-full">
                  {upcomingCount}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="sm:ml-auto flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {filtered.length} event{filtered.length !== 1 ? "s" : ""}
          </span>
          <Button
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={() => setShowAddEvent(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            Add Event
          </Button>
        </div>
      </div>

      {/* ── Event cards ── */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-border/60 bg-card p-12 text-center">
          <Calendar className="h-8 w-8 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium text-muted-foreground">
            No events found
          </p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            {eventStatus !== "all"
              ? "Try changing the status filter"
              : "Add your first event with the button above"}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {(() => { const totalPages = Math.ceil(filtered.length / EVENTS_PAGE_SIZE); const safePage = Math.min(Math.max(0, eventPage), Math.max(0, totalPages - 1)); return filtered.slice(safePage * EVENTS_PAGE_SIZE, (safePage + 1) * EVENTS_PAGE_SIZE); })()
              .map((event) => (
                <EventCard
                  key={event.id}
                  event={event}
                  onUpdateStatus={handleUpdateStatus}
                />
              ))}
          </div>

          {/* ── Pagination ── */}
          {filtered.length > EVENTS_PAGE_SIZE && (() => {
            const totalPages = Math.ceil(filtered.length / EVENTS_PAGE_SIZE);
            const safePage = Math.min(eventPage, totalPages - 1);
            return (
              <div className="flex items-center justify-between px-1 pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={safePage === 0}
                  onClick={() => setEventPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                  Prev
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  Page {safePage + 1} of {totalPages}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setEventPage((p) => Math.min(totalPages - 1, p + 1))}
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </div>
            );
          })()}
        </>
      )}

      {/* ── Add Event dialog ── */}
      <AddEventDialog
        open={showAddEvent}
        onClose={() => setShowAddEvent(false)}
      />
    </div>
  );
}
