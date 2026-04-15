/**
 * Talent Pulse — Talent Acquisition & Monitoring Module
 * Pipeline kanban, directory, evaluations, and analytics dashboard.
 */
import React, { useState, useMemo, useCallback, useRef } from "react";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Briefcase, Search, Plus, X, Star, MapPin, Clock, Phone, Mail, Globe, Instagram,
  Camera, Video, Plane, Image as ImageIcon, Film, LayoutGrid, ChevronDown, ChevronRight,
  MessageSquare, Calendar, Award, TrendingUp, Users, UserPlus, ArrowRight, ExternalLink,
  Activity, AlertTriangle, CheckCircle2, XCircle, Filter
} from "lucide-react";

// ── Constants ───────────────────────────────────────────────────────────────

const SPECIALTIES = [
  { id: "photography", label: "Photography", icon: Camera, color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  { id: "videography", label: "Videography", icon: Video, color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" },
  { id: "drone", label: "Drone", icon: Plane, color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
  { id: "image_editing", label: "Image Editing", icon: ImageIcon, color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  { id: "video_editing", label: "Video Editing", icon: Film, color: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400" },
  { id: "floorplan", label: "Floorplan", icon: LayoutGrid, color: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400" },
];
const SPEC_MAP = Object.fromEntries(SPECIALTIES.map(s => [s.id, s]));

const STAGES = [
  { id: "discovered", label: "Discovered", color: "bg-gray-50 dark:bg-gray-900/20", headerBg: "bg-gray-100 dark:bg-gray-800/40", headerText: "text-gray-700 dark:text-gray-300" },
  { id: "contacted", label: "Contacted", color: "bg-blue-50/70 dark:bg-blue-950/20", headerBg: "bg-blue-100 dark:bg-blue-900/40", headerText: "text-blue-700 dark:text-blue-300" },
  { id: "screening", label: "Screening", color: "bg-amber-50/70 dark:bg-amber-950/20", headerBg: "bg-amber-100 dark:bg-amber-900/40", headerText: "text-amber-700 dark:text-amber-300" },
  { id: "trial", label: "Trial", color: "bg-purple-50/70 dark:bg-purple-950/20", headerBg: "bg-purple-100 dark:bg-purple-900/40", headerText: "text-purple-700 dark:text-purple-300" },
  { id: "offer", label: "Offer", color: "bg-emerald-50/70 dark:bg-emerald-950/20", headerBg: "bg-emerald-100 dark:bg-emerald-900/40", headerText: "text-emerald-700 dark:text-emerald-300" },
  { id: "onboarded", label: "Onboarded", color: "bg-green-50/70 dark:bg-green-950/20", headerBg: "bg-green-100 dark:bg-green-900/40", headerText: "text-green-700 dark:text-green-300" },
  { id: "declined", label: "Declined", color: "bg-red-50/70 dark:bg-red-950/20", headerBg: "bg-red-100 dark:bg-red-900/40", headerText: "text-red-700 dark:text-red-300" },
  { id: "archived", label: "Archived", color: "bg-muted/30", headerBg: "bg-muted/60", headerText: "text-muted-foreground" },
];

const SOURCES = ["referral", "instagram", "seek", "linkedin", "freelancer", "internal", "other"];
const EXP_LEVELS = ["junior", "mid", "senior", "lead"];

function relativeTime(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return `${diff}d ago`;
  if (diff < 30) return `${Math.floor(diff / 7)}w ago`;
  return `${Math.floor(diff / 30)}mo ago`;
}

function StarRating({ value, onChange, size = "sm" }) {
  const s = size === "sm" ? "h-3.5 w-3.5" : "h-5 w-5";
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <button key={i} type="button" onClick={() => onChange?.(i === value ? 0 : i)}
          className={cn("transition-colors", onChange ? "cursor-pointer hover:text-amber-400" : "cursor-default")}>
          <Star className={cn(s, i <= (value || 0) ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30")} />
        </button>
      ))}
    </div>
  );
}

// ── Pipeline Card ────────────────────────────────────────────────────────────

function CandidateCard({ candidate, index, onSelect }) {
  const specs = (candidate.specialties || []).slice(0, 3);
  const followupSoon = candidate.next_followup_date && new Date(candidate.next_followup_date) <= new Date(Date.now() + 7 * 86400000);

  return (
    <Draggable draggableId={candidate.id} index={index}>
      {(provided, snapshot) => (
        <div ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}
          className={cn("bg-card rounded-lg border shadow-sm p-2.5 space-y-1.5 cursor-pointer transition-all select-none",
            snapshot.isDragging && "shadow-lg ring-2 ring-primary/30 rotate-1 scale-[1.02]"
          )}
          style={provided.draggableProps.style}
          onClick={() => onSelect(candidate)}
        >
          {/* Row 1: Name + rating */}
          <div className="flex items-center justify-between gap-1">
            <span className="text-[13px] font-medium truncate">{String(candidate.full_name)}</span>
            {candidate.overall_rating > 0 && (
              <div className="flex items-center gap-0.5 shrink-0">
                <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                <span className="text-[10px] font-medium tabular-nums">{Number(candidate.overall_rating).toFixed(1)}</span>
              </div>
            )}
          </div>
          {/* Row 2: Specialty badges */}
          <div className="flex items-center gap-1 flex-wrap">
            {specs.map(s => {
              const spec = SPEC_MAP[s];
              return spec ? (
                <Badge key={s} className={cn("text-[8px] px-1 py-0 border-0", spec.color)}>
                  {spec.label}
                </Badge>
              ) : null;
            })}
          </div>
          {/* Row 3: Location + rate */}
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {candidate.location && <span className="flex items-center gap-0.5 truncate"><MapPin className="h-2.5 w-2.5 shrink-0" />{String(candidate.location).split(",")[0]}</span>}
            {candidate.rate_per_hour > 0 && <span className="shrink-0">${Number(candidate.rate_per_hour)}/hr</span>}
          </div>
          {/* Row 4: Last contact + followup */}
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {candidate.last_contact_date && <span>Last: {relativeTime(candidate.last_contact_date)}</span>}
            {followupSoon && <span className="text-amber-600 flex items-center gap-0.5"><Clock className="h-2.5 w-2.5" />Follow up</span>}
          </div>
        </div>
      )}
    </Draggable>
  );
}

// ── Candidate Detail Panel ──────────────────────────────────────────────────

function CandidateDetailPanel({ candidate, activities, onClose, onUpdate, onAddActivity, user }) {
  const [noteText, setNoteText] = useState("");
  const [activityType, setActivityType] = useState("note");
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({});

  const handleStartEdit = () => {
    setEditForm({ ...candidate });
    setIsEditing(true);
  };

  const handleSaveEdit = async () => {
    try {
      await onUpdate(candidate.id, editForm);
      setIsEditing(false);
      toast.success("Candidate updated");
    } catch { toast.error("Failed to update"); }
  };

  const handleAddNote = async () => {
    if (!noteText.trim()) return;
    await onAddActivity(candidate.id, activityType, noteText.trim());
    setNoteText("");
    toast.success("Activity logged");
  };

  const candidateActivities = (activities || []).filter(a => a.candidate_id === candidate.id);

  return (
    <div className="fixed inset-y-0 right-0 w-[420px] bg-background border-l shadow-2xl z-50 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b bg-muted/30">
        <div className="min-w-0">
          <h3 className="font-semibold text-lg truncate">{String(candidate.full_name)}</h3>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="outline" className="text-[10px]">{STAGES.find(s => s.id === candidate.stage)?.label || candidate.stage}</Badge>
            <Badge variant="outline" className="text-[10px]">{candidate.experience_level || "mid"}</Badge>
            {candidate.availability && <Badge variant="outline" className="text-[10px]">{String(candidate.availability).replace("_", " ")}</Badge>}
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {!isEditing ? (
          <>
            {/* Contact info */}
            <div className="space-y-2">
              {candidate.email && <div className="flex items-center gap-2 text-sm"><Mail className="h-3.5 w-3.5 text-muted-foreground" /><a href={`mailto:${candidate.email}`} className="text-primary hover:underline">{candidate.email}</a></div>}
              {candidate.phone && <div className="flex items-center gap-2 text-sm"><Phone className="h-3.5 w-3.5 text-muted-foreground" /><a href={`tel:${candidate.phone}`} className="text-primary hover:underline">{candidate.phone}</a></div>}
              {candidate.location && <div className="flex items-center gap-2 text-sm"><MapPin className="h-3.5 w-3.5 text-muted-foreground" />{candidate.location}</div>}
            </div>

            {/* Portfolio links */}
            <div className="space-y-1.5">
              {candidate.portfolio_url && <a href={candidate.portfolio_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm text-primary hover:underline"><Globe className="h-3.5 w-3.5" />Portfolio</a>}
              {candidate.instagram_handle && <a href={`https://instagram.com/${candidate.instagram_handle.replace("@","")}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm text-primary hover:underline"><Instagram className="h-3.5 w-3.5" />@{candidate.instagram_handle.replace("@","")}</a>}
              {candidate.website_url && <a href={candidate.website_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" />Website</a>}
            </div>

            {/* Specialties */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Specialties</p>
              <div className="flex flex-wrap gap-1">
                {(candidate.specialties || []).map(s => {
                  const spec = SPEC_MAP[s];
                  return spec ? <Badge key={s} className={cn("text-[10px] px-2 py-0.5 border-0", spec.color)}>{spec.label}</Badge> : null;
                })}
                {(!candidate.specialties || candidate.specialties.length === 0) && <span className="text-xs text-muted-foreground/50">None set</span>}
              </div>
            </div>

            {/* Rates */}
            <div className="flex gap-4">
              {candidate.rate_per_hour > 0 && <div><p className="text-[10px] text-muted-foreground">Hourly Rate</p><p className="text-sm font-semibold">${Number(candidate.rate_per_hour)}/hr</p></div>}
              {candidate.rate_per_project > 0 && <div><p className="text-[10px] text-muted-foreground">Project Rate</p><p className="text-sm font-semibold">${Number(candidate.rate_per_project)}</p></div>}
            </div>

            {/* Ratings */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Ratings</p>
              {[
                ["Overall", "overall_rating"],
                ["Trial Shoot", "trial_shoot_rating"],
                ["Communication", "communication_rating"],
                ["Quality", "quality_rating"],
                ["Reliability", "reliability_rating"],
              ].map(([label, field]) => (
                <div key={field} className="flex items-center justify-between">
                  <span className="text-xs">{label}</span>
                  <StarRating value={candidate[field] || 0} onChange={async (v) => {
                    await onUpdate(candidate.id, { [field]: v });
                  }} />
                </div>
              ))}
            </div>

            {/* Notes */}
            {candidate.notes && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Notes</p>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{candidate.notes}</p>
              </div>
            )}

            <Button variant="outline" size="sm" className="w-full" onClick={handleStartEdit}>Edit Candidate</Button>
          </>
        ) : (
          /* Edit form */
          <div className="space-y-3">
            <Input placeholder="Full name" value={editForm.full_name || ""} onChange={e => setEditForm(p => ({ ...p, full_name: e.target.value }))} />
            <Input placeholder="Email" value={editForm.email || ""} onChange={e => setEditForm(p => ({ ...p, email: e.target.value }))} />
            <Input placeholder="Phone" value={editForm.phone || ""} onChange={e => setEditForm(p => ({ ...p, phone: e.target.value }))} />
            <Input placeholder="Location" value={editForm.location || ""} onChange={e => setEditForm(p => ({ ...p, location: e.target.value }))} />
            <Input placeholder="Portfolio URL" value={editForm.portfolio_url || ""} onChange={e => setEditForm(p => ({ ...p, portfolio_url: e.target.value }))} />
            <Input placeholder="Instagram @handle" value={editForm.instagram_handle || ""} onChange={e => setEditForm(p => ({ ...p, instagram_handle: e.target.value }))} />
            <Input type="number" placeholder="Hourly rate" value={editForm.rate_per_hour || ""} onChange={e => setEditForm(p => ({ ...p, rate_per_hour: e.target.value }))} />
            <select className="h-9 w-full px-3 text-sm border rounded-md bg-background" value={editForm.experience_level || "mid"} onChange={e => setEditForm(p => ({ ...p, experience_level: e.target.value }))}>
              {EXP_LEVELS.map(l => <option key={l} value={l}>{l.charAt(0).toUpperCase() + l.slice(1)}</option>)}
            </select>
            <select className="h-9 w-full px-3 text-sm border rounded-md bg-background" value={editForm.availability || "available"} onChange={e => setEditForm(p => ({ ...p, availability: e.target.value }))}>
              <option value="available">Available</option>
              <option value="part_time">Part Time</option>
              <option value="unavailable">Unavailable</option>
              <option value="on_contract">On Contract</option>
            </select>
            <Textarea placeholder="Notes" value={editForm.notes || ""} onChange={e => setEditForm(p => ({ ...p, notes: e.target.value }))} rows={3} />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSaveEdit} className="flex-1">Save</Button>
              <Button size="sm" variant="outline" onClick={() => setIsEditing(false)} className="flex-1">Cancel</Button>
            </div>
          </div>
        )}

        {/* Activity log */}
        <div className="border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">Activity ({candidateActivities.length})</p>
          <div className="flex gap-1.5 mb-2">
            <select className="h-8 px-2 text-xs border rounded-md bg-background flex-shrink-0" value={activityType} onChange={e => setActivityType(e.target.value)}>
              <option value="note">Note</option>
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="meeting">Meeting</option>
              <option value="trial_scheduled">Trial Scheduled</option>
              <option value="trial_completed">Trial Completed</option>
              <option value="offer_sent">Offer Sent</option>
            </select>
            <Input placeholder="Add note..." value={noteText} onChange={e => setNoteText(e.target.value)} className="h-8 text-xs" onKeyDown={e => e.key === "Enter" && handleAddNote()} />
            <Button size="sm" className="h-8 px-2 shrink-0" onClick={handleAddNote} disabled={!noteText.trim()}><Plus className="h-3 w-3" /></Button>
          </div>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {candidateActivities.length === 0 && <p className="text-xs text-muted-foreground/50 text-center py-4">No activity yet</p>}
            {candidateActivities.map(a => (
              <div key={a.id} className="flex gap-2 text-xs border-b pb-2 last:border-0">
                <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[9px] px-1 py-0">{a.activity_type}</Badge>
                    <span className="text-muted-foreground/60">{relativeTime(a.created_at)}</span>
                    {a.user_name && <span className="text-muted-foreground/60">— {a.user_name}</span>}
                  </div>
                  <p className="mt-0.5 text-muted-foreground">{a.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function TalentPulse() {
  const { data: candidates = [], loading } = useEntityList("TalentCandidate", "-created_at", 500);
  const { data: activities = [] } = useEntityList("TalentActivity", "-created_at", 2000);
  const { data: user } = useCurrentUser();

  const [tab, setTab] = useState("pipeline");
  const [search, setSearch] = useState("");
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [stageFilter, setStageFilter] = useState("all");
  const [specFilter, setSpecFilter] = useState("all");

  // ── CRUD helpers ────────────────────────────────────────────────────────

  const updateCandidate = useCallback(async (id, data) => {
    await api.entities.TalentCandidate.update(id, { ...data, updated_at: new Date().toISOString() });
    refetchEntityList("TalentCandidate");
    // Update selected if open
    if (selectedCandidate?.id === id) {
      setSelectedCandidate(prev => prev ? { ...prev, ...data } : null);
    }
  }, [selectedCandidate]);

  const addActivity = useCallback(async (candidateId, type, description) => {
    await api.entities.TalentActivity.create({
      candidate_id: candidateId,
      activity_type: type,
      description,
      user_id: user?.id,
      user_name: user?.full_name || user?.email,
    });
    refetchEntityList("TalentActivity");
    // Update last_contact_date
    if (["call", "email", "meeting"].includes(type)) {
      await api.entities.TalentCandidate.update(candidateId, { last_contact_date: new Date().toISOString() });
      refetchEntityList("TalentCandidate");
    }
  }, [user]);

  const createCandidate = useCallback(async (data) => {
    await api.entities.TalentCandidate.create(data);
    refetchEntityList("TalentCandidate");
    toast.success("Candidate added to pipeline");
    setShowAddDialog(false);
  }, []);

  // ── DnD ─────────────────────────────────────────────────────────────────

  const onDragEnd = useCallback(async (result) => {
    if (!result.destination) return;
    const newStage = result.destination.droppableId;
    const candidateId = result.draggableId;
    const candidate = candidates.find(c => c.id === candidateId);
    if (!candidate || candidate.stage === newStage) return;

    try {
      await updateCandidate(candidateId, { stage: newStage });
      await addActivity(candidateId, "status_change", `Stage changed from ${candidate.stage} to ${newStage}`);
      toast.success(`${candidate.full_name} → ${STAGES.find(s => s.id === newStage)?.label}`);
    } catch { toast.error("Failed to update stage"); }
  }, [candidates, updateCandidate, addActivity]);

  // ── Filtering ───────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return candidates.filter(c => {
      if (stageFilter !== "all" && c.stage !== stageFilter) return false;
      if (specFilter !== "all" && !(c.specialties || []).includes(specFilter)) return false;
      if (search) {
        const q = search.toLowerCase();
        return (c.full_name || "").toLowerCase().includes(q) ||
               (c.email || "").toLowerCase().includes(q) ||
               (c.location || "").toLowerCase().includes(q);
      }
      return true;
    });
  }, [candidates, stageFilter, specFilter, search]);

  // ── Stats ───────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const today = new Date().toLocaleDateString("en-CA");
    const monthStart = today.slice(0, 7);
    const total = candidates.length;
    const inPipeline = candidates.filter(c => !["onboarded", "declined", "archived"].includes(c.stage)).length;
    const trialThisMonth = candidates.filter(c => c.stage === "trial" && (c.updated_at || "").slice(0, 7) === monthStart).length;
    const onboarded = candidates.filter(c => c.stage === "onboarded").length;
    const rated = candidates.filter(c => c.overall_rating > 0);
    const avgRating = rated.length > 0 ? (rated.reduce((s, c) => s + Number(c.overall_rating), 0) / rated.length).toFixed(1) : "—";
    const followups = candidates.filter(c => c.next_followup_date && new Date(c.next_followup_date) <= new Date(Date.now() + 7 * 86400000)).length;
    return { total, inPipeline, trialThisMonth, onboarded, avgRating, followups };
  }, [candidates]);

  // By stage for kanban
  const byStage = useMemo(() => {
    const map = {};
    STAGES.forEach(s => { map[s.id] = []; });
    filtered.forEach(c => { (map[c.stage] || map.discovered).push(c); });
    return map;
  }, [filtered]);

  // ── Loading ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="px-4 pt-3 pb-4 lg:px-6 space-y-4">
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
        <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-16 bg-muted rounded-xl animate-pulse" />)}
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="flex-1 h-[400px] bg-muted rounded-lg animate-pulse" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pt-3 pb-4 lg:px-6 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Briefcase className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Talent Pulse</h1>
          <Badge variant="secondary" className="text-xs">{String(candidates.length)} candidates</Badge>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input className="pl-7 h-8 w-48 text-sm" placeholder="Search talent..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className="h-8 px-2 text-xs border rounded-md bg-background" value={specFilter} onChange={e => setSpecFilter(e.target.value)}>
            <option value="all">All Specialties</option>
            {SPECIALTIES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <Button size="sm" onClick={() => setShowAddDialog(true)}>
            <UserPlus className="h-3.5 w-3.5 mr-1.5" />
            Add Candidate
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
        <StatCard label="Total" value={String(stats.total)} icon={Users} />
        <StatCard label="In Pipeline" value={String(stats.inPipeline)} icon={Briefcase} color="text-blue-600" />
        <StatCard label="Trial (Month)" value={String(stats.trialThisMonth)} icon={Award} color="text-purple-600" />
        <StatCard label="Onboarded" value={String(stats.onboarded)} icon={CheckCircle2} color="text-green-600" />
        <StatCard label="Avg Rating" value={String(stats.avgRating)} icon={Star} color="text-amber-500" />
        <StatCard label="Followups" value={String(stats.followups)} icon={Clock} color={stats.followups > 0 ? "text-red-600" : undefined} />
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-muted/40">
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          <TabsTrigger value="directory">Directory</TabsTrigger>
          <TabsTrigger value="evaluations">Evaluations</TabsTrigger>
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
        </TabsList>

        {/* ═══ PIPELINE TAB ═══ */}
        <TabsContent value="pipeline" className="mt-3">
          <ErrorBoundary fallbackLabel="Pipeline">
            <DragDropContext onDragEnd={onDragEnd}>
              <div className="flex gap-2 overflow-x-auto pb-2">
                {STAGES.map(stage => (
                  <div key={stage.id} className="flex-shrink-0 w-56">
                    <div className={cn("px-3 py-1.5 rounded-t-lg flex items-center justify-between", stage.headerBg)}>
                      <span className={cn("text-xs font-semibold", stage.headerText)}>{stage.label}</span>
                      <span className={cn("text-xs font-bold tabular-nums", stage.headerText)}>{(byStage[stage.id] || []).length}</span>
                    </div>
                    <Droppable droppableId={stage.id}>
                      {(provided, snapshot) => (
                        <div ref={provided.innerRef} {...provided.droppableProps}
                          className={cn("min-h-[150px] max-h-[calc(100vh-380px)] overflow-y-auto p-1.5 space-y-1.5 rounded-b-lg border-x border-b transition-colors",
                            snapshot.isDraggingOver ? "bg-primary/10 ring-2 ring-primary/20" : stage.color
                          )}>
                          {(byStage[stage.id] || []).map((c, i) => (
                            <CandidateCard key={c.id} candidate={c} index={i} onSelect={setSelectedCandidate} />
                          ))}
                          {provided.placeholder}
                          {(byStage[stage.id] || []).length === 0 && !snapshot.isDraggingOver && (
                            <div className="text-center text-[11px] text-muted-foreground/40 py-10">No candidates</div>
                          )}
                        </div>
                      )}
                    </Droppable>
                  </div>
                ))}
              </div>
            </DragDropContext>
          </ErrorBoundary>
        </TabsContent>

        {/* ═══ DIRECTORY TAB ═══ */}
        <TabsContent value="directory" className="mt-3">
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground">Name</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground">Specialties</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground hidden md:table-cell">Location</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground">Stage</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground hidden lg:table-cell">Rate</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground hidden lg:table-cell">Rating</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground hidden md:table-cell">Last Contact</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.id} className="hover:bg-muted/30 cursor-pointer border-t" onClick={() => setSelectedCandidate(c)}>
                    <td className="px-3 py-2">
                      <div><span className="font-medium">{String(c.full_name)}</span></div>
                      {c.email && <div className="text-[10px] text-muted-foreground">{c.email}</div>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1 flex-wrap">
                        {(c.specialties || []).slice(0, 3).map(s => {
                          const spec = SPEC_MAP[s];
                          return spec ? <Badge key={s} className={cn("text-[8px] px-1 py-0 border-0", spec.color)}>{spec.label}</Badge> : null;
                        })}
                      </div>
                    </td>
                    <td className="px-3 py-2 hidden md:table-cell text-xs text-muted-foreground">{(c.location || "—").split(",")[0]}</td>
                    <td className="px-3 py-2"><Badge variant="outline" className="text-[10px]">{STAGES.find(s => s.id === c.stage)?.label || c.stage}</Badge></td>
                    <td className="px-3 py-2 hidden lg:table-cell text-xs">{c.rate_per_hour > 0 ? `$${Number(c.rate_per_hour)}/hr` : "—"}</td>
                    <td className="px-3 py-2 hidden lg:table-cell">{c.overall_rating > 0 ? <StarRating value={c.overall_rating} size="sm" /> : <span className="text-xs text-muted-foreground/30">—</span>}</td>
                    <td className="px-3 py-2 hidden md:table-cell text-xs text-muted-foreground">{relativeTime(c.last_contact_date) || "—"}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="py-12 text-center text-muted-foreground/50">
                    <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    {search ? "No candidates match your search" : "No candidates yet — add your first one!"}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* ═══ EVALUATIONS TAB ═══ */}
        <TabsContent value="evaluations" className="mt-3">
          {(() => {
            const evaluated = candidates.filter(c => c.overall_rating > 0 || c.trial_shoot_rating > 0);
            if (evaluated.length === 0) return (
              <Card className="border-dashed border-2"><CardContent className="py-16 text-center">
                <Award className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">No evaluated candidates yet. Rate candidates in the pipeline to see them here.</p>
              </CardContent></Card>
            );
            return (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {evaluated.sort((a, b) => (b.overall_rating || 0) - (a.overall_rating || 0)).map(c => (
                  <Card key={c.id} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setSelectedCandidate(c)}>
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="font-semibold">{String(c.full_name)}</h3>
                        <Badge variant="outline" className="text-[10px]">{STAGES.find(s => s.id === c.stage)?.label}</Badge>
                      </div>
                      <div className="flex gap-1 flex-wrap">
                        {(c.specialties || []).map(s => SPEC_MAP[s] ? <Badge key={s} className={cn("text-[9px] px-1.5 py-0 border-0", SPEC_MAP[s].color)}>{SPEC_MAP[s].label}</Badge> : null)}
                      </div>
                      <div className="space-y-1.5">
                        {[["Overall", c.overall_rating], ["Trial", c.trial_shoot_rating], ["Quality", c.quality_rating], ["Communication", c.communication_rating], ["Reliability", c.reliability_rating]].map(([label, val]) => (
                          val > 0 && <div key={label} className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">{label}</span>
                            <StarRating value={val} size="sm" />
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            );
          })()}
        </TabsContent>

        {/* ═══ DASHBOARD TAB ═══ */}
        <TabsContent value="dashboard" className="mt-3">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Pipeline Funnel */}
            <Card>
              <CardContent className="p-4">
                <h3 className="font-semibold text-sm mb-3 flex items-center gap-2"><TrendingUp className="h-4 w-4" />Pipeline Funnel</h3>
                <div className="space-y-2">
                  {STAGES.filter(s => !["declined", "archived"].includes(s.id)).map(stage => {
                    const count = candidates.filter(c => c.stage === stage.id).length;
                    const pct = candidates.length > 0 ? Math.round((count / candidates.length) * 100) : 0;
                    return (
                      <div key={stage.id} className="flex items-center gap-2">
                        <span className="text-xs w-20 text-right text-muted-foreground">{stage.label}</span>
                        <div className="flex-1 h-5 bg-muted rounded-full overflow-hidden">
                          <div className={cn("h-full rounded-full transition-all", stage.headerBg)} style={{ width: `${Math.max(pct, 2)}%` }} />
                        </div>
                        <span className="text-xs w-8 text-right tabular-nums font-medium">{count}</span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* By Specialty */}
            <Card>
              <CardContent className="p-4">
                <h3 className="font-semibold text-sm mb-3 flex items-center gap-2"><Award className="h-4 w-4" />By Specialty</h3>
                <div className="space-y-2">
                  {SPECIALTIES.map(spec => {
                    const count = candidates.filter(c => (c.specialties || []).includes(spec.id)).length;
                    return (
                      <div key={spec.id} className="flex items-center gap-2">
                        <Badge className={cn("text-[10px] px-2 py-0.5 border-0 w-28 justify-center", spec.color)}>{spec.label}</Badge>
                        <div className="flex-1 h-4 bg-muted rounded-full overflow-hidden">
                          <div className={cn("h-full rounded-full", spec.color.split(" ")[0])} style={{ width: `${candidates.length > 0 ? Math.max(Math.round((count / candidates.length) * 100), 3) : 0}%` }} />
                        </div>
                        <span className="text-xs w-6 text-right tabular-nums">{count}</span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* Upcoming Followups */}
            <Card>
              <CardContent className="p-4">
                <h3 className="font-semibold text-sm mb-3 flex items-center gap-2"><Clock className="h-4 w-4" />Upcoming Followups</h3>
                {(() => {
                  const upcoming = candidates.filter(c => c.next_followup_date && new Date(c.next_followup_date) <= new Date(Date.now() + 7 * 86400000))
                    .sort((a, b) => new Date(a.next_followup_date) - new Date(b.next_followup_date));
                  if (upcoming.length === 0) return <p className="text-xs text-muted-foreground/50 text-center py-6">No upcoming followups</p>;
                  return (
                    <div className="space-y-2">
                      {upcoming.slice(0, 8).map(c => (
                        <div key={c.id} className="flex items-center justify-between cursor-pointer hover:bg-muted/30 rounded p-1.5 -mx-1.5" onClick={() => setSelectedCandidate(c)}>
                          <div>
                            <p className="text-sm font-medium">{c.full_name}</p>
                            <p className="text-[10px] text-muted-foreground">{STAGES.find(s => s.id === c.stage)?.label}</p>
                          </div>
                          <Badge variant="outline" className={cn("text-[10px]", new Date(c.next_followup_date) < new Date() ? "border-red-300 text-red-600" : "")}>
                            {new Date(c.next_followup_date).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </CardContent>
            </Card>

            {/* Recent Activity */}
            <Card>
              <CardContent className="p-4">
                <h3 className="font-semibold text-sm mb-3 flex items-center gap-2"><Activity className="h-4 w-4" />Recent Activity</h3>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {activities.slice(0, 15).map(a => {
                    const c = candidates.find(c => c.id === a.candidate_id);
                    return (
                      <div key={a.id} className="flex gap-2 text-xs border-b pb-2 last:border-0">
                        <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                        <div>
                          <span className="font-medium">{c?.full_name || "Unknown"}</span>
                          <span className="text-muted-foreground"> — {a.description || a.activity_type}</span>
                          <span className="text-muted-foreground/60 ml-1">{relativeTime(a.created_at)}</span>
                        </div>
                      </div>
                    );
                  })}
                  {activities.length === 0 && <p className="text-xs text-muted-foreground/50 text-center py-6">No activity yet</p>}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {/* ═══ CANDIDATE DETAIL PANEL ═══ */}
      {selectedCandidate && (
        <CandidateDetailPanel
          candidate={selectedCandidate}
          activities={activities}
          onClose={() => setSelectedCandidate(null)}
          onUpdate={updateCandidate}
          onAddActivity={addActivity}
          user={user}
        />
      )}

      {/* ═══ ADD CANDIDATE DIALOG ═══ */}
      <AddCandidateDialog open={showAddDialog} onClose={() => setShowAddDialog(false)} onCreate={createCandidate} />
    </div>
  );
}

// ── Add Candidate Dialog ────────────────────────────────────────────────────

function AddCandidateDialog({ open, onClose, onCreate }) {
  const [form, setForm] = useState({ full_name: "", email: "", phone: "", location: "", specialties: [], experience_level: "mid", source: "referral", rate_per_hour: "", portfolio_url: "", instagram_handle: "", notes: "" });
  const [saving, setSaving] = useState(false);

  const toggleSpec = (id) => {
    setForm(prev => ({
      ...prev,
      specialties: prev.specialties.includes(id) ? prev.specialties.filter(s => s !== id) : [...prev.specialties, id]
    }));
  };

  const handleCreate = async () => {
    if (!form.full_name.trim()) { toast.error("Name is required"); return; }
    setSaving(true);
    try {
      await onCreate({
        ...form,
        rate_per_hour: form.rate_per_hour ? parseFloat(form.rate_per_hour) : null,
        specialties: form.specialties,
      });
      setForm({ full_name: "", email: "", phone: "", location: "", specialties: [], experience_level: "mid", source: "referral", rate_per_hour: "", portfolio_url: "", instagram_handle: "", notes: "" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Add Talent Candidate</DialogTitle></DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-2">
          <Input placeholder="Full name *" value={form.full_name} onChange={e => setForm(p => ({ ...p, full_name: e.target.value }))} />
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="Email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
            <Input placeholder="Phone" value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} />
          </div>
          <Input placeholder="Location (suburb, city)" value={form.location} onChange={e => setForm(p => ({ ...p, location: e.target.value }))} />
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">Specialties</p>
            <div className="flex flex-wrap gap-1.5">
              {SPECIALTIES.map(s => (
                <button key={s.id} type="button" onClick={() => toggleSpec(s.id)}
                  className={cn("inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
                    form.specialties.includes(s.id) ? "bg-primary text-primary-foreground border-primary" : "bg-muted/60 text-muted-foreground border-transparent hover:bg-muted"
                  )}>
                  <s.icon className="h-3 w-3" />{s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select className="h-9 px-3 text-sm border rounded-md bg-background" value={form.experience_level} onChange={e => setForm(p => ({ ...p, experience_level: e.target.value }))}>
              {EXP_LEVELS.map(l => <option key={l} value={l}>{l.charAt(0).toUpperCase() + l.slice(1)}</option>)}
            </select>
            <select className="h-9 px-3 text-sm border rounded-md bg-background" value={form.source} onChange={e => setForm(p => ({ ...p, source: e.target.value }))}>
              {SOURCES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
          </div>
          <Input type="number" placeholder="Hourly rate ($)" value={form.rate_per_hour} onChange={e => setForm(p => ({ ...p, rate_per_hour: e.target.value }))} />
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="Portfolio URL" value={form.portfolio_url} onChange={e => setForm(p => ({ ...p, portfolio_url: e.target.value }))} />
            <Input placeholder="Instagram @handle" value={form.instagram_handle} onChange={e => setForm(p => ({ ...p, instagram_handle: e.target.value }))} />
          </div>
          <Textarea placeholder="Notes" value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={2} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleCreate} disabled={saving || !form.full_name.trim()}>
            {saving ? "Adding..." : "Add to Pipeline"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, color }) {
  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardContent className="p-3 flex items-center gap-3">
        <div className="p-1.5 rounded-lg bg-muted/60">
          <Icon className={cn("h-4 w-4", color || "text-muted-foreground")} />
        </div>
        <div className="min-w-0">
          <p className={cn("text-lg font-bold tabular-nums leading-none", color || "text-foreground")}>{value}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}
