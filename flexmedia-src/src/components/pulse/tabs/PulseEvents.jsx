/**
 * PulseEvents — Events tab for Industry Pulse.
 * Card-based layout with status tracking and add-event dialog.
 */
import React, { useState, useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  Download,
  CalendarPlus,
  LayoutGrid,
  List as ListIcon,
  ChevronsDown,
  ChevronsUp,
} from "lucide-react";
import { exportFilteredCsv, downloadIcs } from "@/components/pulse/utils/qolHelpers";
import PresetControls from "@/components/pulse/utils/PresetControls";

// ── Category config ───────────────────────────────────────────────────────────

const CATEGORIES = {
  conference: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  networking: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
  training: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  cpd: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  awards: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  auction: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  expo: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300",
  industry_meetup: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  other: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const SOURCE_BADGE = {
  reinsw: "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-200 dark:border-blue-800",
  reb: "bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-300 border border-violet-200 dark:border-violet-800",
  arec: "bg-teal-50 text-teal-600 dark:bg-teal-900/30 dark:text-teal-300 border border-teal-200 dark:border-teal-800",
  eventbrite: "bg-orange-50 text-orange-600 dark:bg-orange-900/30 dark:text-orange-300 border border-orange-200 dark:border-orange-800",
  linkedin: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-200 dark:border-blue-800",
  domain: "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800",
  realestate: "bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300 border border-red-200 dark:border-red-800",
  manual: "bg-gray-50 text-gray-500 dark:bg-gray-800 dark:text-gray-400 border border-gray-200 dark:border-gray-700",
};

const STATUS_BADGE = {
  upcoming: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  attended: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  skipped: "bg-muted text-muted-foreground",
  cancelled: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
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
  "auction",
  "expo",
  "industry_meetup",
  "other",
];

const SOURCE_OPTIONS = [
  "reinsw",
  "reb",
  "arec",
  "eventbrite",
  "linkedin",
  "domain",
  "realestate",
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
  venue: "",
  source_url: "",
  description: "",
  relevance_score: 50,
  tags: "", // comma-separated; parsed on save
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
      // Parse tags: comma-separated → trimmed array, drop empties
      const tagsArr = (form.tags || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      // Coerce relevance_score to integer in [0, 100]
      const relN = Number(form.relevance_score);
      const relevance =
        Number.isFinite(relN) ? Math.max(0, Math.min(100, Math.round(relN))) : null;

      const { tags: _drop, ...rest } = form;
      await api.entities.PulseEvent.create({
        ...rest,
        status: "upcoming",
        event_date: form.event_date || null,
        venue: form.venue || null,
        relevance_score: relevance,
        tags: tagsArr,
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

          {/* Location (city / suburb) + Venue (specific building) */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Location</label>
              <Input
                placeholder="City or suburb"
                value={form.location}
                onChange={(e) => set("location", e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Venue</label>
              <Input
                placeholder="e.g. ICC Sydney"
                value={form.venue}
                onChange={(e) => set("venue", e.target.value)}
                className="h-8 text-sm"
              />
            </div>
          </div>

          {/* Relevance score + Tags */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Relevance <span className="text-muted-foreground/60">({form.relevance_score || 0}/100)</span>
              </label>
              <Input
                type="number"
                min={0}
                max={100}
                step={5}
                value={form.relevance_score}
                onChange={(e) => set("relevance_score", e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Tags</label>
              <Input
                placeholder="comma,separated"
                value={form.tags}
                onChange={(e) => set("tags", e.target.value)}
                className="h-8 text-sm"
              />
            </div>
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
        <div className="flex gap-2 pt-1 border-t border-border/40 flex-wrap">
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
          {/* #53: emit client-side .ics so the user can add this to Apple/Google/Outlook */}
          {event.event_date && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-2 text-blue-600 hover:text-blue-700 ml-auto"
              onClick={() =>
                downloadIcs({
                  id:          event.id,
                  title:       event.title || "Event",
                  date:        event.event_date,
                  venue:       event.venue,
                  location:    event.location,
                  description: event.description,
                })
              }
              title="Download a calendar file (.ics) for this event"
            >
              <CalendarPlus className="h-3 w-3 mr-1" />
              Add to Calendar
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Calendar month view (#48) ─────────────────────────────────────────────────

function CalendarMonthView({ month, events, onPrev, onNext, onToday, onPickDay }) {
  const cells = useMemo(() => calendarCells(month), [month]);

  // Bucket events by YYYY-MM-DD
  const byDay = useMemo(() => {
    const map = new Map();
    for (const e of events) {
      if (!e.event_date) continue;
      const d = new Date(e.event_date);
      if (isNaN(d.getTime())) continue;
      const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(e);
    }
    return map;
  }, [events]);

  const today = new Date();
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  return (
    <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onPrev}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onNext}>
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-[11px] ml-1" onClick={onToday}>
            Today
          </Button>
        </div>
        <div className="text-sm font-semibold">
          {month.toLocaleDateString("en-AU", { month: "long", year: "numeric" })}
        </div>
        <div className="w-[120px]" />
      </div>
      <div className="grid grid-cols-7 text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/30">
        {DOW.map((d) => (
          <div key={d} className="px-2 py-1 text-center">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 border-t border-border/40">
        {cells.map(({ date, inMonth }, i) => {
          const k = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
          const dayEvents = byDay.get(k) || [];
          const isToday = sameYMD(date, today);
          return (
            <button
              type="button"
              key={i}
              onClick={() => onPickDay(date)}
              className={cn(
                "min-h-[80px] sm:min-h-[96px] p-1 text-left border-r border-b border-border/30 overflow-hidden",
                !inMonth && "bg-muted/20 text-muted-foreground/50",
                "hover:bg-muted/40 transition-colors cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
              )}
              title={`${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"} on ${date.toLocaleDateString("en-AU")}`}
            >
              <div className={cn(
                "text-[11px] font-medium tabular-nums mb-0.5",
                isToday && "inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
              )}>
                {date.getDate()}
              </div>
              <div className="space-y-0.5">
                {dayEvents.slice(0, 3).map((e) => (
                  <div
                    key={e.id}
                    className={cn(
                      "flex items-center gap-1 text-[9px] px-1 py-0.5 rounded truncate",
                      (e.category && CATEGORIES[e.category]) || "bg-muted text-muted-foreground"
                    )}
                    title={e.title}
                  >
                    <span className="truncate flex-1">{e.title}</span>
                  </div>
                ))}
                {dayEvents.length > 3 && (
                  <div className="text-[9px] text-muted-foreground px-1">
                    +{dayEvents.length - 3} more
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Recurring group card (#58) ────────────────────────────────────────────────

function RecurringGroupCard({ entry, expanded, onToggle, onUpdateStatus }) {
  const { leader, past, upcoming } = entry;
  const status = deriveStatus(leader);
  const time = fmtTime(leader.event_date);

  return (
    <Card className="rounded-xl border shadow-sm">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold leading-snug">
            {leader.title || "Untitled Event"}
          </h3>
          <span
            className={cn(
              "flex-shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full capitalize",
              STATUS_BADGE[status] || "bg-muted text-muted-foreground"
            )}
          >
            Recurring
          </span>
        </div>

        {leader.organiser && (
          <p className="text-[11px] text-muted-foreground font-medium">{leader.organiser}</p>
        )}

        <div className="text-xs bg-muted/30 rounded-md p-2 space-y-1">
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Next:</span>{" "}
            {upcoming.length > 0
              ? (
                <>
                  {fmtEventDate(leader.event_date)}
                  {time && <> · {time}</>}
                </>
              )
              : <span className="italic text-muted-foreground/70">No upcoming occurrences</span>
            }
          </p>
          <div className="flex gap-3 text-[10px] text-muted-foreground">
            <span>{upcoming.length} upcoming</span>
            <span>{past.length} past</span>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="h-6 text-[10px] px-2 w-full gap-1"
          onClick={onToggle}
        >
          {expanded ? (
            <>
              <ChevronsUp className="h-3 w-3" />
              Collapse occurrences
            </>
          ) : (
            <>
              <ChevronsDown className="h-3 w-3" />
              Show {past.length} past / {upcoming.length} upcoming
            </>
          )}
        </Button>

        {expanded && (
          <div className="space-y-2 pt-1 border-t border-border/40 mt-1 max-h-[240px] overflow-y-auto">
            {[...upcoming, ...past]
              .sort((a, b) => new Date(a.event_date || 0) - new Date(b.event_date || 0))
              .map((e) => (
                <div
                  key={e.id}
                  className="text-[11px] flex items-center justify-between gap-2 py-1 border-b border-border/20 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-foreground font-medium">
                      {fmtEventDate(e.event_date)}
                      {fmtTime(e.event_date) && <> · {fmtTime(e.event_date)}</>}
                    </p>
                    {(e.venue || e.location) && (
                      <p className="text-muted-foreground text-[10px] truncate">
                        {[e.venue, e.location].filter(Boolean).join(", ")}
                      </p>
                    )}
                  </div>
                  {e.event_date && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 text-[9px] px-1.5 text-blue-600 shrink-0"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        downloadIcs({
                          id:       e.id,
                          title:    e.title,
                          date:     e.event_date,
                          venue:    e.venue,
                          location: e.location,
                          description: e.description,
                        });
                      }}
                      title="Add this occurrence to calendar"
                    >
                      <CalendarPlus className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

const EVENTS_PAGE_SIZE = 20;

// #58: group key for collapsing recurring occurrences. Two events fall into the
// same group iff `${title}||${organiser}` matches (case-insensitive, trimmed).
function recurringKey(event) {
  const t = (event.title || "").toLowerCase().trim();
  const o = (event.organiser || "").toLowerCase().trim();
  return `${t}||${o}`;
}

// #48: helpers for the month-grid calendar view.
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function calendarCells(viewMonth) {
  // Emits an array of 42 { date, inMonth } cells covering the 6-week grid that
  // surrounds `viewMonth`. Starts on Monday (AU convention).
  const first = startOfMonth(viewMonth);
  const firstDow = first.getDay(); // 0..6, Sun..Sat
  const mondayOffset = firstDow === 0 ? -6 : 1 - firstDow;
  const gridStart = new Date(first.getFullYear(), first.getMonth(), first.getDate() + mondayOffset);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    cells.push({ date: d, inMonth: d.getMonth() === first.getMonth() });
  }
  return cells;
}
function sameYMD(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export default function PulseEventsTab({ search = "" }) {
  const [eventStatus, setEventStatus] = useState("all");
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [eventPage, setEventPage] = useState(0);
  // #48: "list" (default) vs "calendar" month view.
  const [viewMode, setViewMode] = useState("list");
  const [calMonth, setCalMonth] = useState(() => startOfMonth(new Date()));
  const [calDayFilter, setCalDayFilter] = useState(null); // Date | null
  // #58: expanded recurring groups (keyed by recurringKey)
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());

  // ── Own data fetch (unbounded, server-sorted) ─────────────────────────────
  // Previously consumed a shared pulseEvents array fetched at the page level
  // (capped at 200). Now each mount issues a single query targeted at
  // pulse_events. Events are dense (a few thousand total) but we still run
  // server-side ordering so the UI can render the earliest upcoming first.
  const queryClient = useQueryClient();
  const { data: pulseEvents = [] } = useQuery({
    queryKey: ["pulse-events-list"],
    queryFn: async () => {
      const { data, error } = await api._supabase
        .from("pulse_events")
        .select("*")
        .order("event_date", { ascending: true, nullsFirst: false })
        .limit(10000);
      if (error) throw error;
      return data || [];
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // ── Update status ───────────────────────────────────────────────────────────
  const handleUpdateStatus = useCallback(async (id, status) => {
    try {
      await api.entities.PulseEvent.update(id, { status });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["pulse-events-list"] }),
        refetchEntityList("PulseEvent"),
      ]);
    } catch (err) {
      toast.error("Failed to update: " + (err?.message || "Unknown error"));
    }
  }, [queryClient]);

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
        // #48: day filter from calendar cell click
        if (calDayFilter) {
          if (!e.event_date) return false;
          if (!sameYMD(new Date(e.event_date), calDayFilter)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Sort by event_date ascending (nulls last)
        const da = a.event_date ? new Date(a.event_date).getTime() : Infinity;
        const db = b.event_date ? new Date(b.event_date).getTime() : Infinity;
        return da - db;
      });
  }, [pulseEvents, eventStatus, search, calDayFilter]);

  // #58: group filtered events by `${title}||${organiser}`. Groups with ≥2
  // occurrences render as one card showing the earliest future occurrence +
  // expand controls. Single-occurrence groups render a plain card.
  //
  // Each display entry is one of:
  //   { type: "single",    event }
  //   { type: "collapsed", leader, past: [...], upcoming: [...] }
  //   { type: "expanded",  leader, past: [...], upcoming: [...] }   — rendered inline
  const displayEntries = useMemo(() => {
    const groups = new Map();
    for (const e of filtered) {
      const k = recurringKey(e);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const now = Date.now();
    const result = [];
    for (const [key, evs] of groups.entries()) {
      if (evs.length <= 1) {
        result.push({ type: "single", key, event: evs[0], sortKey: (evs[0].event_date ? new Date(evs[0].event_date).getTime() : Infinity) });
        continue;
      }
      const past = evs.filter((e) => e.event_date && new Date(e.event_date).getTime() < now);
      const upcoming = evs.filter((e) => !e.event_date || new Date(e.event_date).getTime() >= now);
      // Leader = earliest future if any, otherwise latest past.
      let leader;
      if (upcoming.length > 0) {
        leader = upcoming.reduce((acc, e) =>
          !acc || new Date(e.event_date) < new Date(acc.event_date) ? e : acc
        , null);
      } else {
        leader = past.reduce((acc, e) =>
          !acc || new Date(e.event_date) > new Date(acc.event_date) ? e : acc
        , null);
      }
      result.push({
        type: expandedGroups.has(key) ? "expanded" : "collapsed",
        key,
        leader,
        past,
        upcoming,
        sortKey: leader?.event_date ? new Date(leader.event_date).getTime() : Infinity,
      });
    }
    result.sort((a, b) => a.sortKey - b.sortKey);
    return result;
  }, [filtered, expandedGroups]);

  const toggleGroup = useCallback((key) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

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

        <div className="sm:ml-auto flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground">
            {filtered.length} event{filtered.length !== 1 ? "s" : ""}
          </span>
          {/* #48: list / calendar toggle */}
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            <button
              type="button"
              className={cn(
                "h-7 px-2 text-[11px] flex items-center gap-1 transition-colors",
                viewMode === "list"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:text-foreground"
              )}
              onClick={() => { setViewMode("list"); setCalDayFilter(null); }}
              title="List view"
            >
              <ListIcon className="h-3 w-3" />
              List
            </button>
            <button
              type="button"
              className={cn(
                "h-7 px-2 text-[11px] flex items-center gap-1 transition-colors",
                viewMode === "calendar"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setViewMode("calendar")}
              title="Calendar month view"
            >
              <LayoutGrid className="h-3 w-3" />
              Calendar
            </button>
          </div>
          {/* #51: filter presets (Events namespace) */}
          <PresetControls
            namespace="events"
            currentPreset={{ eventStatus }}
            onLoad={(p) => {
              if (p?.eventStatus) setEventStatus(p.eventStatus);
              setEventPage(0);
            }}
          />
          {/* #52: export filtered events as CSV */}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px] gap-1"
            onClick={() => {
              const headers = [
                { key: "id",              label: "id" },
                { key: "title",           label: "title" },
                { key: "event_date",      label: "event_date" },
                { key: "organiser",       label: "organiser" },
                { key: "category",        label: "category" },
                { key: "source",          label: "source" },
                { key: "location",        label: "location" },
                { key: "venue",           label: "venue" },
                { key: "status",          label: "status" },
                { key: "relevance_score", label: "relevance_score" },
                { key: "tags",            label: "tags" },
                { key: "source_url",      label: "source_url" },
              ];
              const stamp = new Date().toISOString().slice(0, 10);
              exportFilteredCsv(`pulse_events_${stamp}.csv`, headers, filtered);
            }}
            disabled={filtered.length === 0}
            title="Download currently filtered events as CSV"
          >
            <Download className="h-3 w-3" />
            Download CSV
          </Button>
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

      {/* #48: active day filter indicator */}
      {calDayFilter && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground bg-muted/30 rounded-md px-2 py-1">
          <Calendar className="h-3 w-3" />
          <span>
            Showing events on{" "}
            <span className="font-medium text-foreground">
              {calDayFilter.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
            </span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 text-[10px] px-1.5 ml-auto"
            onClick={() => setCalDayFilter(null)}
          >
            Clear
          </Button>
        </div>
      )}

      {/* ── Body: list or calendar ── */}
      {viewMode === "calendar" ? (
        <CalendarMonthView
          month={calMonth}
          events={filtered}
          onPrev={() => setCalMonth((m) => addMonths(m, -1))}
          onNext={() => setCalMonth((m) => addMonths(m, +1))}
          onToday={() => setCalMonth(startOfMonth(new Date()))}
          onPickDay={(d) => { setCalDayFilter(d); setViewMode("list"); setEventPage(0); }}
        />
      ) : filtered.length === 0 ? (
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
            {(() => {
              const totalPages = Math.ceil(displayEntries.length / EVENTS_PAGE_SIZE);
              const safePage = Math.min(Math.max(0, eventPage), Math.max(0, totalPages - 1));
              return displayEntries.slice(safePage * EVENTS_PAGE_SIZE, (safePage + 1) * EVENTS_PAGE_SIZE);
            })().map((entry) => {
              if (entry.type === "single") {
                return (
                  <EventCard
                    key={entry.event.id || entry.key}
                    event={entry.event}
                    onUpdateStatus={handleUpdateStatus}
                  />
                );
              }
              // Collapsed or expanded recurring group — #58
              return (
                <RecurringGroupCard
                  key={entry.key}
                  entry={entry}
                  expanded={entry.type === "expanded"}
                  onToggle={() => toggleGroup(entry.key)}
                  onUpdateStatus={handleUpdateStatus}
                />
              );
            })}
          </div>

          {/* ── Pagination ── */}
          {displayEntries.length > EVENTS_PAGE_SIZE && (() => {
            const totalPages = Math.ceil(displayEntries.length / EVENTS_PAGE_SIZE);
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
