/**
 * MasterListingReview — Wave 11.7.7 operator UX
 *
 * Spec: docs/design-specs/W11-7-7-master-listing-copy.md §"Output schema"
 *       (master listing fields)
 *       docs/design-specs/W11-7-8-voice-tier-modulation.md (tier word-count
 *       + reading-grade bands surfaced as soft warnings)
 *
 * URL: /MasterListingReview?round=<round_id>
 *
 * Renders the active shortlisting_master_listings row for a round and lets a
 * master_admin / admin:
 *   1. Edit any field inline (textarea / list reorder for key_features)
 *   2. Save edits — calls master-listing-edit edge fn (audit trail + JSONB
 *      patch on shortlisting_master_listings.master_listing)
 *   3. Regenerate — calls regenerate-master-listing with optional voice tier
 *      override or voice anchor override
 *   4. View prior versions from shortlisting_master_listings_history
 *
 * Soft validation:
 *   - Word count outside the tier band (premium 700-1000 / standard 500-750
 *     / approachable 350-500) → amber warning
 *   - Forbidden phrases (stunning / must inspect / boasts / nestled / etc) →
 *     red flag with phrase + section
 *   - Exclamation marks → zero-tolerance flag
 *
 * Permission gating: PermissionGuard wrapper restricts to master_admin / admin.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, supabase } from "@/api/supabaseClient";
import { PermissionGuard, usePermissions } from "@/components/auth/PermissionGuard";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  History,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Tier word-count + reading-grade bands. W11.7.8.
const TIER_BANDS = {
  premium: { wordCount: [700, 1000], readingGrade: [9, 12] },
  standard: { wordCount: [500, 750], readingGrade: [8, 10] },
  approachable: { wordCount: [350, 500], readingGrade: [6, 8] },
};

// Forbidden phrases (W11.7.7). Soft warnings — operator may have cause.
const FORBIDDEN_PATTERNS = [
  { name: "stunning", re: /\bstunning\b/i },
  { name: "must inspect", re: /\bmust inspect\b/i },
  { name: "don't miss", re: /don['']t miss/i },
  { name: "modern living", re: /\bmodern living\b/i },
  { name: "boasts", re: /\bboasts\b/i },
  { name: "nestled", re: /\bnestled\b/i },
  { name: "prime location", re: /\bprime location\b/i },
  { name: "expansive", re: /\bexpansive\b/i },
  { name: "beautifully appointed", re: /\bbeautifully appointed\b/i },
];

// Field definitions for rendering. Order matches spec.
const BODY_FIELDS = [
  { key: "scene_setting_paragraph", label: "Scene setting (facade + character)", rows: 6 },
  { key: "interior_paragraph", label: "Interior (floor plan + key rooms)", rows: 6 },
  { key: "lifestyle_paragraph", label: "Lifestyle (entertaining + outdoor)", rows: 6 },
  { key: "closing_paragraph", label: "Closing (optional 4th beat)", rows: 4 },
];

const DERIVATIVE_FIELDS = [
  { key: "seo_meta_description", label: "SEO meta description (≤155 chars)", rows: 3 },
  { key: "social_post_caption", label: "Social post caption (Instagram-ready)", rows: 4 },
  { key: "print_brochure_summary", label: "Print brochure summary (~200 words)", rows: 6 },
  { key: "agent_one_liner", label: "Agent one-liner (10-15 words)", rows: 2 },
  { key: "open_home_email_blurb", label: "Open-home email blurb (3-4 lines)", rows: 4 },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

function computeWordCount(ml) {
  if (!ml || typeof ml !== "object") return 0;
  let total = 0;
  const stringFields = [
    "headline", "sub_headline",
    "scene_setting_paragraph", "interior_paragraph",
    "lifestyle_paragraph", "closing_paragraph",
    "location_paragraph", "target_buyer_summary",
  ];
  for (const f of stringFields) {
    const v = ml[f];
    if (typeof v === "string" && v.trim()) {
      total += v.trim().split(/\s+/).filter(Boolean).length;
    }
  }
  if (Array.isArray(ml.key_features)) {
    for (const item of ml.key_features) {
      if (typeof item === "string" && item.trim()) {
        total += item.trim().split(/\s+/).filter(Boolean).length;
      }
    }
  }
  return total;
}

function findForbiddenHits(ml) {
  const hits = [];
  if (!ml || typeof ml !== "object") return hits;
  const fields = [
    "headline", "sub_headline",
    ...BODY_FIELDS.map((f) => f.key),
    "location_paragraph", "target_buyer_summary",
    ...DERIVATIVE_FIELDS.map((f) => f.key),
  ];
  for (const fkey of fields) {
    const v = ml[fkey];
    if (typeof v !== "string") continue;
    for (const { name, re } of FORBIDDEN_PATTERNS) {
      if (re.test(v)) {
        hits.push({ field: fkey, phrase: name });
      }
    }
  }
  if (Array.isArray(ml.key_features)) {
    for (let i = 0; i < ml.key_features.length; i++) {
      const v = ml.key_features[i];
      if (typeof v !== "string") continue;
      for (const { name, re } of FORBIDDEN_PATTERNS) {
        if (re.test(v)) hits.push({ field: `key_features[${i}]`, phrase: name });
      }
    }
  }
  return hits;
}

function countExclamations(ml) {
  if (!ml) return 0;
  const fields = [
    "headline", "sub_headline",
    ...BODY_FIELDS.map((f) => f.key),
    "location_paragraph", "target_buyer_summary",
    ...DERIVATIVE_FIELDS.map((f) => f.key),
  ];
  let total = 0;
  for (const fkey of fields) {
    const v = ml[fkey];
    if (typeof v === "string") total += (v.match(/!/g) || []).length;
  }
  if (Array.isArray(ml.key_features)) {
    for (const v of ml.key_features) {
      if (typeof v === "string") total += (v.match(/!/g) || []).length;
    }
  }
  return total;
}

// ── Editable text area block ────────────────────────────────────────────────
function EditableTextBlock({ label, value, onChange, rows = 4, hint, hasFlag }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium flex items-center justify-between">
        <span>{label}</span>
        {hasFlag && (
          <Badge variant="destructive" className="text-[10px] h-4 inline-flex items-center gap-1">
            <AlertTriangle className="h-2.5 w-2.5" />
            forbidden phrase
          </Badge>
        )}
      </Label>
      <Textarea
        rows={rows}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "text-sm",
          hasFlag && "border-red-300 dark:border-red-700",
        )}
      />
      {hint && (
        <p className="text-[10px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

// ── Key features list (drag-to-reorder + edit) ──────────────────────────────
function KeyFeaturesEditor({ features, onChange }) {
  const items = Array.isArray(features) ? features : [];

  const updateAt = (idx, value) => {
    const next = items.slice();
    next[idx] = value;
    onChange(next);
  };
  const removeAt = (idx) => {
    const next = items.slice();
    next.splice(idx, 1);
    onChange(next);
  };
  const move = (idx, dir) => {
    const next = items.slice();
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= next.length) return;
    const tmp = next[idx];
    next[idx] = next[targetIdx];
    next[targetIdx] = tmp;
    onChange(next);
  };
  const addNew = () => {
    onChange([...items, ""]);
  };

  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium">Key features (6-10 bullets ideal)</Label>
      <div className="space-y-1">
        {items.map((item, idx) => (
          <div key={idx} className="flex items-start gap-1">
            <div className="flex flex-col gap-0.5 pt-1">
              <Button
                size="icon"
                variant="ghost"
                className="h-5 w-5"
                onClick={() => move(idx, -1)}
                disabled={idx === 0}
                title="Move up"
              >
                <ArrowUp className="h-3 w-3" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-5 w-5"
                onClick={() => move(idx, 1)}
                disabled={idx === items.length - 1}
                title="Move down"
              >
                <ArrowDown className="h-3 w-3" />
              </Button>
            </div>
            <Input
              value={item ?? ""}
              onChange={(e) => updateAt(idx, e.target.value)}
              className="text-sm"
              placeholder="e.g. Caesarstone island bench, 20mm matte stone"
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => removeAt(idx)}
              title="Remove"
            >
              <Trash className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Button size="sm" variant="outline" onClick={addNew} className="text-xs h-7">
        <Plus className="h-3 w-3 mr-1" />
        Add feature
      </Button>
    </div>
  );
}

// ── Regenerate dialog ───────────────────────────────────────────────────────
function RegenerateDialog({ open, onOpenChange, currentTier, onRegenerate, regenerating }) {
  const [tierOverride, setTierOverride] = useState(currentTier || "standard");
  const [voiceAnchor, setVoiceAnchor] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) {
      setTierOverride(currentTier || "standard");
      setVoiceAnchor("");
      setReason("");
    }
  }, [open, currentTier]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Regenerate master listing</DialogTitle>
          <DialogDescription>
            Stage 4 will re-synthesise the listing copy with the chosen voice. The
            current version is archived to history. Cost ~$1.20 per regeneration.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label className="text-xs">Voice tier</Label>
            <Select value={tierOverride} onValueChange={setTierOverride}>
              <SelectTrigger className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="premium">
                  Premium · Belle Property / luxury magazine voice
                </SelectItem>
                <SelectItem value="standard">
                  Standard · Domain editorial — confident, accessible
                </SelectItem>
                <SelectItem value="approachable">
                  Approachable · Friendly plain-language
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">
              Custom voice anchor (optional — replaces the tier rubric)
            </Label>
            <Textarea
              value={voiceAnchor}
              onChange={(e) => setVoiceAnchor(e.target.value.slice(0, 2000))}
              rows={5}
              className="text-xs font-mono"
              placeholder='e.g. "Warm but agent-led, not editorial. Lead with bedroom count + one architectural note."'
            />
            <p className="text-[10px] text-muted-foreground text-right">
              {voiceAnchor.length} / 2000
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Reason (optional, kept in history archive)</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="text-sm"
              placeholder="e.g. 'agent rejected — wants premium voice on this $1.2M cottage'"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onRegenerate({
                voice_tier_override: tierOverride === currentTier ? undefined : tierOverride,
                voice_anchor_override: voiceAnchor.trim() || undefined,
                reason: reason.trim() || undefined,
              })
            }
            disabled={regenerating}
          >
            {regenerating ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Regenerate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── History dialog ──────────────────────────────────────────────────────────
function HistoryDialog({ open, onOpenChange, masterListingId }) {
  const historyQuery = useQuery({
    queryKey: ["master_listing_history", masterListingId],
    queryFn: async () => {
      if (!masterListingId) return [];
      const { data, error } = await supabase
        .from("shortlisting_master_listings_history")
        .select(
          "id, master_listing, property_tier, voice_anchor_used, " +
            "regeneration_count, archived_at, archived_by, archive_reason",
        )
        .eq("master_listing_id", masterListingId)
        .order("archived_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data || [];
    },
    enabled: open && Boolean(masterListingId),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Prior versions archived by regenerate-master-listing. Most recent first.
          </DialogDescription>
        </DialogHeader>
        {historyQuery.isLoading && <Skeleton className="h-32 w-full" />}
        {historyQuery.error && (
          <div className="text-sm text-destructive">
            Failed to load history: {historyQuery.error.message}
          </div>
        )}
        {historyQuery.data?.length === 0 && (
          <div className="text-sm text-muted-foreground italic">
            No prior versions — this is the original synthesis.
          </div>
        )}
        <div className="space-y-3">
          {(historyQuery.data || []).map((row) => (
            <Card key={row.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center justify-between gap-2">
                  <span>v{row.regeneration_count + 1}</span>
                  <Badge variant="outline" className="text-[10px] h-4">
                    {row.property_tier}
                  </Badge>
                </CardTitle>
                <CardDescription className="text-[11px]">
                  Archived {fmtTime(row.archived_at)}
                  {row.archive_reason ? ` · ${row.archive_reason}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs space-y-1">
                <div className="font-medium">{row.master_listing?.headline || "—"}</div>
                <div className="text-muted-foreground italic">
                  {row.master_listing?.sub_headline || "—"}
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                    Show body
                  </summary>
                  <div className="mt-2 space-y-2 pl-2 border-l-2">
                    {[
                      "scene_setting_paragraph",
                      "interior_paragraph",
                      "lifestyle_paragraph",
                      "closing_paragraph",
                    ].map((k) => (
                      <p key={k} className="leading-relaxed text-[11px]">
                        {row.master_listing?.[k] || ""}
                      </p>
                    ))}
                  </div>
                </details>
              </CardContent>
            </Card>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function MasterListingReview() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isMasterAdmin } = usePermissions();
  const roundId = searchParams.get("round");

  const [draft, setDraft] = useState(null); // working copy of master_listing JSON
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Load round (for tier + project context).
  const roundQuery = useQuery({
    queryKey: ["round_detail", roundId],
    queryFn: async () => {
      if (!roundId) return null;
      const { data, error } = await supabase
        .from("shortlisting_rounds")
        .select(
          "id, project_id, round_number, status, engine_mode, property_tier, " +
            "property_voice_anchor_override, package_type, started_at, created_at",
        )
        .eq("id", roundId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },
    enabled: Boolean(roundId),
    staleTime: 30_000,
  });

  // Load active master listing.
  const mlQuery = useQuery({
    queryKey: ["master_listing", roundId],
    queryFn: async () => {
      if (!roundId) return null;
      const { data, error } = await supabase
        .from("shortlisting_master_listings")
        .select("*")
        .eq("round_id", roundId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error && error.code !== "PGRST116") throw new Error(error.message);
      return data ?? null;
    },
    enabled: Boolean(roundId),
    staleTime: 15_000,
  });

  const masterListing = mlQuery.data?.master_listing;

  // Initialize draft when master listing loads.
  useEffect(() => {
    if (mlQuery.data?.master_listing && !draft) {
      setDraft({ ...mlQuery.data.master_listing });
    }
  }, [mlQuery.data?.master_listing, draft]);

  // Reset draft when round changes.
  useEffect(() => {
    setDraft(null);
  }, [roundId]);

  const handleFieldChange = (field, value) => {
    setDraft((prev) => ({ ...(prev ?? {}), [field]: value }));
  };

  // Compute diff between draft and original.
  const dirtyEdits = useMemo(() => {
    if (!draft || !masterListing) return [];
    const edits = [];
    const fields = [
      "headline", "sub_headline",
      ...BODY_FIELDS.map((f) => f.key),
      "key_features",
      "location_paragraph", "target_buyer_summary",
      ...DERIVATIVE_FIELDS.map((f) => f.key),
      "tone_anchor",
    ];
    for (const f of fields) {
      const orig = masterListing[f];
      const next = draft[f];
      if (JSON.stringify(orig) !== JSON.stringify(next)) {
        edits.push({ field: f, prior_value: orig, new_value: next });
      }
    }
    return edits;
  }, [draft, masterListing]);

  // Save edits via master-listing-edit edge fn.
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!mlQuery.data?.id) throw new Error("No master_listing loaded");
      const result = await api.functions.invoke("master-listing-edit", {
        master_listing_id: mlQuery.data.id,
        edits: dirtyEdits,
      });
      if (result?.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }
      return result?.data ?? result;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["master_listing", roundId] });
      const warnings = data?.warnings ?? [];
      if (warnings.length > 0) {
        toast.warning(`Saved with ${warnings.length} warning(s): ${warnings[0]}`);
      } else {
        toast.success(`Saved ${dirtyEdits.length} edit${dirtyEdits.length === 1 ? "" : "s"}.`);
      }
    },
    onError: (err) => toast.error(`Save failed: ${err?.message || err}`),
  });

  // Regenerate via regenerate-master-listing edge fn.
  const regenerateMutation = useMutation({
    mutationFn: async (overrides) => {
      const result = await api.functions.invoke("regenerate-master-listing", {
        round_id: roundId,
        ...overrides,
      });
      if (result?.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }
      return result?.data ?? result;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["master_listing", roundId] });
      queryClient.invalidateQueries({ queryKey: ["master_listing_history"] });
      toast.success(`Regeneration enqueued (job ${data?.job_id?.slice(0, 8)}…)`);
      setRegenerateOpen(false);
    },
    onError: (err) => toast.error(`Regenerate failed: ${err?.message || err}`),
  });

  // Live computed metrics on the draft.
  const liveWordCount = useMemo(() => computeWordCount(draft), [draft]);
  const forbiddenHits = useMemo(() => findForbiddenHits(draft), [draft]);
  const exclamationCount = useMemo(() => countExclamations(draft), [draft]);
  const forbiddenFieldSet = useMemo(
    () => new Set(forbiddenHits.map((h) => h.field)),
    [forbiddenHits],
  );

  const tier = roundQuery.data?.property_tier || mlQuery.data?.property_tier || "standard";
  const wordBand = TIER_BANDS[tier]?.wordCount;
  const wordCountInBand =
    wordBand && liveWordCount >= wordBand[0] && liveWordCount <= wordBand[1];
  const wordCountHint = wordBand
    ? `${tier} target: ${wordBand[0]}-${wordBand[1]} words`
    : null;

  // ── Render ────────────────────────────────────────────────────────────────
  if (!roundId) {
    return (
      <PermissionGuard require={["master_admin", "admin"]}>
        <div className="p-6 max-w-3xl mx-auto">
          <Card>
            <CardContent className="p-6 text-center">
              <p className="text-sm text-muted-foreground">
                No round selected. Open this page from a round detail with{" "}
                <code className="text-xs">?round=&lt;round_id&gt;</code>.
              </p>
            </CardContent>
          </Card>
        </div>
      </PermissionGuard>
    );
  }

  return (
    <PermissionGuard require={["master_admin", "admin"]}>
      <div className="p-6 space-y-4 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate(-1)}
              className="text-xs"
            >
              <ArrowLeft className="h-3.5 w-3.5 mr-1" />
              Back
            </Button>
            <div>
              <h1 className="text-xl font-bold">Master listing review</h1>
              <p className="text-xs text-muted-foreground">
                Round {roundQuery.data?.round_number ?? "—"}
                {roundQuery.data?.package_type ? ` · ${roundQuery.data.package_type}` : ""}{" "}
                · Voice tier:{" "}
                <Badge variant="outline" className="text-[10px] h-4">
                  {tier}
                </Badge>
                {mlQuery.data?.regeneration_count > 0 && (
                  <>
                    {" · "}
                    <Badge variant="secondary" className="text-[10px] h-4">
                      v{mlQuery.data.regeneration_count + 1}
                    </Badge>
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setHistoryOpen(true)}
              disabled={!mlQuery.data}
            >
              <History className="h-3.5 w-3.5 mr-1" />
              History
            </Button>
            {isMasterAdmin && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRegenerateOpen(true)}
                disabled={!mlQuery.data}
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
                Regenerate
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={dirtyEdits.length === 0 || saveMutation.isPending || !mlQuery.data}
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1" />
              )}
              Save
              {dirtyEdits.length > 0 ? ` (${dirtyEdits.length})` : ""}
            </Button>
          </div>
        </div>

        {/* Loading / error / empty */}
        {mlQuery.isLoading && (
          <Card>
            <CardContent className="p-6">
              <Skeleton className="h-32 w-full" />
            </CardContent>
          </Card>
        )}

        {mlQuery.error && (
          <Card className="border-red-200 dark:border-red-900">
            <CardContent className="p-4">
              <div className="text-sm text-destructive">
                Failed to load master listing: {mlQuery.error.message}
              </div>
            </CardContent>
          </Card>
        )}

        {!mlQuery.isLoading && !mlQuery.error && !mlQuery.data && (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              No master listing exists for this round yet. Stage 4 must run first
              (engine_mode must be Shape D and Stage 4 must succeed).
            </CardContent>
          </Card>
        )}

        {mlQuery.data && draft && (
          <>
            {/* Quality flags banner */}
            {(forbiddenHits.length > 0 || exclamationCount > 0 || !wordCountInBand) && (
              <Card className="border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20">
                <CardContent className="p-3">
                  <div className="text-xs font-semibold flex items-center gap-1.5 mb-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-700" />
                    Quality flags (live, recomputed as you edit)
                  </div>
                  <div className="text-xs space-y-0.5">
                    {!wordCountInBand && wordBand && (
                      <div>
                        Word count <span className="font-mono">{liveWordCount}</span>{" "}
                        outside <span className="font-mono">{tier}</span> band [
                        {wordBand[0]}-{wordBand[1]}]
                      </div>
                    )}
                    {forbiddenHits.length > 0 && (
                      <div>
                        Forbidden phrases:{" "}
                        {forbiddenHits.slice(0, 5).map((h, i) => (
                          <span key={i} className="font-mono mr-2">
                            "{h.phrase}" in {h.field}
                          </span>
                        ))}
                        {forbiddenHits.length > 5 ? `… +${forbiddenHits.length - 5} more` : ""}
                      </div>
                    )}
                    {exclamationCount > 0 && (
                      <div>
                        {exclamationCount} exclamation mark
                        {exclamationCount === 1 ? "" : "s"} present (zero-tolerance per
                        tier rubric)
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Hook + body */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Hook</CardTitle>
                <CardDescription className="text-xs">
                  Headline + sub-headline lead the listing.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs font-medium">
                    Headline (8-15 words)
                  </Label>
                  <Input
                    value={draft.headline ?? ""}
                    onChange={(e) => handleFieldChange("headline", e.target.value)}
                    className={cn(
                      "text-base font-semibold",
                      forbiddenFieldSet.has("headline") && "border-red-300",
                    )}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-medium">
                    Sub-headline (12-25 words)
                  </Label>
                  <Textarea
                    rows={2}
                    value={draft.sub_headline ?? ""}
                    onChange={(e) => handleFieldChange("sub_headline", e.target.value)}
                    className={cn(
                      "text-sm italic",
                      forbiddenFieldSet.has("sub_headline") && "border-red-300",
                    )}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Body</CardTitle>
                <CardDescription className="text-xs">
                  3-4 paragraphs · ~{wordBand?.[0]}-{wordBand?.[1]} words ·{" "}
                  current: {liveWordCount}{" "}
                  {wordCountInBand ? (
                    <span className="text-emerald-600">in band</span>
                  ) : (
                    <span className="text-amber-600">out of band</span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {BODY_FIELDS.map((f) => (
                  <EditableTextBlock
                    key={f.key}
                    label={f.label}
                    value={draft[f.key]}
                    onChange={(v) => handleFieldChange(f.key, v)}
                    rows={f.rows}
                    hasFlag={forbiddenFieldSet.has(f.key)}
                  />
                ))}
              </CardContent>
            </Card>

            {/* Standalone */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Standalone fields</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <KeyFeaturesEditor
                  features={draft.key_features}
                  onChange={(v) => handleFieldChange("key_features", v)}
                />
                <EditableTextBlock
                  label="Location paragraph (80-120 words)"
                  value={draft.location_paragraph}
                  onChange={(v) => handleFieldChange("location_paragraph", v)}
                  rows={4}
                  hasFlag={forbiddenFieldSet.has("location_paragraph")}
                />
                <EditableTextBlock
                  label="Target buyer summary (15-25 words)"
                  value={draft.target_buyer_summary}
                  onChange={(v) => handleFieldChange("target_buyer_summary", v)}
                  rows={2}
                  hasFlag={forbiddenFieldSet.has("target_buyer_summary")}
                />
              </CardContent>
            </Card>

            {/* Derivatives */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-amber-600" />
                  Derivatives
                </CardTitle>
                <CardDescription className="text-xs">
                  Publishing-ready strings. Channel-specific length constraints
                  apply across all tiers.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {DERIVATIVE_FIELDS.map((f) => (
                  <EditableTextBlock
                    key={f.key}
                    label={f.label}
                    value={draft[f.key]}
                    onChange={(v) => handleFieldChange(f.key, v)}
                    rows={f.rows}
                    hasFlag={forbiddenFieldSet.has(f.key)}
                  />
                ))}
              </CardContent>
            </Card>

            {/* Editorial metadata footer */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Editorial metadata</CardTitle>
                <CardDescription className="text-xs">
                  Read-only — recomputed on save. Reading-grade is recomputed
                  downstream by shortlisting-quality-checks.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div className="border rounded p-2">
                    <div className="text-muted-foreground text-[10px]">
                      Word count (live)
                    </div>
                    <div className="font-mono text-sm font-semibold">
                      {liveWordCount}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {wordCountHint}
                    </div>
                  </div>
                  <div className="border rounded p-2">
                    <div className="text-muted-foreground text-[10px]">
                      Word count (model)
                    </div>
                    <div className="font-mono text-sm">
                      {mlQuery.data.word_count ?? "—"}
                    </div>
                  </div>
                  <div className="border rounded p-2">
                    <div className="text-muted-foreground text-[10px]">
                      Reading grade (model)
                    </div>
                    <div className="font-mono text-sm">
                      {mlQuery.data.reading_grade_level ?? "—"}
                    </div>
                  </div>
                  <div className="border rounded p-2">
                    <div className="text-muted-foreground text-[10px]">
                      Reading grade (computed)
                    </div>
                    <div className="font-mono text-sm">
                      {mlQuery.data.reading_grade_level_computed ?? "—"}
                    </div>
                  </div>
                </div>
                {draft.tone_anchor !== undefined && (
                  <div className="mt-3">
                    <Label className="text-xs">Tone anchor (model self-report)</Label>
                    <Input
                      value={draft.tone_anchor ?? ""}
                      onChange={(e) => handleFieldChange("tone_anchor", e.target.value)}
                      className="text-xs italic"
                      placeholder='e.g. "Domain editorial, warm-but-grounded"'
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <RegenerateDialog
          open={regenerateOpen}
          onOpenChange={setRegenerateOpen}
          currentTier={tier}
          onRegenerate={(overrides) => regenerateMutation.mutate(overrides)}
          regenerating={regenerateMutation.isPending}
        />
        <HistoryDialog
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          masterListingId={mlQuery.data?.id}
        />
      </div>
    </PermissionGuard>
  );
}
