import { useState, useEffect, useRef, useMemo } from "react";
import { useEntityList, refetchEntityList, updateEntityInCache } from "@/components/hooks/useEntityData";
import { api } from "@/api/supabaseClient";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, Search, Calendar, Clock,
  Phone, PhoneIncoming, PhoneOutgoing, Voicemail, Mail, MessageCircle,
  MessageSquare, Image, Video, Footprints, Home, FileText, Gift,
  Facebook, Instagram, Linkedin, Briefcase, Presentation, MapPin, PhoneCall,
} from "lucide-react";

// ─── Icon map: lucide icon names from TouchpointType.icon_name → components ──

const ICON_MAP = {
  PhoneOutgoing, PhoneIncoming, Voicemail,
  Mail, MessageCircle, MessageSquare,
  Image, Video, Footprints, Home,
  FileText, Gift, Facebook, Instagram,
  Linkedin, Briefcase, Presentation,
  MapPin, PhoneCall, Phone,
};

// ─── Category colours for type picker buttons ────────────────────────────────

const CATEGORY_COLORS = {
  outbound:  { bg: "bg-blue-50",    ring: "ring-blue-400",   text: "text-blue-600",   dot: "bg-blue-500" },
  inbound:   { bg: "bg-green-50",   ring: "ring-green-400",  text: "text-green-600",  dot: "bg-green-500" },
  meeting:   { bg: "bg-purple-50",  ring: "ring-purple-400", text: "text-purple-600", dot: "bg-purple-500" },
  content:   { bg: "bg-amber-50",   ring: "ring-amber-400",  text: "text-amber-600",  dot: "bg-amber-500" },
  event:     { bg: "bg-rose-50",    ring: "ring-rose-400",   text: "text-rose-600",   dot: "bg-rose-500" },
  trigger:   { bg: "bg-cyan-50",    ring: "ring-cyan-400",   text: "text-cyan-600",   dot: "bg-cyan-500" },
  gift:      { bg: "bg-pink-50",    ring: "ring-pink-400",   text: "text-pink-600",   dot: "bg-pink-500" },
};

const DEFAULT_COLOR = { bg: "bg-muted", ring: "ring-primary", text: "text-foreground", dot: "bg-muted-foreground" };

function getCategoryColor(category) {
  return CATEGORY_COLORS[(category || "").toLowerCase()] || DEFAULT_COLOR;
}

// ─── Outcome + Sentiment options ─────────────────────────────────────────────

const OUTCOMES = [
  { value: "positive",    label: "Positive",    color: "bg-emerald-500" },
  { value: "neutral",     label: "Neutral",     color: "bg-slate-400" },
  { value: "negative",    label: "Negative",    color: "bg-red-500" },
  { value: "no_response", label: "No Response", color: "bg-gray-300" },
];

const SENTIMENTS = [
  { value: "positive", label: "Positive", emoji: "\u{1F60A}" },
  { value: "neutral",  label: "Neutral",  emoji: "\u{1F610}" },
  { value: "negative", label: "Negative", emoji: "\u{1F61E}" },
];

const DELIVERY_METHODS = ["Hand delivered", "Mailed", "Left at office"];

// ─── Component ───────────────────────────────────────────────────────────────

export default function QuickLogTouchpoint({
  open,
  onClose,
  preselectedAgentId,
  preselectedAgencyId,
  preselectedPulseSignalId,
  preselectedNotes,
}) {
  // ── Data loading ──
  const { data: touchpointTypes = [] } = useEntityList("TouchpointType", "sort_order");
  const { data: agents = [] }          = useEntityList("Agent", "name");
  const { data: agencies = [] }        = useEntityList("Agency", "name");
  const { data: user }                 = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });

  // ── Form state ──
  const [selectedTypeId, setSelectedTypeId]     = useState(null);
  const [selectedAgentId, setSelectedAgentId]   = useState("");
  const [selectedAgencyId, setSelectedAgencyId] = useState("");
  const [notes, setNotes]                       = useState("");
  const [outcome, setOutcome]                   = useState("");
  const [sentiment, setSentiment]               = useState("");
  const [followUp, setFollowUp]                 = useState(false);
  const [followUpDate, setFollowUpDate]         = useState("");
  const [followUpNotes, setFollowUpNotes]       = useState("");
  const [duration, setDuration]                 = useState("");
  const [giftItem, setGiftItem]                 = useState("");
  const [cost, setCost]                         = useState("");
  const [giftDelivery, setGiftDelivery]         = useState("");
  const [saving, setSaving]                     = useState(false);
  const [contactOpen, setContactOpen]           = useState(false);
  const [contactSearch, setContactSearch]       = useState("");

  const notesRef = useRef(null);

  // ── Reset form when dialog opens ──
  useEffect(() => {
    if (open) {
      setSelectedTypeId(null);
      setSelectedAgentId(preselectedAgentId || "");
      setSelectedAgencyId(preselectedAgencyId || "");
      setNotes(preselectedNotes || "");
      setOutcome("");
      setSentiment("");
      setFollowUp(false);
      setFollowUpDate("");
      setFollowUpNotes("");
      setDuration("");
      setGiftItem("");
      setCost("");
      setGiftDelivery("");
      setSaving(false);
      setContactSearch("");
    }
  }, [open, preselectedAgentId, preselectedAgencyId, preselectedNotes]);

  // ── Derived data ──
  const activeTypes = useMemo(
    () => touchpointTypes.filter(t => t.is_active !== false),
    [touchpointTypes]
  );

  const selectedType = useMemo(
    () => touchpointTypes.find(t => t.id === selectedTypeId) || null,
    [touchpointTypes, selectedTypeId]
  );

  const isGiftCategory = (selectedType?.category || "").toLowerCase() === "gift";

  // Combined agent+agency list for contact picker
  const contactOptions = useMemo(() => {
    const result = [];
    for (const a of agents) {
      const agency = a.current_agency_id
        ? agencies.find(ag => ag.id === a.current_agency_id)
        : null;
      result.push({
        id: a.id,
        type: "agent",
        name: a.name || "Unnamed",
        subtitle: agency?.name || "",
        agencyId: agency?.id || null,
      });
    }
    return result;
  }, [agents, agencies]);

  const selectedContact = useMemo(
    () => contactOptions.find(c => c.id === selectedAgentId) || null,
    [contactOptions, selectedAgentId]
  );

  // ── Keyboard shortcut: Ctrl+Enter to submit ──
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, selectedTypeId, selectedAgentId]);

  // ── Save ──
  const handleSave = async () => {
    if (!selectedTypeId || !selectedAgentId) {
      toast.error("Select a type and contact");
      return;
    }
    if (saving) return;
    setSaving(true);

    try {
      const type = touchpointTypes.find(t => t.id === selectedTypeId);
      const agent = agents.find(a => a.id === selectedAgentId);
      const agency = agent ? agencies.find(a => a.id === agent.current_agency_id) : null;

      await api.entities.Touchpoint.create({
        agent_id: selectedAgentId,
        agency_id: agency?.id || selectedAgencyId || null,
        touchpoint_type_id: selectedTypeId,
        touchpoint_type_name: type?.name || "",
        direction: type?.category === "inbound" ? "inbound" : "outbound",
        notes: notes || null,
        duration_minutes: duration ? Number(duration) : null,
        outcome: outcome || null,
        sentiment: sentiment || null,
        logged_by: user?.id,
        logged_by_name: user?.full_name || user?.email,
        logged_at: new Date().toISOString(),
        is_planned: false,
        follow_up_date: followUp && followUpDate ? followUpDate : null,
        follow_up_notes: followUp && followUpNotes ? followUpNotes : null,
        linked_pulse_signal_id: preselectedPulseSignalId || null,
        cost: cost ? Number(cost) : null,
        gift_item: giftItem || null,
        gift_delivery_method: giftDelivery || null,
      });

      // Update agent denormalized fields
      const now = new Date().toISOString();
      await api.entities.Agent.update(selectedAgentId, {
        last_touchpoint_at: now,
        last_contacted_at: now,
        touchpoint_count: (agent?.touchpoint_count || 0) + 1,
      });
      updateEntityInCache("Agent", selectedAgentId, {
        last_touchpoint_at: now,
        last_contacted_at: now,
        touchpoint_count: (agent?.touchpoint_count || 0) + 1,
      });

      // If linked to pulse signal, mark it actioned
      if (preselectedPulseSignalId) {
        await api.entities.PulseSignal.update(preselectedPulseSignalId, {
          status: "actioned",
          actioned_at: now,
          actioned_by: user?.id,
          actioned_by_name: user?.full_name || user?.email,
        });
        refetchEntityList("PulseSignal");
      }

      refetchEntityList("Touchpoint");
      refetchEntityList("Agent");
      toast.success(`${type?.name || "Touchpoint"} logged`);
      onClose();
    } catch (err) {
      toast.error(err?.message || "Failed to log touchpoint");
    } finally {
      setSaving(false);
    }
  };

  // ── Type picker: select + auto-focus notes ──
  const handleTypeSelect = (typeId) => {
    setSelectedTypeId(typeId);
    // If contact is already selected, focus notes for speed
    if (selectedAgentId && notesRef.current) {
      setTimeout(() => notesRef.current?.focus(), 50);
    }
  };

  // ── Render ──
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto"
        aria-describedby="quicklog-description"
      >
        <DialogHeader>
          <DialogTitle className="text-base">Log Touchpoint</DialogTitle>
          <p id="quicklog-description" className="text-xs text-muted-foreground">
            {selectedType ? selectedType.name : "Select a type to get started"}
          </p>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* ── 1. Type picker (horizontal scrollable row) ── */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">Type</Label>
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-thin">
              {activeTypes.map((t) => {
                const Icon = ICON_MAP[t.icon_name] || Phone;
                const cat = getCategoryColor(t.category);
                const isSelected = selectedTypeId === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => handleTypeSelect(t.id)}
                    title={t.name}
                    className={cn(
                      "flex flex-col items-center gap-0.5 rounded-lg border px-2.5 py-1.5 text-[10px] leading-tight",
                      "min-w-[56px] transition-all shrink-0 select-none",
                      isSelected
                        ? `${cat.bg} border-transparent ring-2 ${cat.ring} ${cat.text} font-semibold`
                        : "border-border hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="truncate max-w-[52px]">{t.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── 2. Contact picker (Popover + Command) ── */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">Contact</Label>
            <Popover open={contactOpen} onOpenChange={setContactOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={contactOpen}
                  className="w-full justify-between h-9 text-sm font-normal"
                >
                  {selectedContact ? (
                    <span className="truncate">
                      {selectedContact.name}
                      {selectedContact.subtitle && (
                        <span className="text-muted-foreground ml-1">
                          ({selectedContact.subtitle})
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Pick an agent or contact...</span>
                  )}
                  <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder="Type a name to search..."
                    value={contactSearch}
                    onValueChange={setContactSearch}
                  />
                  <CommandList>
                    <CommandEmpty>No contacts found.</CommandEmpty>
                    <CommandGroup>
                      {contactOptions
                        .filter((c) => {
                          if (!contactSearch) return true;
                          const q = contactSearch.toLowerCase();
                          return (
                            c.name.toLowerCase().includes(q) ||
                            c.subtitle.toLowerCase().includes(q)
                          );
                        })
                        .slice(0, 50)
                        .map((c) => (
                          <CommandItem
                            key={c.id}
                            value={c.id}
                            onSelect={() => {
                              setSelectedAgentId(c.id);
                              if (c.agencyId) setSelectedAgencyId(c.agencyId);
                              setContactOpen(false);
                              setContactSearch("");
                              // Auto-focus notes for speed
                              if (selectedTypeId && notesRef.current) {
                                setTimeout(() => notesRef.current?.focus(), 50);
                              }
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-3.5 w-3.5",
                                selectedAgentId === c.id ? "opacity-100" : "opacity-0"
                              )}
                            />
                            <div className="flex flex-col min-w-0">
                              <span className="truncate text-sm">{c.name}</span>
                              {c.subtitle && (
                                <span className="truncate text-[10px] text-muted-foreground">
                                  {c.subtitle}
                                </span>
                              )}
                            </div>
                          </CommandItem>
                        ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {/* ── 3. Notes ── */}
          <div>
            <Label htmlFor="tp-notes" className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Notes
            </Label>
            <Textarea
              id="tp-notes"
              ref={notesRef}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Discussed pricing for drone package"
              rows={2}
              className="resize-none text-sm"
            />
          </div>

          {/* ── 4. Outcome (segmented control) ── */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">Outcome</Label>
            <div className="flex gap-1">
              {OUTCOMES.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setOutcome(outcome === o.value ? "" : o.value)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-all flex-1 justify-center cursor-pointer focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none",
                    outcome === o.value
                      ? "border-primary bg-primary/5 text-foreground font-medium"
                      : "border-border text-muted-foreground hover:bg-muted/50"
                  )}
                >
                  <span className={cn("h-2 w-2 rounded-full shrink-0", o.color)} />
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── 5. Sentiment (3-option toggle) ── */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">Sentiment</Label>
            <div className="flex gap-1">
              {SENTIMENTS.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setSentiment(sentiment === s.value ? "" : s.value)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-4 py-1.5 text-xs transition-all flex-1 justify-center cursor-pointer focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none",
                    sentiment === s.value
                      ? "border-primary bg-primary/5 text-foreground font-medium"
                      : "border-border text-muted-foreground hover:bg-muted/50"
                  )}
                >
                  <span className="text-sm">{s.emoji}</span>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── 6. Follow-up toggle + conditional fields ── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="tp-followup" className="text-xs font-medium text-muted-foreground">
                Follow-up
              </Label>
              <Switch
                id="tp-followup"
                checked={followUp}
                onCheckedChange={setFollowUp}
              />
            </div>
            {followUp && (
              <div className="flex gap-2 animate-in fade-in-0 slide-in-from-top-1 duration-150">
                <div className="flex-1">
                  <div className="relative">
                    <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                    <Input
                      type="date"
                      value={followUpDate}
                      onChange={(e) => setFollowUpDate(e.target.value)}
                      className="h-8 text-xs pl-8"
                    />
                  </div>
                </div>
                <div className="flex-1">
                  <Input
                    value={followUpNotes}
                    onChange={(e) => setFollowUpNotes(e.target.value)}
                    placeholder="e.g. Send updated pricing sheet"
                    className="h-8 text-xs"
                  />
                </div>
              </div>
            )}
          </div>

          {/* ── 7. Duration (optional) ── */}
          <div>
            <Label htmlFor="tp-duration" className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Duration (min)
            </Label>
            <div className="relative w-32">
              <Clock className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                id="tp-duration"
                type="number"
                min={0}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                placeholder="0"
                className="h-8 text-xs pl-8"
              />
            </div>
          </div>

          {/* ── 8. Gift fields (conditional) ── */}
          {isGiftCategory && (
            <div className="space-y-2 rounded-lg border border-pink-200 bg-pink-50/50 p-3 animate-in fade-in-0 slide-in-from-top-1 duration-150">
              <p className="text-xs font-semibold text-pink-700 flex items-center gap-1.5">
                <Gift className="h-3.5 w-3.5" />
                Gift Details
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="tp-gift-item" className="text-[10px] text-muted-foreground mb-1 block">Item</Label>
                  <Input
                    id="tp-gift-item"
                    value={giftItem}
                    onChange={(e) => setGiftItem(e.target.value)}
                    placeholder="e.g. Wine bottle"
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="tp-gift-cost" className="text-[10px] text-muted-foreground mb-1 block">Cost ($)</Label>
                  <Input
                    id="tp-gift-cost"
                    type="number"
                    min={0}
                    step="0.01"
                    value={cost}
                    onChange={(e) => setCost(e.target.value)}
                    placeholder="0.00"
                    className="h-8 text-xs"
                  />
                </div>
              </div>
              <div>
                <Label className="text-[10px] text-muted-foreground mb-1 block">Delivery Method</Label>
                <div className="flex gap-1">
                  {DELIVERY_METHODS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setGiftDelivery(giftDelivery === m ? "" : m)}
                      className={cn(
                        "rounded-md border px-2.5 py-1 text-[10px] transition-all flex-1 cursor-pointer focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none",
                        giftDelivery === m
                          ? "border-pink-400 bg-pink-100 text-pink-700 font-medium"
                          : "border-border text-muted-foreground hover:bg-muted/50"
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <DialogFooter className="gap-2 sm:gap-0">
          <p className="text-[10px] text-muted-foreground/70 mr-auto hidden sm:block">
            {"\u2318"}+Enter to save
          </p>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !selectedTypeId || !selectedAgentId}
          >
            {saving ? (
              <span className="flex items-center gap-1.5">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Saving...
              </span>
            ) : (
              "Log Touchpoint"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
