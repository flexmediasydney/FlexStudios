import { useState, useRef, useEffect, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Rss, Calendar, ArrowRight, Trophy, TrendingUp, Star,
  X, Loader2, Search, User, Building2,
} from "lucide-react";

// ── Segmented button configs ─────────────────────────────────────────────────

const LEVELS = [
  { key: "industry",     label: "Industry",     icon: Rss },
  { key: "organisation", label: "Organisation", icon: Building2 },
  { key: "person",       label: "Person",       icon: User },
];

const CATEGORIES = [
  { key: "event",     label: "Event",     icon: Calendar },
  { key: "movement",  label: "Movement",  icon: ArrowRight },
  { key: "milestone", label: "Milestone", icon: Trophy },
  { key: "market",    label: "Market",    icon: TrendingUp },
  { key: "custom",    label: "Custom",    icon: Star },
];

const SOURCE_TYPES = [
  { key: "observed",     label: "Observed" },
  { key: "social_media", label: "Social Media" },
  { key: "news",         label: "News" },
  { key: "manual",       label: "Manual" },
];

export default function PulseSignalQuickAdd({ open, onClose, agents = [], agencies = [] }) {
  const titleRef = useRef(null);

  // ── Form state ─────────────────────────────────────────────────────────────
  const [level, setLevel]                 = useState("industry");
  const [category, setCategory]           = useState("event");
  const [title, setTitle]                 = useState("");
  const [description, setDescription]     = useState("");
  const [eventDate, setEventDate]         = useState("");
  const [isActionable, setIsActionable]   = useState(true);
  const [suggestedAction, setSuggestedAction] = useState("");
  const [sourceType, setSourceType]       = useState("observed");
  const [selectedAgentIds, setSelectedAgentIds]   = useState([]);
  const [selectedAgencyIds, setSelectedAgencyIds] = useState([]);
  const [contactSearch, setContactSearch] = useState("");
  const [saving, setSaving]               = useState(false);

  // ── Reset on open ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (open) {
      setLevel("industry");
      setCategory("event");
      setTitle("");
      setDescription("");
      setEventDate("");
      setIsActionable(true);
      setSuggestedAction("");
      setSourceType("observed");
      setSelectedAgentIds([]);
      setSelectedAgencyIds([]);
      setContactSearch("");
      setSaving(false);
      // Auto-focus title after dialog animation
      setTimeout(() => titleRef.current?.focus(), 100);
    }
  }, [open]);

  // ── Contact search ─────────────────────────────────────────────────────────
  const contactResults = useMemo(() => {
    if (!contactSearch.trim()) return [];
    const term = contactSearch.toLowerCase();
    const matched = [];

    agents.forEach((a) => {
      if (
        (a.name || "").toLowerCase().includes(term) &&
        !selectedAgentIds.includes(a.id)
      ) {
        matched.push({ id: a.id, name: a.name, type: "agent" });
      }
    });
    agencies.forEach((a) => {
      if (
        (a.name || "").toLowerCase().includes(term) &&
        !selectedAgencyIds.includes(a.id)
      ) {
        matched.push({ id: a.id, name: a.name, type: "agency" });
      }
    });

    return matched.slice(0, 8);
  }, [contactSearch, agents, agencies, selectedAgentIds, selectedAgencyIds]);

  // ── Selected contacts display ──────────────────────────────────────────────
  const selectedContacts = useMemo(() => {
    const contacts = [];
    selectedAgentIds.forEach((id) => {
      const a = agents.find((x) => x.id === id);
      if (a) contacts.push({ id, name: a.name, type: "agent" });
    });
    selectedAgencyIds.forEach((id) => {
      const a = agencies.find((x) => x.id === id);
      if (a) contacts.push({ id, name: a.name, type: "agency" });
    });
    return contacts;
  }, [selectedAgentIds, selectedAgencyIds, agents, agencies]);

  // ── Add / remove contact ───────────────────────────────────────────────────
  const addContact = (contact) => {
    if (contact.type === "agent") {
      setSelectedAgentIds((prev) => [...prev, contact.id]);
    } else {
      setSelectedAgencyIds((prev) => [...prev, contact.id]);
    }
    setContactSearch("");
  };

  const removeContact = (contact) => {
    if (contact.type === "agent") {
      setSelectedAgentIds((prev) => prev.filter((id) => id !== contact.id));
    } else {
      setSelectedAgencyIds((prev) => prev.filter((id) => id !== contact.id));
    }
  };

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!title.trim()) {
      toast.error("Title is required");
      titleRef.current?.focus();
      return;
    }

    setSaving(true);
    try {
      const user = await api.auth.me();
      await api.entities.PulseSignal.create({
        level,
        category,
        title: title.trim(),
        description: description.trim() || null,
        event_date: eventDate || null,
        is_actionable: isActionable,
        suggested_action: suggestedAction.trim() || null,
        linked_agent_ids: selectedAgentIds,
        linked_agency_ids: selectedAgencyIds,
        source_type: sourceType,
        status: "new",
        created_by: user?.id,
        created_by_name: user?.full_name || user?.email,
      });
      refetchEntityList("PulseSignal");
      toast.success("Signal captured");
      onClose();
    } catch (err) {
      console.error("Failed to create signal:", err);
      toast.error("Failed to capture signal");
    } finally {
      setSaving(false);
    }
  };

  // ── Keyboard shortcut: Cmd/Ctrl+Enter to save ─────────────────────────────
  const handleKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="sm:max-w-lg max-h-[90vh] overflow-y-auto"
        onKeyDown={handleKeyDown}
        aria-describedby="pulse-quick-add-desc"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rss className="h-4 w-4 text-primary" />
            Capture Signal
          </DialogTitle>
          <p id="pulse-quick-add-desc" className="text-xs text-muted-foreground">
            Quickly log an industry event, movement, or observation.
          </p>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Level segmented control */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Level</Label>
            <div className="flex gap-1 bg-muted/50 p-1 rounded-lg">
              {LEVELS.map(({ key, label, icon: Icon }) => (
                <Button
                  key={key}
                  type="button"
                  variant={level === key ? "default" : "ghost"}
                  size="sm"
                  className="flex-1 gap-1 h-7 text-xs"
                  onClick={() => setLevel(key)}
                >
                  <Icon className="h-3 w-3" />
                  {label}
                </Button>
              ))}
            </div>
          </div>

          {/* Category segmented control */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Category</Label>
            <div className="flex gap-1 bg-muted/50 p-1 rounded-lg">
              {CATEGORIES.map(({ key, label, icon: Icon }) => (
                <Button
                  key={key}
                  type="button"
                  variant={category === key ? "default" : "ghost"}
                  size="sm"
                  className="flex-1 gap-1 h-7 text-[11px]"
                  onClick={() => setCategory(key)}
                >
                  <Icon className="h-3 w-3" />
                  {label}
                </Button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="signal-title" className="text-xs font-medium">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              ref={titleRef}
              id="signal-title"
              placeholder="e.g. Ray White poker night next Thursday"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="signal-desc" className="text-xs font-medium">Description</Label>
            <Textarea
              id="signal-desc"
              placeholder="e.g. Annual awards dinner at Doltone House, 200+ agents expected"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="text-sm resize-none"
            />
          </div>

          {/* Event date + Source type (side by side) */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="signal-date" className="text-xs font-medium">Event Date</Label>
              <Input
                id="signal-date"
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="signal-source" className="text-xs font-medium">Source</Label>
              <select
                id="signal-source"
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value)}
                className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {SOURCE_TYPES.map(({ key, label }) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Actionable toggle + suggested action */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="signal-actionable" className="text-xs font-medium">Actionable</Label>
              <Switch
                id="signal-actionable"
                checked={isActionable}
                onCheckedChange={setIsActionable}
              />
            </div>
            {isActionable && (
              <Input
                placeholder="e.g. Attend and bring business cards"
                value={suggestedAction}
                onChange={(e) => setSuggestedAction(e.target.value)}
                className="h-8 text-sm"
              />
            )}
          </div>

          {/* Linked contacts */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Linked Contacts</Label>

            {/* Selected chips */}
            {selectedContacts.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {selectedContacts.map((c) => (
                  <Badge
                    key={c.id}
                    variant="secondary"
                    className="gap-1 text-xs pl-1.5 pr-1 py-0.5 cursor-pointer hover:bg-destructive/10"
                    onClick={() => removeContact(c)}
                  >
                    {c.type === "agent" ? (
                      <User className="h-2.5 w-2.5" />
                    ) : (
                      <Building2 className="h-2.5 w-2.5" />
                    )}
                    {c.name}
                    <X className="h-2.5 w-2.5 ml-0.5" />
                  </Badge>
                ))}
              </div>
            )}

            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search agents or agencies..."
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>

            {/* Search results dropdown */}
            {contactResults.length > 0 && (
              <div className="border rounded-md bg-popover shadow-md max-h-32 overflow-y-auto">
                {contactResults.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-left transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                    onClick={() => addContact(c)}
                  >
                    {c.type === "agent" ? (
                      <User className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    ) : (
                      <Building2 className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    )}
                    <span className="truncate">{c.name}</span>
                    <Badge variant="outline" className="text-[9px] px-1 py-0 ml-auto whitespace-nowrap">
                      {c.type === "agent" ? "Person" : "Org"}
                    </Badge>
                  </button>
                ))}
              </div>
            )}

            {contactSearch.trim() && contactResults.length === 0 && (
              <p className="text-[11px] text-muted-foreground/70 px-1">No contacts match that search -- try a different name</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <div className="flex items-center justify-between w-full">
            <span className="text-[10px] text-muted-foreground/70 hidden sm:inline">
              {navigator.platform?.includes("Mac") ? "\u2318" : "Ctrl"}+Enter to save
            </span>
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving || !title.trim()} className="gap-1.5">
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                Capture Signal
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
