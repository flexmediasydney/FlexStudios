/**
 * QuoteProvenance — reusable hover/click popover exposing the full reasoning
 * trace of the Missed-Opportunity engine for a single pulse_listings row.
 *
 * Why this exists:
 *   Every $ amount surfaced by the Market Share engine is the result of a
 *   multi-step cascade (classify → tier → pricing). Unlike a CRM invoice
 *   where you can "see the line items", engine quotes are inferred — the
 *   user needs to trust the number. This component renders the full
 *   provenance: which rule fired, what evidence drove the tier, which
 *   matrix/project was inherited from, and the receipt math that produced
 *   the quoted price.
 *
 * Data source:
 *   RPC `pulse_get_listing_quote_detail(p_listing_id uuid) → jsonb`
 *   (migration 164). Only fetched when the popover actually opens,
 *   staleTime 60s via react-query.
 *
 * Usage:
 *   <QuoteProvenance listingId={uuid} mode="hover|click|both" placement="auto" align="start">
 *     <span>$3,450</span>
 *   </QuoteProvenance>
 *
 *   // Convenience wrappers (preferred)
 *   <QuoteAmount   listingId={uuid} amount={3450} />
 *   <PackageBadge  listingId={uuid} name="Dusk Video Package" />
 */
import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "@/components/ui/hover-card";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/api/supabaseClient";
import { cn } from "@/lib/utils";
import { useActivePackages } from "@/hooks/useActivePackages";
import {
  AlertTriangle,
  ExternalLink,
  Camera,
  Tag,
  Target,
  Calculator,
  Link as LinkIcon,
  CheckCircle2,
  XCircle,
  Building2,
  MapPin,
  RefreshCw,
  ChevronRight,
  Info,
} from "lucide-react";

// ─── Formatters ─────────────────────────────────────────────────────────────

function fmtMoney(v, { signed = false } = {}) {
  if (v == null) return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : signed ? "+" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  return `${sign}$${Math.round(abs).toLocaleString()}`;
}

function fmtMoneyExact(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.round(Math.abs(n)).toLocaleString()}`;
}

function timeAgo(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function titleCase(s) {
  if (!s) return "";
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Status badge ───────────────────────────────────────────────────────────

const STATUS_STYLES = {
  fresh: "bg-emerald-50 text-emerald-700 border-emerald-200",
  stale: "bg-amber-50 text-amber-700 border-amber-200",
  pending_enrichment: "bg-slate-50 text-slate-700 border-slate-200",
  data_gap: "bg-amber-50 text-amber-700 border-amber-200",
};

function QuoteStatusBadge({ status }) {
  if (!status) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium",
        STATUS_STYLES[status] || "bg-slate-50 text-slate-700 border-slate-200"
      )}
    >
      {status === "fresh" && <CheckCircle2 className="h-2.5 w-2.5" />}
      {status === "data_gap" && <AlertTriangle className="h-2.5 w-2.5" />}
      {status === "pending_enrichment" && <RefreshCw className="h-2.5 w-2.5" />}
      {titleCase(status)}
    </span>
  );
}

// ─── Data fetch hook ────────────────────────────────────────────────────────

function useQuoteDetail(listingId, enabled) {
  return useQuery({
    queryKey: ["pulse_get_listing_quote_detail", listingId],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc(
        "pulse_get_listing_quote_detail",
        { p_listing_id: listingId }
      );
      if (error) throw error;
      return data;
    },
    enabled: Boolean(enabled && listingId),
    staleTime: 60_000,
    retry: 1,
  });
}

// ─── Main content panel ────────────────────────────────────────────────────

function ProvenancePanel({ listingId, open, onOpenEntity }) {
  const [showRaw, setShowRaw] = useState(false);
  const { data, isLoading, isError, error, refetch } = useQuoteDetail(
    listingId,
    open
  );

  if (isLoading) return <ProvenanceSkeleton />;
  if (isError) {
    return (
      <div className="space-y-2 p-1">
        <div className="flex items-center gap-2 text-amber-700 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>Quote detail failed to load.</span>
        </div>
        {error?.message && (
          <div className="text-[10px] text-muted-foreground font-mono break-words">
            {error.message}
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => refetch()}
        >
          <RefreshCw className="h-3 w-3" />
          Retry
        </Button>
      </div>
    );
  }
  if (!data) return null;

  const {
    listing = {},
    classification = {},
    tier_resolution = null,
    pricing = null,
    quality_flags = {},
    provenance = {},
  } = data || {};

  const mathLines = pricing?.math_lines || [];
  const evaluation = classification?.evaluation || [];

  const firedRuleIdx = evaluation.findIndex((e) => e.fired);
  const status = quality_flags?.quote_status;

  return (
    <div className="space-y-3 text-xs">
      {/* ── Header: address + status ─────────────────────────────────── */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-sm truncate">
            {listing.address || "—"}
          </div>
          <div className="text-muted-foreground truncate">
            {[listing.suburb, listing.postcode].filter(Boolean).join(" ") ||
              "—"}
            {listing.agent_name && (
              <>
                <span className="mx-1">·</span>
                {listing.agent_name}
              </>
            )}
          </div>
        </div>
        <QuoteStatusBadge status={status} />
      </div>

      {/* ── Quality warning chips ───────────────────────────────────── */}
      <QualityChips flags={quality_flags} />

      {/* ── Evidence ─────────────────────────────────────────────────── */}
      <Section icon={Camera} title="Evidence">
        <div className="grid grid-cols-3 gap-1.5">
          <EvidenceChip
            label="Photos"
            value={listing.photo_count ?? "—"}
            hint={quality_flags.photos_capped_at_34 ? "capped at 34" : null}
          />
          <EvidenceChip
            label="Floorplan"
            value={listing.has_floorplan ? "Yes" : "No"}
            active={listing.has_floorplan}
          />
          <EvidenceChip
            label="Video"
            value={listing.has_video ? "Yes" : "No"}
            active={listing.has_video}
          />
        </div>
        {(listing.asking_price_numeric || listing.price_text) && (
          <div className="mt-1.5 flex items-center gap-1 text-muted-foreground">
            <span>Asking:</span>
            <span className="font-medium text-foreground">
              {listing.asking_price_numeric
                ? fmtMoneyExact(listing.asking_price_numeric)
                : listing.price_text || "—"}
            </span>
          </div>
        )}
      </Section>

      {/* ── Classification ──────────────────────────────────────────── */}
      <Section icon={Tag} title="Classification">
        <div className="mb-1 flex items-center gap-1.5">
          <span className="text-muted-foreground">Resolved:</span>
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] h-5 font-medium",
              classification.resolved_package_name === "UNCLASSIFIABLE"
                ? "bg-amber-50 text-amber-700 border-amber-200"
                : "bg-blue-50 text-blue-700 border-blue-200"
            )}
          >
            {classification.resolved_package_name || "—"}
          </Badge>
        </div>
        <div className="space-y-0.5">
          {evaluation.map((rule, idx) => (
            <RuleRow key={rule.rule} rule={rule} isFired={idx === firedRuleIdx} />
          ))}
        </div>
      </Section>

      {/* ── Tier ─────────────────────────────────────────────────────── */}
      {tier_resolution && (
        <Section icon={Target} title="Tier">
          <div className="flex items-center gap-1.5 mb-1">
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] h-5 font-medium capitalize",
                tier_resolution.resolved_tier === "premium"
                  ? "bg-purple-50 text-purple-700 border-purple-200"
                  : "bg-slate-50 text-slate-700 border-slate-200"
              )}
            >
              {tier_resolution.resolved_tier}
            </Badge>
            <span className="text-muted-foreground">
              via <span className="font-mono text-[10px]">{tier_resolution.tier_source}</span>
            </span>
          </div>
          <TierEvidence
            source={tier_resolution.tier_source}
            evidence={tier_resolution.evidence || {}}
            onOpenEntity={onOpenEntity}
          />
        </Section>
      )}

      {/* ── Pricing receipt ──────────────────────────────────────────── */}
      {pricing && (
        <Section icon={Calculator} title="Pricing">
          <div className="flex items-center gap-1.5 mb-1.5 text-muted-foreground">
            <span>Method:</span>
            <span className="font-mono text-[10px] text-foreground">
              {pricing.pricing_method}
            </span>
          </div>
          <Receipt lines={mathLines} />
          <PricingSource
            method={pricing.pricing_method}
            source={pricing.source || {}}
            onOpenEntity={onOpenEntity}
          />
        </Section>
      )}

      {/* ── Drill ────────────────────────────────────────────────────── */}
      <Section icon={LinkIcon} title="Drill">
        <div className="flex flex-wrap gap-1.5">
          {listing.source_url && (
            <DrillLink
              icon={ExternalLink}
              label="REA listing"
              onClick={() =>
                window.open(listing.source_url, "_blank", "noopener,noreferrer")
              }
            />
          )}
          {listing.agency_pulse_id && (
            <DrillLink
              icon={Building2}
              label={listing.agency_name || "Agency"}
              onClick={() => {
                if (onOpenEntity) {
                  onOpenEntity({
                    type: "pulse_agency",
                    id: listing.agency_pulse_id,
                  });
                }
              }}
              disabled={!onOpenEntity}
            />
          )}
          {listing.agent_pulse_id && (
            <DrillLink
              icon={ChevronRight}
              label={listing.agent_name || "Agent"}
              onClick={() => {
                if (onOpenEntity) {
                  onOpenEntity({
                    type: "pulse_agent",
                    id: listing.agent_pulse_id,
                  });
                }
              }}
              disabled={!onOpenEntity}
            />
          )}
        </div>
      </Section>

      {/* ── Provenance footer ────────────────────────────────────────── */}
      <div className="pt-2 border-t text-[10px] text-muted-foreground space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span>
            Computed {timeAgo(provenance.computed_at)} · engine{" "}
            {provenance.engine_version || "?"}
          </span>
          <button
            onClick={() => setShowRaw((v) => !v)}
            className="hover:text-foreground transition-colors underline decoration-dotted"
          >
            {showRaw ? "Hide" : "View"} raw cascade
          </button>
        </div>
        {showRaw && (
          <pre className="mt-1 p-2 rounded bg-slate-50 border border-slate-200 text-[9px] leading-snug text-slate-700 overflow-x-auto max-h-40">
            {JSON.stringify(provenance.raw_cascade_log || [], null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function Section({ icon: Icon, title, children }) {
  return (
    <div>
      <div className="flex items-center gap-1 font-semibold text-[11px] uppercase tracking-wide text-slate-600 mb-1">
        {Icon && <Icon className="h-3 w-3" />}
        {title}
      </div>
      {children}
    </div>
  );
}

function EvidenceChip({ label, value, active, hint }) {
  return (
    <div
      className={cn(
        "rounded border px-1.5 py-1 leading-tight",
        active ? "bg-blue-50 border-blue-200" : "bg-slate-50 border-slate-200"
      )}
    >
      <div className="text-[9px] uppercase text-muted-foreground">{label}</div>
      <div className="font-semibold text-xs">{value}</div>
      {hint && (
        <div className="text-[9px] text-amber-700 mt-0.5">{hint}</div>
      )}
    </div>
  );
}

function RuleRow({ rule, isFired }) {
  const { rule: name, fired, reason } = rule;
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 rounded px-1.5 py-1 text-[11px]",
        isFired
          ? "bg-amber-50 border border-amber-200"
          : "bg-transparent"
      )}
    >
      <div className="mt-0.5 shrink-0">
        {fired ? (
          <CheckCircle2 className="h-3 w-3 text-amber-700" />
        ) : (
          <XCircle className="h-3 w-3 text-slate-300" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "font-medium",
            isFired ? "text-amber-900" : "text-slate-700"
          )}
        >
          {name}
        </div>
        {reason && (
          <div className="text-muted-foreground text-[10px] leading-snug">
            {reason}
          </div>
        )}
      </div>
    </div>
  );
}

function TierEvidence({ source, evidence, onOpenEntity }) {
  if (!source) return null;

  // Matrix evidence
  if (source === "matrix_agency" || source === "matrix_agent") {
    const entityType = source === "matrix_agency" ? "agency" : "agent";
    const clickable = !!(onOpenEntity && evidence.entity_id);
    return (
      <div className="text-muted-foreground space-y-0.5">
        <div className="flex items-center gap-1">
          <Building2 className="h-3 w-3" />
          {clickable ? (
            <button
              onClick={() =>
                onOpenEntity({ type: entityType, id: evidence.entity_id })
              }
              className="font-medium text-foreground truncate hover:underline"
            >
              {evidence.entity_name || "—"}
            </button>
          ) : (
            <span className="font-medium text-foreground truncate">
              {evidence.entity_name || "—"}
            </span>
          )}
        </div>
        {evidence.default_tier && (
          <div className="pl-4">
            default_tier:{" "}
            <span className="text-foreground capitalize">
              {evidence.default_tier}
            </span>
          </div>
        )}
      </div>
    );
  }

  // Proximity evidence
  if (source?.startsWith("proximity_")) {
    const clickable = !!(onOpenEntity && evidence.project_id);
    return (
      <div className="text-muted-foreground space-y-0.5">
        <div className="flex items-start gap-1">
          <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
          {clickable ? (
            <button
              onClick={() =>
                onOpenEntity({ type: "project", id: evidence.project_id })
              }
              className="text-foreground leading-snug hover:underline text-left"
            >
              {evidence.project_address || "—"}
            </button>
          ) : (
            <span className="text-foreground leading-snug">
              {evidence.project_address || "—"}
            </span>
          )}
        </div>
        <div className="pl-4 flex flex-wrap gap-x-2 gap-y-0.5">
          {evidence.project_pricing_tier && (
            <span>
              tier:{" "}
              <span className="text-foreground capitalize">
                {evidence.project_pricing_tier}
              </span>
            </span>
          )}
          {evidence.distance_km != null && (
            <span>
              distance:{" "}
              <span className="text-foreground">
                {Number(evidence.distance_km).toFixed(2)} km
              </span>
            </span>
          )}
          <span>
            package match:{" "}
            <span className="text-foreground">
              {evidence.package_id_match ? "yes" : "no"}
            </span>
          </span>
        </div>
      </div>
    );
  }

  // Default std fallback
  if (source === "default_std") {
    return (
      <div className="flex items-start gap-1 text-muted-foreground">
        <Info className="h-3 w-3 mt-0.5 shrink-0" />
        <span className="italic leading-snug">{evidence.reason || "no nearby data"}</span>
      </div>
    );
  }

  return null;
}

function Receipt({ lines = [] }) {
  if (!lines.length) {
    return (
      <div className="text-muted-foreground italic">No receipt lines.</div>
    );
  }
  return (
    <table className="w-full text-[11px] tabular-nums">
      <tbody>
        {lines.map((ln, i) => {
          const isTotal = !!ln.total;
          const isNegative = Number(ln.amount) < 0;
          return (
            <tr
              key={i}
              className={cn(
                isTotal && "border-t-2 border-double border-slate-300 font-semibold",
                !isTotal && i > 0 && "border-t border-slate-100"
              )}
            >
              <td
                className={cn(
                  "py-1 pr-2",
                  isTotal && "text-foreground",
                  !isTotal && "text-slate-600"
                )}
              >
                {ln.label}
              </td>
              <td
                className={cn(
                  "py-1 text-right",
                  isNegative && "text-emerald-700",
                  isTotal && "text-foreground"
                )}
              >
                {fmtMoney(ln.amount, { signed: isNegative })}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PricingSource({ method, source = {}, onOpenEntity }) {
  if (!method || !source || Object.keys(source).length === 0) return null;

  if (method === "agency_matrix") {
    const clickable = !!(onOpenEntity && source.entity_id);
    return (
      <div className="mt-1.5 text-[10px] text-muted-foreground space-y-0.5">
        <div className="flex items-center gap-1">
          <Building2 className="h-3 w-3 shrink-0" />
          {clickable ? (
            <button
              onClick={() =>
                onOpenEntity({ type: source.entity_type || "agency", id: source.entity_id })
              }
              className="font-medium text-foreground truncate hover:underline"
            >
              {source.entity_name || "—"}
            </button>
          ) : (
            <span className="font-medium text-foreground truncate">
              {source.entity_name || "—"}
            </span>
          )}
        </div>
        <div className="pl-4 flex flex-wrap gap-x-2">
          {source.blanket_enabled && (
            <span>
              blanket{" "}
              <span className="text-foreground">
                pkg {source.blanket_pkg_pct}% / prod {source.blanket_prod_pct}%
              </span>
            </span>
          )}
          {source.has_package_override && <span>pkg override</span>}
          {source.has_product_override && <span>prod override</span>}
        </div>
      </div>
    );
  }

  if (method?.startsWith("proximity_")) {
    const clickable = !!(onOpenEntity && source.project_id);
    return (
      <div className="mt-1.5 text-[10px] text-muted-foreground space-y-0.5">
        <div className="flex items-start gap-1">
          <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
          {clickable ? (
            <button
              onClick={() =>
                onOpenEntity({ type: "project", id: source.project_id })
              }
              className="text-foreground leading-snug truncate hover:underline text-left"
            >
              {source.project_address || "—"}
            </button>
          ) : (
            <span className="text-foreground leading-snug truncate">
              {source.project_address || "—"}
            </span>
          )}
        </div>
        <div className="pl-4 flex flex-wrap gap-x-2">
          {source.project_calculated_price != null && (
            <span>
              project price:{" "}
              <span className="text-foreground">
                {fmtMoneyExact(source.project_calculated_price)}
              </span>
            </span>
          )}
          {source.project_pricing_tier && (
            <span>
              tier:{" "}
              <span className="text-foreground capitalize">
                {source.project_pricing_tier}
              </span>
            </span>
          )}
        </div>
      </div>
    );
  }

  if (method === "global_default") {
    return (
      <div className="mt-1.5 text-[10px] text-muted-foreground italic">
        {source.note || "Using global package default."}
      </div>
    );
  }

  if (method === "item_sum_unclassifiable" && Array.isArray(source.items)) {
    return (
      <div className="mt-1.5 text-[10px] text-muted-foreground">
        <div className="font-medium mb-0.5">Item sum:</div>
        <ul className="space-y-0.5 pl-2">
          {source.items.map((it, i) => (
            <li key={i}>
              {it.product}
              {it.qty != null && <> × {it.qty}</>}
              {it.subtotal != null && (
                <>
                  {" "}= <span className="text-foreground">{fmtMoneyExact(it.subtotal)}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return null;
}

function QualityChips({ flags = {} }) {
  const chips = [];
  if (flags.address_hidden) chips.push({ label: "Address hidden", hint: "REA withheld address on listing" });
  if (flags.data_gap_flag) chips.push({ label: "Data gap", hint: "No comparable projects within 50km — fell to std default" });
  if (flags.photos_capped_at_34) chips.push({ label: "Photos capped", hint: "REA cap at 34; true count may be higher" });
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c.label}
          title={c.hint}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-700 text-[10px]"
        >
          <AlertTriangle className="h-2.5 w-2.5" />
          {c.label}
        </span>
      ))}
    </div>
  );
}

function DrillLink({ icon: Icon, label, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors",
        disabled
          ? "border-slate-200 text-slate-400 cursor-not-allowed"
          : "border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300"
      )}
    >
      {Icon && <Icon className="h-2.5 w-2.5" />}
      <span className="truncate max-w-[140px]">{label}</span>
    </button>
  );
}

function ProvenanceSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
      <div className="pt-2 space-y-1.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-4/6" />
      </div>
      <div className="pt-2 space-y-1.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    </div>
  );
}

// ─── Main export: QuoteProvenance ──────────────────────────────────────────

export function QuoteProvenance({
  listingId,
  children,
  mode = "hover",
  placement = "bottom",
  align = "start",
  onOpenEntity,
  className,
}) {
  const [open, setOpen] = useState(false);
  const [clickOpen, setClickOpen] = useState(false);

  // No listing id? Just render children without wrapping — component is a no-op.
  if (!listingId) return <>{children}</>;

  const contentCls = cn(
    "w-[min(480px,92vw)] max-w-[480px] p-3",
    className
  );

  const panel = (
    <ProvenancePanel
      listingId={listingId}
      open={mode === "click" ? clickOpen : open || clickOpen}
      onOpenEntity={onOpenEntity}
    />
  );

  // CLICK-only mode (use Popover)
  if (mode === "click") {
    return (
      <Popover open={clickOpen} onOpenChange={setClickOpen}>
        <PopoverTrigger asChild>
          <span className="cursor-pointer inline-flex">{children}</span>
        </PopoverTrigger>
        <PopoverContent
          side={placement === "auto" ? "bottom" : placement}
          align={align}
          className={contentCls}
        >
          {panel}
        </PopoverContent>
      </Popover>
    );
  }

  // HOVER-only mode
  if (mode === "hover") {
    return (
      <HoverCard open={open} onOpenChange={setOpen} openDelay={150} closeDelay={80}>
        <HoverCardTrigger asChild>
          <span className="cursor-help inline-flex">{children}</span>
        </HoverCardTrigger>
        <HoverCardContent
          side={placement === "auto" ? "bottom" : placement}
          align={align}
          className={contentCls}
        >
          {panel}
        </HoverCardContent>
      </HoverCard>
    );
  }

  // BOTH mode — wrap in hover-card, but clicking opens popover-style (which
  // stays open). Implementation: nested Popover inside the trigger so click
  // "pins" the panel while hover still previews.
  return (
    <HoverCard open={open || clickOpen} onOpenChange={setOpen} openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        <span
          className="cursor-pointer inline-flex"
          onClick={(e) => {
            e.stopPropagation();
            setClickOpen((v) => !v);
          }}
        >
          {children}
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        side={placement === "auto" ? "bottom" : placement}
        align={align}
        className={contentCls}
        onMouseLeave={() => {
          // Only auto-close via hover when NOT pinned by click
          if (!clickOpen) setOpen(false);
        }}
      >
        {panel}
        {clickOpen && (
          <div className="pt-1.5 border-t mt-2 flex justify-end">
            <button
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                setClickOpen(false);
                setOpen(false);
              }}
            >
              Close
            </button>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

// ─── Convenience wrappers ──────────────────────────────────────────────────

/**
 * <QuoteAmount listingId={uuid} amount={n} />
 *   Renders "$X" wrapped in QuoteProvenance (hover mode). The canonical way
 *   to show an engine-computed price anywhere in the UI.
 */
export function QuoteAmount({
  listingId,
  amount,
  className,
  mode = "hover",
  placement = "bottom",
  align = "start",
  onOpenEntity,
}) {
  return (
    <QuoteProvenance
      listingId={listingId}
      mode={mode}
      placement={placement}
      align={align}
      onOpenEntity={onOpenEntity}
    >
      <span
        className={cn(
          "font-semibold tabular-nums underline decoration-dotted decoration-slate-300 underline-offset-2 hover:decoration-slate-500",
          className
        )}
      >
        {fmtMoneyExact(amount)}
      </span>
    </QuoteProvenance>
  );
}

/**
 * <PackageBadge listingId={uuid} name={livePackageName} />
 *   Shows a package badge wrapped in QuoteProvenance. The `name` value comes
 *   from the engine substrate (which sources it from the live `packages`
 *   catalog) — Wave 7 P1-11.b validates the name against useActivePackages()
 *   and tags any drift with a legacy indicator so ops can spot stale data.
 */
export function PackageBadge({
  listingId,
  name,
  className,
  mode = "hover",
  placement = "bottom",
  align = "start",
  onOpenEntity,
}) {
  // Wave 7 P1-11.b: subscribe to the live `packages` table so the badge can
  // surface drift between the engine substrate and the current catalog.
  // Per Joseph's architectural correction (2026-04-27): packages must NEVER
  // be hardcoded as the authoritative source of names in the frontend.
  const { names: livePackageNames } = useActivePackages();
  const unclassifiable = name === "UNCLASSIFIABLE";
  const isLegacy =
    !!name &&
    !unclassifiable &&
    livePackageNames.length > 0 &&
    !livePackageNames.includes(name);
  return (
    <QuoteProvenance
      listingId={listingId}
      mode={mode}
      placement={placement}
      align={align}
      onOpenEntity={onOpenEntity}
    >
      <Badge
        variant="outline"
        className={cn(
          "text-[10px] h-5 font-medium cursor-help",
          unclassifiable
            ? "bg-amber-50 text-amber-700 border-amber-200"
            : "bg-blue-50 text-blue-700 border-blue-200",
          isLegacy && "border-dashed",
          className
        )}
        title={isLegacy ? `${name} (not in live packages — legacy/renamed)` : undefined}
      >
        {name || "—"}
      </Badge>
    </QuoteProvenance>
  );
}

export default QuoteProvenance;
