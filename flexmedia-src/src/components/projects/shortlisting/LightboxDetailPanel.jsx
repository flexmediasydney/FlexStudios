/**
 * LightboxDetailPanel — comprehensive read-only inspector for every
 * decision the engine made about an image.
 *
 * Reads the `composition_classifications` row + the editorial envelope
 * stashed on `shortlisting_overrides.ai_proposed_analysis` and renders
 * EVERY non-null field grouped into collapsible categories.  The goal is
 * to expose the full engine state so operators can audit decisions
 * without hitting the DB.
 *
 * Sections (each collapsible, smart-default expanded for the most-used):
 *
 *   1. Engine decision        — slot/role/quota/score (NEW: editorial)
 *   2. Classification         — room/space/vantage/composition/lens/etc
 *   3. Quality scores         — combined + per-dimension (the 4 + 26 sub)
 *   4. Detail flags           — is_drone/is_styled/is_exterior/etc
 *   5. Visual content         — key_elements/zones/observed_objects
 *   6. Style & era            — style_archetype/era_hint/materials/buyer
 *   7. Appeal & concerns      — appeal_signals/concern_signals
 *   8. Retouch                — clutter/retouch_priority/estimate
 *   9. Listing copy           — headline/paragraphs (when present)
 *  10. Stage 4 corrections    — visual cross-comparison overrides
 *  11. Editorial rationale    — model's "why this pick" prose
 *  12. Search & embeddings    — searchable_keywords/embedding_anchor
 *  13. Space instance         — space_instance_id + confidence
 *  14. Group metadata         — bracket count / camera / is_secondary
 *  15. Engine version         — model_version / schema / classified_at
 *  16. Raw classification     — full JSON dump (debug escape hatch)
 *
 * Sections that have nothing to render are skipped entirely so the panel
 * stays tight on simpler images.
 *
 * Caller passes the same `item` that ShortlistingLightbox already has;
 * this component reads classification data off it (no extra fetches in
 * v1; the swimlane caller already joins the classification row).  A
 * future v2 could fetch shortlisting_stage4_overrides for the stem if
 * we want to show un-mirrored visual corrections.
 */

import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Sparkles,
  Layout,
  Tag,
  Eye,
  Palette,
  Wrench,
  FileText,
  AlertTriangle,
  History,
  Search,
  Box,
  Layers,
  Code,
  TrendingUp,
  ListChecks,
  CheckCircle2,
  XCircle,
  Star,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Helpers ──────────────────────────────────────────────────────────────

function isEmpty(v) {
  if (v == null) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

function fmtScore(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toFixed(1);
}

function scoreClass(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "text-white/40";
  if (n >= 8) return "text-emerald-300";
  if (n >= 6.5) return "text-lime-300";
  if (n >= 5) return "text-amber-300";
  return "text-rose-300";
}

function snakeToTitle(s) {
  if (!s || typeof s !== "string") return s;
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderValue(v) {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ");
  return JSON.stringify(v);
}

// ─── Section primitive ─────────────────────────────────────────────────────

function Section({ icon, title, count, defaultOpen = true, children, testId }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className="border-t border-white/10 pt-2 mt-3 first:border-t-0 first:pt-0 first:mt-0"
      data-testid={testId}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 mb-1.5 group"
      >
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-white/60 group-hover:text-white/85">
          {icon}
          {title}
          {typeof count === "number" && count > 0 ? (
            <span className="text-white/40 normal-case">({count})</span>
          ) : null}
        </span>
        {open ? (
          <ChevronDown className="h-3 w-3 text-white/50" />
        ) : (
          <ChevronRight className="h-3 w-3 text-white/50" />
        )}
      </button>
      {open ? <div className="space-y-1">{children}</div> : null}
    </div>
  );
}

function KVList({ entries, mono = false }) {
  if (entries.length === 0) {
    return <div className="text-[10px] text-white/40 italic">—</div>;
  }
  return (
    <ul className="space-y-0.5">
      {entries.map(([k, v], i) => (
        <li
          key={`${k}-${i}`}
          className="flex items-start justify-between gap-2 text-[11px]"
        >
          <span className="text-white/55 capitalize shrink-0">
            {snakeToTitle(k)}
          </span>
          <span
            className={cn(
              "text-right text-white/85",
              mono && "font-mono text-[10px]",
            )}
            title={typeof v === "string" ? v : undefined}
          >
            {renderValue(v)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ChipList({ chips, tone = "neutral" }) {
  if (!chips || chips.length === 0) return null;
  const toneClasses = {
    neutral: "bg-white/10 text-white/85 ring-white/15",
    appeal: "bg-emerald-500/15 text-emerald-200 ring-emerald-400/30",
    concern: "bg-rose-500/15 text-rose-200 ring-rose-400/30",
    retouch: "bg-amber-500/15 text-amber-200 ring-amber-400/30",
  };
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c, i) => (
        <span
          key={`${c}-${i}`}
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] ring-1",
            toneClasses[tone],
          )}
        >
          {typeof c === "string" ? c : JSON.stringify(c)}
        </span>
      ))}
    </div>
  );
}

// ─── Main panel ────────────────────────────────────────────────────────────

export default function LightboxDetailPanel({ item }) {
  const cls = item?.classification || null;
  const slot = item?.slot_decision || null;

  // Editorial envelope stashed on shortlisting_overrides.ai_proposed_analysis.
  // Caller should pass it through if available; falls back to nothing
  // when the round used the legacy slot_decisions persistence path.
  const editorial = useMemo(() => {
    const raw =
      item?.editorial_envelope ||
      item?.editorial ||
      slot?.editorial ||
      null;
    if (!raw || typeof raw !== "object") return null;
    return raw.editorial || raw;
  }, [item, slot]);

  // ── Section 1: Engine decision (slot / role / editorial) ──────────────
  const decisionEntries = useMemo(() => {
    const out = [];
    if (editorial?.quota_bucket) out.push(["quota_bucket", editorial.quota_bucket]);
    if (editorial?.role_label) out.push(["role_label", editorial.role_label]);
    if (slot?.slot_id && (!editorial || slot.slot_id !== editorial.role_label)) {
      out.push(["slot_id", slot.slot_id]);
    }
    if (slot?.phase != null) out.push(["phase", slot.phase]);
    if (typeof editorial?.editorial_score === "number") {
      out.push(["editorial_score", editorial.editorial_score]);
    }
    if (typeof slot?.slot_fit_score === "number") out.push(["slot_fit_score", slot.slot_fit_score]);
    if (typeof slot?.ai_proposed_score === "number") {
      out.push(["ai_proposed_score", slot.ai_proposed_score]);
    }
    if (slot?.position_index != null) out.push(["position_index", slot.position_index]);
    if (slot?.position_filled_via) out.push(["position_filled_via", slot.position_filled_via]);
    if (editorial?.quota_source) out.push(["quota_source", editorial.quota_source]);
    if (editorial?.policy_source) out.push(["policy_source", editorial.policy_source]);
    return out;
  }, [editorial, slot]);

  // ── Section 2: Classification ─────────────────────────────────────────
  const classificationEntries = useMemo(() => {
    if (!cls) return [];
    const fields = [
      "room_type",
      "space_type",
      "zone_focus",
      "space_zone_count",
      "composition_type",
      "vantage_point",
      "vantage_position",
      "composition_geometry",
      "shot_scale",
      "perspective_compression",
      "lens_class",
      "image_type",
      "orientation",
      "time_of_day",
      "source_type",
    ];
    return fields
      .filter((f) => !isEmpty(cls[f]))
      .map((f) => [f, cls[f]]);
  }, [cls]);

  // ── Section 3: Quality scores (the 4 dimensions + combined) ───────────
  const qualityEntries = useMemo(() => {
    if (!cls) return [];
    const fields = [
      "combined_score",
      "technical_score",
      "lighting_score",
      "composition_score",
      "aesthetic_score",
      "room_type_confidence",
    ];
    return fields
      .filter((f) => typeof cls[f] === "number" && Number.isFinite(cls[f]))
      .map((f) => [f, cls[f]]);
  }, [cls]);

  // ── Section 4: Detail flags ───────────────────────────────────────────
  const flagEntries = useMemo(() => {
    if (!cls) return [];
    const fields = [
      "is_drone",
      "is_exterior",
      "is_detail_shot",
      "is_styled",
      "indoor_outdoor_visible",
      "social_first_friendly",
      "requires_human_review",
      "flag_for_retouching",
      "eligible_for_exterior_rear",
      "is_near_duplicate_candidate",
    ];
    return fields
      .filter((f) => cls[f] != null)
      .map((f) => [f, cls[f]]);
  }, [cls]);

  // ── Section 5: Visual content ─────────────────────────────────────────
  const keyElements = Array.isArray(cls?.key_elements) ? cls.key_elements : [];
  const zonesVisible = Array.isArray(cls?.zones_visible) ? cls.zones_visible : [];
  const observedObjects = Array.isArray(cls?.observed_objects) ? cls.observed_objects : [];
  const observedAttributes = Array.isArray(cls?.observed_attributes)
    ? cls.observed_attributes
    : [];
  const visualHasContent =
    keyElements.length > 0 ||
    zonesVisible.length > 0 ||
    observedObjects.length > 0 ||
    observedAttributes.length > 0;

  // ── Section 6: Style + era + materials + buyer ────────────────────────
  const styleEntries = useMemo(() => {
    if (!cls) return [];
    const fields = [
      "style_archetype",
      "era_hint",
      "material_palette_summary",
      "shot_intent",
      "gallery_position_hint",
    ];
    return fields
      .filter((f) => !isEmpty(cls[f]))
      .map((f) => [f, cls[f]]);
  }, [cls]);
  const buyerHints = Array.isArray(cls?.buyer_persona_hints) ? cls.buyer_persona_hints : [];

  // ── Section 7: Appeal & concerns ──────────────────────────────────────
  const appealSignals = Array.isArray(cls?.appeal_signals) ? cls.appeal_signals : [];
  const concernSignals = Array.isArray(cls?.concern_signals) ? cls.concern_signals : [];
  const appealHasContent = appealSignals.length > 0 || concernSignals.length > 0;

  // ── Section 8: Retouch ────────────────────────────────────────────────
  const retouchEntries = useMemo(() => {
    if (!cls) return [];
    const fields = [
      "clutter_severity",
      "clutter_detail",
      "retouch_priority",
      "retouch_estimate_minutes",
      "flag_for_retouching",
      "retouch_resolved_at",
      "retouch_resolved_by",
    ];
    return fields
      .filter((f) => !isEmpty(cls[f]))
      .map((f) => [f, cls[f]]);
  }, [cls]);

  // ── Section 9: Listing copy ───────────────────────────────────────────
  const listingHeadline = cls?.listing_copy_headline;
  const listingParagraphs = Array.isArray(cls?.listing_copy_paragraphs)
    ? cls.listing_copy_paragraphs
    : [];

  // ── Section 11: Editorial rationale (from envelope) ───────────────────
  const editorialRationale = editorial?.rationale || slot?.rationale || cls?.analysis || null;
  const editorialPrinciples = Array.isArray(editorial?.principles_applied)
    ? editorial.principles_applied
    : [];

  // ── Section 12: Search & embeddings ───────────────────────────────────
  const searchKeywords = Array.isArray(cls?.searchable_keywords)
    ? cls.searchable_keywords
    : [];
  const embeddingAnchor = cls?.embedding_anchor_text;

  // ── Section 13: Space instance ────────────────────────────────────────
  const spaceInstanceEntries = useMemo(() => {
    if (!cls) return [];
    const out = [];
    if (cls.space_instance_id) out.push(["space_instance_id", cls.space_instance_id]);
    if (typeof cls.space_instance_confidence === "number") {
      out.push(["space_instance_confidence", cls.space_instance_confidence]);
    }
    return out;
  }, [cls]);

  // ── Section 14: Group metadata (when threaded through) ────────────────
  const groupEntries = useMemo(() => {
    const g = item?.group_metadata || item?.group || null;
    if (!g) return [];
    const fields = [
      "group_index",
      "file_count",
      "best_bracket_stem",
      "delivery_reference_stem",
      "selected_bracket_luminance",
      "is_micro_adjustment_split",
      "camera_source",
      "is_secondary_camera",
      "synthetic_finals_match_stem",
    ];
    return fields
      .filter((f) => !isEmpty(g[f]))
      .map((f) => [f, g[f]]);
  }, [item]);

  // ── Section 15: Engine version ────────────────────────────────────────
  const versionEntries = useMemo(() => {
    if (!cls) return [];
    const out = [];
    if (cls.model_version) out.push(["model_version", cls.model_version]);
    if (cls.schema_version) out.push(["schema_version", cls.schema_version]);
    if (cls.classified_at) out.push(["classified_at", cls.classified_at]);
    if (cls.prompt_block_versions && typeof cls.prompt_block_versions === "object") {
      for (const [k, v] of Object.entries(cls.prompt_block_versions)) {
        out.push([`prompt_${k}`, v]);
      }
    }
    return out;
  }, [cls]);

  // ── Section 16: Confidence per field ──────────────────────────────────
  const confidenceEntries = useMemo(() => {
    const cpf = cls?.confidence_per_field;
    if (!cpf || typeof cpf !== "object") return [];
    return Object.entries(cpf)
      .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
      .sort((a, b) => b[1] - a[1]);
  }, [cls]);

  // ── Section 17: Stage 4 corrections passed in via item ────────────────
  const stage4Corrections = Array.isArray(item?.stage4_overrides)
    ? item.stage4_overrides
    : [];

  return (
    <>
      {/* 1. Engine decision (editorial / slot / score combined) */}
      {decisionEntries.length > 0 ? (
        <Section
          icon={<Sparkles className="h-3 w-3 text-amber-400" />}
          title="Engine decision"
          defaultOpen
          testId="detail-section-decision"
        >
          <KVList entries={decisionEntries} mono />
        </Section>
      ) : null}

      {/* 2. Classification */}
      {classificationEntries.length > 0 ? (
        <Section
          icon={<Layout className="h-3 w-3 text-blue-300" />}
          title="Classification"
          count={classificationEntries.length}
          defaultOpen
          testId="detail-section-classification"
        >
          <KVList entries={classificationEntries} />
        </Section>
      ) : null}

      {/* 3. Quality scores (combined + dimension scores).  The 26-signal
            breakdown stays in the parent panel; this is the headline
            number set. */}
      {qualityEntries.length > 0 ? (
        <Section
          icon={<TrendingUp className="h-3 w-3 text-emerald-300" />}
          title="Quality scores"
          defaultOpen
          testId="detail-section-quality"
        >
          <ul className="space-y-0.5">
            {qualityEntries.map(([k, v]) => (
              <li
                key={k}
                className="flex items-center justify-between gap-2 text-[11px]"
              >
                <span className="text-white/55 capitalize">{snakeToTitle(k)}</span>
                <span className={cn("font-mono tabular-nums", scoreClass(v))}>
                  {fmtScore(v)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* 4. Detail flags */}
      {flagEntries.length > 0 ? (
        <Section
          icon={<ListChecks className="h-3 w-3 text-cyan-300" />}
          title="Detail flags"
          count={flagEntries.length}
          defaultOpen={false}
          testId="detail-section-flags"
        >
          <ul className="space-y-0.5">
            {flagEntries.map(([k, v]) => (
              <li
                key={k}
                className="flex items-center justify-between gap-2 text-[11px]"
              >
                <span className="text-white/55">{snakeToTitle(k)}</span>
                <span className="flex items-center gap-1">
                  {v === true ? (
                    <CheckCircle2 className="h-3 w-3 text-emerald-300" />
                  ) : v === false ? (
                    <XCircle className="h-3 w-3 text-white/40" />
                  ) : null}
                  <span className="text-white/85 text-[10px]">
                    {renderValue(v)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* 5. Visual content */}
      {visualHasContent ? (
        <Section
          icon={<Eye className="h-3 w-3 text-violet-300" />}
          title="Visual content"
          defaultOpen={false}
          testId="detail-section-visual"
        >
          {keyElements.length > 0 ? (
            <div>
              <div className="text-[10px] text-white/45 mb-0.5">Key elements</div>
              <ChipList chips={keyElements} />
            </div>
          ) : null}
          {zonesVisible.length > 0 ? (
            <div className="mt-1.5">
              <div className="text-[10px] text-white/45 mb-0.5">Zones visible</div>
              <ChipList chips={zonesVisible} />
            </div>
          ) : null}
          {observedObjects.length > 0 ? (
            <div className="mt-1.5">
              <div className="text-[10px] text-white/45 mb-0.5">
                Observed objects ({observedObjects.length})
              </div>
              <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                {observedObjects.map((obj, i) => (
                  <li key={i} className="text-[10px] text-white/70">
                    <span className="font-mono text-white/85">{obj.label || obj.name || `obj_${i}`}</span>
                    {typeof obj.confidence === "number" ? (
                      <span className="text-white/45 ml-1.5">({(obj.confidence * 100).toFixed(0)}%)</span>
                    ) : null}
                    {obj.attributes && typeof obj.attributes === "object" ? (
                      <span className="text-white/45 ml-1.5">
                        {Object.entries(obj.attributes)
                          .slice(0, 3)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(", ")}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {observedAttributes.length > 0 ? (
            <div className="mt-1.5">
              <div className="text-[10px] text-white/45 mb-0.5">
                Observed attributes ({observedAttributes.length})
              </div>
              <ul className="space-y-0.5 max-h-24 overflow-y-auto">
                {observedAttributes.map((a, i) => (
                  <li key={i} className="text-[10px] text-white/70 font-mono">
                    {typeof a === "string" ? a : JSON.stringify(a)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>
      ) : null}

      {/* 6. Style & era */}
      {(styleEntries.length > 0 || buyerHints.length > 0) ? (
        <Section
          icon={<Palette className="h-3 w-3 text-fuchsia-300" />}
          title="Style & narrative"
          defaultOpen={false}
          testId="detail-section-style"
        >
          {styleEntries.length > 0 ? <KVList entries={styleEntries} /> : null}
          {buyerHints.length > 0 ? (
            <div className="mt-1.5">
              <div className="text-[10px] text-white/45 mb-0.5">Buyer persona hints</div>
              <ChipList chips={buyerHints} />
            </div>
          ) : null}
        </Section>
      ) : null}

      {/* 7. Appeal & concerns */}
      {appealHasContent ? (
        <Section
          icon={<Star className="h-3 w-3 text-yellow-300" />}
          title="Appeal & concerns"
          defaultOpen={false}
          testId="detail-section-appeal"
        >
          {appealSignals.length > 0 ? (
            <div>
              <div className="text-[10px] text-emerald-300 mb-0.5 uppercase">
                Appeal ({appealSignals.length})
              </div>
              <ChipList chips={appealSignals} tone="appeal" />
            </div>
          ) : null}
          {concernSignals.length > 0 ? (
            <div className="mt-1.5">
              <div className="text-[10px] text-rose-300 mb-0.5 uppercase">
                Concerns ({concernSignals.length})
              </div>
              <ChipList chips={concernSignals} tone="concern" />
            </div>
          ) : null}
        </Section>
      ) : null}

      {/* 8. Retouch */}
      {retouchEntries.length > 0 ? (
        <Section
          icon={<Wrench className="h-3 w-3 text-amber-300" />}
          title="Retouch"
          defaultOpen={false}
          testId="detail-section-retouch"
        >
          <KVList entries={retouchEntries} />
        </Section>
      ) : null}

      {/* 9. Listing copy */}
      {(listingHeadline || listingParagraphs.length > 0) ? (
        <Section
          icon={<FileText className="h-3 w-3 text-blue-200" />}
          title="Listing copy"
          defaultOpen={false}
          testId="detail-section-listing-copy"
        >
          {listingHeadline ? (
            <div className="text-[11px] text-white/85 italic mb-1">
              "{listingHeadline}"
            </div>
          ) : null}
          {listingParagraphs.map((p, i) => (
            <p
              key={i}
              className="text-[11px] text-white/75 leading-snug whitespace-pre-wrap"
            >
              {p}
            </p>
          ))}
        </Section>
      ) : null}

      {/* 10. Stage 4 visual corrections (when threaded through) */}
      {stage4Corrections.length > 0 ? (
        <Section
          icon={<AlertTriangle className="h-3 w-3 text-orange-300" />}
          title="Stage 4 corrections"
          count={stage4Corrections.length}
          defaultOpen={false}
          testId="detail-section-stage4"
        >
          <ul className="space-y-1">
            {stage4Corrections.map((s4, i) => (
              <li key={i} className="text-[11px] rounded-md bg-white/5 px-2 py-1">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="font-mono text-orange-200 text-[10px]">{s4.field}</span>
                  <span className="font-mono text-[9px] text-white/45 uppercase">
                    {s4.review_status || "pending"}
                  </span>
                </div>
                <div className="text-white/70 text-[10px]">
                  <span className="text-white/45">stage1:</span>{" "}
                  <code className="text-white/85">{s4.stage_1_value}</code>{" "}
                  →{" "}
                  <span className="text-white/45">stage4:</span>{" "}
                  <code className="text-emerald-200">{s4.stage_4_value}</code>
                </div>
                {s4.reason ? (
                  <div className="text-[10px] text-white/55 mt-0.5">{s4.reason}</div>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* 11. Editorial rationale (model's "why this pick" prose) */}
      {editorialRationale ? (
        <Section
          icon={<Tag className="h-3 w-3 text-pink-300" />}
          title={editorial?.rationale ? "Editorial rationale" : "Engine rationale"}
          defaultOpen={false}
          testId="detail-section-rationale"
        >
          {editorialPrinciples.length > 0 ? (
            <div className="mb-1">
              <div className="text-[10px] text-white/45 mb-0.5">Principles applied</div>
              <ChipList chips={editorialPrinciples} />
            </div>
          ) : null}
          <p className="text-[11px] text-white/80 leading-snug whitespace-pre-wrap">
            {editorialRationale}
          </p>
        </Section>
      ) : null}

      {/* 12. Search keywords + embedding anchor */}
      {(searchKeywords.length > 0 || embeddingAnchor) ? (
        <Section
          icon={<Search className="h-3 w-3 text-sky-300" />}
          title="Search & embeddings"
          defaultOpen={false}
          testId="detail-section-search"
        >
          {searchKeywords.length > 0 ? (
            <div>
              <div className="text-[10px] text-white/45 mb-0.5">
                Keywords ({searchKeywords.length})
              </div>
              <ChipList chips={searchKeywords} />
            </div>
          ) : null}
          {embeddingAnchor ? (
            <div className="mt-1.5">
              <div className="text-[10px] text-white/45 mb-0.5">Embedding anchor</div>
              <p className="text-[10px] text-white/75 italic font-mono leading-snug">
                {embeddingAnchor}
              </p>
            </div>
          ) : null}
        </Section>
      ) : null}

      {/* 13. Space instance */}
      {spaceInstanceEntries.length > 0 ? (
        <Section
          icon={<Box className="h-3 w-3 text-teal-300" />}
          title="Space instance"
          defaultOpen={false}
          testId="detail-section-space-instance"
        >
          <KVList entries={spaceInstanceEntries} mono />
        </Section>
      ) : null}

      {/* 14. Group metadata */}
      {groupEntries.length > 0 ? (
        <Section
          icon={<Layers className="h-3 w-3 text-indigo-300" />}
          title="Group metadata"
          defaultOpen={false}
          testId="detail-section-group"
        >
          <KVList entries={groupEntries} mono />
        </Section>
      ) : null}

      {/* 15. Confidence per field */}
      {confidenceEntries.length > 0 ? (
        <Section
          icon={<History className="h-3 w-3 text-purple-300" />}
          title="Per-field confidence"
          count={confidenceEntries.length}
          defaultOpen={false}
          testId="detail-section-confidence"
        >
          <ul className="space-y-0.5">
            {confidenceEntries.map(([k, v]) => (
              <li
                key={k}
                className="flex items-center justify-between gap-2 text-[11px]"
              >
                <span className="text-white/55">{snakeToTitle(k)}</span>
                <span className={cn("font-mono tabular-nums", scoreClass(v * 10))}>
                  {(v * 100).toFixed(0)}%
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* 16. Engine version */}
      {versionEntries.length > 0 ? (
        <Section
          icon={<Code className="h-3 w-3 text-slate-300" />}
          title="Engine version"
          defaultOpen={false}
          testId="detail-section-version"
        >
          <KVList entries={versionEntries} mono />
        </Section>
      ) : null}

      {/* 17. Raw classification dump (escape hatch for debugging) */}
      {cls ? (
        <Section
          icon={<Code className="h-3 w-3 text-white/40" />}
          title="Raw classification JSON"
          defaultOpen={false}
          testId="detail-section-raw"
        >
          <pre
            className="text-[9px] font-mono text-white/60 leading-snug whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-black/30 rounded-md p-1.5"
          >
            {JSON.stringify(cls, null, 2)}
          </pre>
        </Section>
      ) : null}
    </>
  );
}
