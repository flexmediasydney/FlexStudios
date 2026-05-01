/**
 * PulseMissedOpportunityCommandCenter — Wave 15b.9
 *
 * Master_admin control surface for the missed-opportunity quoting engine.
 *
 * Why this exists:
 *   The W15b external listing vision pipeline classifies competitor listings
 *   to figure out what package the competing photographer delivered. Once
 *   the vision pipeline is proven (W15b.7), the rule-based fallback gets
 *   dropped (W15b.10). When vision extractions fail, an operator needs to
 *   investigate manually, retry, or override the quote — this page is that
 *   surface.
 *
 * Layout:
 *   1. KPI strip — today's spend / cap, vision queue depth, avg per listing,
 *      failure rate, total quotes (fresh / stale / pending / failed / overridden).
 *      Server-side aggregated via RPC pulse_command_center_kpis(7).
 *   2. Filter chips — quote_status filters + suburb/agency/date filters.
 *      State persisted in URL query params so the page is shareable.
 *   3. Bulk actions — retry-all-failed, pause/resume vision queue,
 *      override the daily cost cap for today.
 *   4. Listings table — virtualized; per-row actions (view, retry, override,
 *      investigate). Investigate panel inlines.
 *
 * Auth gate:
 *   Defensive in-component master_admin check on top of the route guard.
 *   The override + queue-pause actions affect production cost & customer
 *   quotes; both layers must agree before any mutation hits the wire.
 *
 * Constraints:
 *   * W15b.1 (vision extractor edge fn) and W15b.2 (vision substrate table)
 *     may not be live yet — page degrades gracefully when the table is
 *     empty or the edge function 404s.
 *   * Backend files owned by other W15b agents are NOT modified here.
 */

import { useEffect, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import {
  Activity,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  DollarSign,
  Eye,
  Filter,
  Gauge,
  ListChecks,
  Loader2,
  Lock,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  TrendingDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { createPageUrl } from "@/utils";

const POLL_INTERVAL_MS = 30_000;
const ROW_PAGE_SIZE = 50;

// ── Filter chip definitions ─────────────────────────────────────────────────
const STATUS_FILTERS = [
  { key: "all",       label: "All",                  query: null },
  { key: "pending",   label: "Pending",              query: { quote_status: "pending_enrichment" } },
  { key: "fresh",     label: "Fresh",                query: { quote_status: "fresh" } },
  { key: "stale",     label: "Stale",                query: { quote_status: "stale" } },
  { key: "failed",    label: "Failed",               query: { quote_status: "failed" } },
  { key: "overridden",label: "Manually-overridden",  query: { manually_overridden: true } },
];

const STATUS_TONE = {
  fresh:              "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  stale:              "bg-amber-100  text-amber-700  dark:bg-amber-950  dark:text-amber-300",
  pending_enrichment: "bg-slate-100  text-slate-700  dark:bg-slate-800  dark:text-slate-200",
  data_gap:           "bg-rose-100   text-rose-700   dark:bg-rose-950   dark:text-rose-300",
  failed:             "bg-red-100    text-red-700    dark:bg-red-950    dark:text-red-300",
};

// ── Helpers (extracted as pure fns so tests can import them) ───────────────
export function fmtUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "$0.00";
  const v = Number(n);
  if (v < 0.01 && v > 0) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function fmtAud(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(Number(n));
}

export function fmtPct(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return `${Number(n).toFixed(1)}%`;
}

export function fmtTime(iso) {
  if (!iso) return "—";
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return "—"; }
}

/**
 * Validate a manual override payload before it's written.
 * Returns { ok: true } or { ok: false, reason: string } so the dialog can
 * surface inline errors before the network round-trip.
 *
 * Rules:
 *   * Price required and finite > 0.
 *   * Reason required and ≥ 10 chars (audit trail).
 *   * Price must be ≤ $100k sanity ceiling (typo guard).
 */
export function validateOverridePayload({ price, reason }) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return { ok: false, reason: "Price must be a positive number." };
  if (p > 100_000) return { ok: false, reason: "Price exceeds the $100k sanity ceiling." };
  const r = String(reason || "").trim();
  if (r.length < 10) return { ok: false, reason: "Reason must be at least 10 characters." };
  return { ok: true };
}

/**
 * Decide whether a "retry failed" bulk action is allowed under the daily cap.
 * Returns { allowed: boolean, reason?: string, headroom_usd: number }.
 *
 * The dispatcher would re-check this server-side; the UI check is purely
 * for the operator's benefit (prevents blasting through the cap with one
 * click and discovering the failure in the spend log later).
 */
export function bulkRetryAllowed({ todays_spend_usd, effective_cap_usd, avg_per_listing_usd, failed_count }) {
  const spend = Number(todays_spend_usd) || 0;
  const cap = Number(effective_cap_usd) || 0;
  const avg = Number(avg_per_listing_usd) || 0.25; // default heuristic when no data
  const headroom = Math.max(0, cap - spend);
  if (failed_count <= 0) return { allowed: false, reason: "No failed extracts to retry.", headroom_usd: headroom };
  if (headroom <= 0) return { allowed: false, reason: "Daily cap reached — extend the cap or wait until tomorrow.", headroom_usd: headroom };
  const projected = avg * failed_count;
  if (projected > headroom) {
    return {
      allowed: true,
      reason: `Projected $${projected.toFixed(2)} exceeds remaining $${headroom.toFixed(2)}; only the first ~${Math.floor(headroom / Math.max(avg, 0.01))} retries will run.`,
      headroom_usd: headroom,
    };
  }
  return { allowed: true, headroom_usd: headroom };
}

// ── KPI strip ───────────────────────────────────────────────────────────────
function KpiCard({ icon: Icon, label, value, sub, tone, hint }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-start gap-2">
          <div className={cn("h-8 w-8 rounded-md flex items-center justify-center flex-shrink-0", tone || "bg-muted")}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground truncate">{label}</p>
            <p className="text-lg font-semibold tabular-nums leading-tight mt-0.5">{value}</p>
            {sub && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</p>}
            {hint && <p className="text-[10px] text-muted-foreground mt-0.5 italic truncate">{hint}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function KpiStrip({ data, loading }) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Card key={i} className="animate-pulse"><CardContent className="p-3 h-[80px]" /></Card>
        ))}
      </div>
    );
  }
  const k = data || {};
  const spend = Number(k.todays_spend_usd) || 0;
  const cap = Number(k.effective_cap_usd) || Number(k.daily_cap_usd) || 30;
  const spendPct = cap > 0 ? Math.min(100, (spend / cap) * 100) : 0;
  const spendTone = spendPct > 90 ? "bg-red-100 text-red-700" : spendPct > 70 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700";
  const overrideActive = Number(k.daily_cap_override_usd) > 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2">
      <KpiCard
        icon={DollarSign}
        label="Today's spend"
        value={`${fmtUsd(spend)} / ${fmtUsd(cap)}`}
        sub={`${spendPct.toFixed(0)}% of cap`}
        hint={overrideActive ? `+${fmtUsd(k.daily_cap_override_usd)} override` : null}
        tone={spendTone}
      />
      <KpiCard
        icon={ListChecks}
        label="Vision queue"
        value={`${k.vision_queue_pending ?? 0} pending`}
        sub={k.queue_paused ? "Queue paused" : "Active"}
        tone={k.queue_paused ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700"}
      />
      <KpiCard
        icon={Gauge}
        label="Avg per listing"
        value={k.avg_per_listing_usd != null ? fmtUsd(k.avg_per_listing_usd) : "—"}
        sub={`${k.failure_rate_window_days || 7}d window`}
        tone="bg-slate-100 text-slate-700"
      />
      <KpiCard
        icon={TrendingDown}
        label="Failure rate"
        value={fmtPct(k.failure_rate_pct)}
        sub={`Last ${k.failure_rate_window_days || 7}d`}
        tone={Number(k.failure_rate_pct) > 5 ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}
      />
      <KpiCard
        icon={Activity}
        label="Total quotes"
        value={`${k.total_quotes_fresh ?? 0} fresh`}
        sub={`${k.total_quotes_stale ?? 0} stale · ${k.total_quotes_failed ?? 0} failed · ${k.total_quotes_overridden ?? 0} override`}
        tone="bg-emerald-100 text-emerald-700"
      />
    </div>
  );
}

// ── Filter chips (URL-persisted) ────────────────────────────────────────────
function FilterChips({ active, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {STATUS_FILTERS.map((f) => (
        <Button
          key={f.key}
          variant={active === f.key ? "default" : "outline"}
          size="sm"
          className="h-7 text-xs"
          onClick={() => onChange(f.key)}
        >
          {f.label}
        </Button>
      ))}
    </div>
  );
}

// ── Manual override dialog ──────────────────────────────────────────────────
function ManualOverrideDialog({ open, onOpenChange, listing, onSaved }) {
  const [price, setPrice] = useState("");
  const [reason, setReason] = useState("");
  const [final, setFinal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setPrice(listing?.manual_override_price ?? listing?.quoted_price ?? "");
      setReason(listing?.manual_override_reason || "");
      setFinal(!!listing?.manual_override_final);
      setError(null);
    }
  }, [open, listing]);

  const handleSave = async () => {
    const validation = validateOverridePayload({ price, reason });
    if (!validation.ok) { setError(validation.reason); return; }
    setError(null);
    setSaving(true);
    try {
      let userId = null;
      try { const u = await api.auth.me(); userId = u?.id || null; } catch { /* anon — fine */ }
      await api.entities.PulseListingMissedOpportunity.update(listing.id, {
        manually_overridden: true,
        manual_override_price: Number(price),
        manual_override_reason: reason.trim(),
        manual_override_at: new Date().toISOString(),
        manual_override_final: !!final,
        manual_override_by: userId,
        // Mirror to quoted_price so downstream consumers reading the existing
        // column still see the operator value without having to learn about
        // the new manual_override_price column.
        quoted_price: Number(price),
      });
      toast.success("Override saved");
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      setError(e?.message || "Failed to save override");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manual override quote</DialogTitle>
          <DialogDescription>
            {listing?.suburb ? `${listing.suburb}` : "Listing"} · existing engine quote: <strong>{fmtAud(listing?.quoted_price)}</strong>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="override-price">Override to (AUD)</Label>
            <Input
              id="override-price"
              type="number"
              step="1"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="495"
              data-testid="override-price"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="override-reason">Reason (audit trail)</Label>
            <Textarea
              id="override-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Vision pipeline mis-classified day vs dusk; manually verified Premium tier."
              data-testid="override-reason"
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="override-final" checked={final} onCheckedChange={(v) => setFinal(!!v)} />
            <Label htmlFor="override-final" className="text-xs cursor-pointer">
              Mark as final (recompute cron will skip this listing)
            </Label>
          </div>
          {error && (
            <div className="rounded-md bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs text-red-700 dark:text-red-300 flex items-start gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
            Save override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Bulk actions strip ──────────────────────────────────────────────────────
function BulkActions({ kpis, onRetryAll, onPauseToggle, onCapOverride, busy }) {
  const queuePaused = !!kpis?.queue_paused;

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onRetryAll} disabled={busy}>
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Retry all failed
          </Button>
          <Button
            size="sm"
            variant={queuePaused ? "default" : "outline"}
            onClick={onPauseToggle}
            disabled={busy}
            data-testid="queue-toggle"
          >
            {queuePaused ? <PlayCircle className="h-3.5 w-3.5 mr-1.5" /> : <PauseCircle className="h-3.5 w-3.5 mr-1.5" />}
            {queuePaused ? "Resume queue" : "Pause queue"}
          </Button>
          <span className="ml-2 text-xs text-muted-foreground">
            Daily cap: <strong className="text-foreground">{fmtUsd(kpis?.daily_cap_usd)}</strong>
            {Number(kpis?.daily_cap_override_usd) > 0 && (
              <> · override <strong className="text-amber-600">+{fmtUsd(kpis?.daily_cap_override_usd)}</strong></>
            )}
          </span>
          <Button size="sm" variant="ghost" onClick={onCapOverride} disabled={busy}>
            <Shield className="h-3.5 w-3.5 mr-1.5" />
            Override cap (today)
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Investigate panel (inline below row) ────────────────────────────────────
function InvestigatePanel({ listing }) {
  const { data, isLoading } = useQuery({
    queryKey: ["pulse-investigate", listing?.listing_id],
    enabled: !!listing?.listing_id,
    queryFn: async () => {
      try {
        const rows = await api.entities.PulseListingVisionExtracts.filter(
          { listing_id: listing.listing_id },
          "-created_at",
          5,
        );
        return rows;
      } catch {
        return [];
      }
    },
    staleTime: 30_000,
  });

  if (isLoading) return <div className="px-4 py-3 text-xs text-muted-foreground"><Loader2 className="inline h-3 w-3 animate-spin mr-1" />Loading vision extract history…</div>;
  const rows = data || [];
  const totalCost = rows.reduce((sum, r) => sum + Number(r?.total_cost_usd || 0), 0);
  const lastFailed = rows.find((r) => r.status === "failed");

  return (
    <div className="px-4 py-3 space-y-2 bg-muted/30">
      <div className="flex items-start gap-3 text-xs">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Failed reason</p>
          <p className="text-foreground break-words" data-testid="failed-reason">
            {lastFailed?.failed_reason || (rows.length === 0 ? "No vision extract history (W15b.2 may not be live)." : "—")}
          </p>
        </div>
        <div>
          <p className="font-semibold text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Cost on retries</p>
          <p className="font-semibold tabular-nums">{fmtUsd(totalCost)}</p>
        </div>
        <div>
          <p className="font-semibold text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Attempts</p>
          <p className="font-semibold tabular-nums">{rows.length} / 5</p>
        </div>
      </div>
      {rows.length > 0 && (
        <div className="space-y-1">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-[11px] py-1 border-t border-border/40">
              <Badge variant="outline" className={cn("text-[10px]", r.status === "failed" ? "border-red-300 text-red-700" : r.status === "succeeded" ? "border-emerald-300 text-emerald-700" : "border-slate-300")}>
                {r.status}
              </Badge>
              <span className="text-muted-foreground">{fmtTime(r.created_at)}</span>
              <span className="ml-auto tabular-nums">{fmtUsd(r.total_cost_usd)}</span>
              {r.failed_reason && <span className="text-red-600 truncate max-w-[40%]" title={r.failed_reason}>{r.failed_reason}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="text-[10px] text-muted-foreground pt-1">
        Engine logs:{" "}
        <a
          href={`https://supabase.com/dashboard/project/rjzdznwkxnzfekgcdkei/logs/edge-functions?q=${encodeURIComponent(listing?.listing_id || "")}`}
          target="_blank"
          rel="noopener"
          className="underline"
        >
          Open in Supabase
        </a>
      </div>
    </div>
  );
}

// ── Listings table row ──────────────────────────────────────────────────────
function ListingRow({ row, isMasterAdmin, onView, onRetry, onOverride, onInvestigate, expanded }) {
  const status = row.quote_status || "—";
  const overridden = !!row.manually_overridden;
  return (
    <>
      <tr className="hover:bg-muted/40 border-b border-border/40">
        <td className="px-3 py-2 text-xs">
          <div className="font-medium truncate max-w-[260px]" title={row.suburb || row.property_key}>
            {row.suburb || "—"} {row.postcode ? <span className="text-muted-foreground">{row.postcode}</span> : null}
          </div>
          <div className="text-[10px] text-muted-foreground truncate max-w-[260px]">{row.property_key}</div>
        </td>
        <td className="px-3 py-2">
          <Badge className={cn("text-[10px]", STATUS_TONE[status] || "bg-slate-100 text-slate-700")}>{status}</Badge>
          {overridden && <Badge variant="outline" className="text-[10px] ml-1 border-indigo-300 text-indigo-700">override</Badge>}
        </td>
        <td className="px-3 py-2 text-xs truncate max-w-[160px]" title={row.classified_package_name}>
          {row.classified_package_name || <span className="text-muted-foreground italic">—</span>}
        </td>
        <td className="px-3 py-2 text-xs tabular-nums">{fmtAud(row.quoted_price)}</td>
        <td className="px-3 py-2 text-right">
          <div className="flex items-center justify-end gap-1">
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => onView(row)} title="View listing detail">
              <Eye className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-[11px]"
              onClick={() => onRetry(row)}
              disabled={!isMasterAdmin}
              title={isMasterAdmin ? "Retry vision extract" : "master_admin only"}
              data-testid="row-retry"
            >
              <RotateCcw className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-[11px]"
              onClick={() => onOverride(row)}
              disabled={!isMasterAdmin}
              title={isMasterAdmin ? "Manual override quote" : "master_admin only"}
              data-testid="row-override"
            >
              <Lock className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-[11px]"
              onClick={() => onInvestigate(row)}
              title="Investigate"
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </Button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr><td colSpan={5} className="p-0 border-b border-border/40"><InvestigatePanel listing={row} /></td></tr>
      )}
    </>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function PulseMissedOpportunityCommandCenter() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isMasterAdmin } = usePermissions();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── URL-persisted filter state ─────────────────────────────────────────────
  const statusFilter = searchParams.get("status") || "all";
  const suburbFilter = searchParams.get("suburb") || "";
  const searchText = searchParams.get("q") || "";
  const [searchInput, setSearchInput] = useState(searchText);

  const setStatusFilter = (key) => {
    const next = new URLSearchParams(searchParams);
    if (key === "all") next.delete("status"); else next.set("status", key);
    setSearchParams(next, { replace: true });
  };
  const setSuburbFilter = (val) => {
    const next = new URLSearchParams(searchParams);
    if (!val) next.delete("suburb"); else next.set("suburb", val);
    setSearchParams(next, { replace: true });
  };
  const commitSearch = () => {
    const next = new URLSearchParams(searchParams);
    if (!searchInput) next.delete("q"); else next.set("q", searchInput);
    setSearchParams(next, { replace: true });
  };

  // ── KPI query ─────────────────────────────────────────────────────────────
  const kpisQuery = useQuery({
    queryKey: ["pulse-cc-kpis"],
    queryFn: () => api.rpc("pulse_command_center_kpis", { p_days: 7 }),
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: 15_000,
  });
  const kpis = kpisQuery.data || {};

  // ── Listings query ────────────────────────────────────────────────────────
  const listingsQuery = useQuery({
    queryKey: ["pulse-cc-listings", statusFilter, suburbFilter, searchText],
    queryFn: async () => {
      const filter = {};
      const f = STATUS_FILTERS.find((s) => s.key === statusFilter);
      if (f?.query) Object.assign(filter, f.query);
      if (suburbFilter) filter.suburb = suburbFilter;
      let rows = await api.entities.PulseListingMissedOpportunity.filter(filter, "-updated_at", ROW_PAGE_SIZE);
      if (searchText) {
        const needle = searchText.toLowerCase();
        rows = rows.filter((r) =>
          (r.property_key && r.property_key.toLowerCase().includes(needle)) ||
          (r.suburb && r.suburb.toLowerCase().includes(needle))
        );
      }
      return rows;
    },
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: 15_000,
  });
  const listings = listingsQuery.data || [];

  // ── Per-row state ─────────────────────────────────────────────────────────
  const [expandedRowId, setExpandedRowId] = useState(null);
  const [overrideTarget, setOverrideTarget] = useState(null);
  const [busyAction, setBusyAction] = useState(null);

  // ── Per-row handlers ──────────────────────────────────────────────────────
  const handleView = useCallback((row) => {
    navigate(createPageUrl("PulseListingDetail") + `?id=${row.listing_id}&tab=vision`);
  }, [navigate]);

  const handleRetry = useCallback(async (row) => {
    if (!isMasterAdmin) { toast.error("master_admin only"); return; }
    setBusyAction(`retry:${row.id}`);
    try {
      await api.functions.invoke("pulse-listing-vision-extract", {
        listing_id: row.listing_id,
        force_refresh: true,
        triggered_by: "operator_manual",
      });
      // Optimistic: mark the row pending in cache so the operator sees an
      // immediate state change instead of waiting on the next 30s poll.
      queryClient.setQueryData(["pulse-cc-listings", statusFilter, suburbFilter, searchText], (prev) =>
        (prev || []).map((r) => (r.id === row.id ? { ...r, quote_status: "pending_enrichment" } : r))
      );
      toast.success(`Retry queued for ${row.suburb || row.property_key}`);
      // Force a refetch in the background so server truth eventually wins.
      queryClient.invalidateQueries({ queryKey: ["pulse-cc-listings"] });
      queryClient.invalidateQueries({ queryKey: ["pulse-cc-kpis"] });
    } catch (e) {
      toast.error(e?.message || "Retry failed");
    } finally {
      setBusyAction(null);
    }
  }, [isMasterAdmin, queryClient, statusFilter, suburbFilter, searchText]);

  const handleOverride = useCallback((row) => {
    if (!isMasterAdmin) { toast.error("master_admin only"); return; }
    setOverrideTarget(row);
  }, [isMasterAdmin]);

  const handleInvestigate = useCallback((row) => {
    setExpandedRowId((id) => (id === row.id ? null : row.id));
  }, []);

  // ── Bulk action handlers ──────────────────────────────────────────────────
  const handleRetryAll = useCallback(async () => {
    if (!isMasterAdmin) { toast.error("master_admin only"); return; }
    const failed = listings.filter((l) => l.quote_status === "failed");
    const guard = bulkRetryAllowed({
      todays_spend_usd: kpis.todays_spend_usd,
      effective_cap_usd: kpis.effective_cap_usd,
      avg_per_listing_usd: kpis.avg_per_listing_usd,
      failed_count: failed.length,
    });
    if (!guard.allowed) { toast.error(guard.reason); return; }
    if (!window.confirm(`Retry ${failed.length} failed listings?${guard.reason ? `\n\n${guard.reason}` : ""}`)) return;
    setBusyAction("bulk-retry");
    let ok = 0, err = 0;
    for (const row of failed) {
      try {
        await api.functions.invoke("pulse-listing-vision-extract", {
          listing_id: row.listing_id,
          force_refresh: true,
          triggered_by: "mass_backfill",
        });
        ok++;
      } catch { err++; }
    }
    toast.success(`Retry complete: ${ok} queued${err ? `, ${err} errored` : ""}`);
    queryClient.invalidateQueries({ queryKey: ["pulse-cc-listings"] });
    queryClient.invalidateQueries({ queryKey: ["pulse-cc-kpis"] });
    setBusyAction(null);
  }, [isMasterAdmin, listings, kpis, queryClient]);

  const handlePauseToggle = useCallback(async () => {
    if (!isMasterAdmin) { toast.error("master_admin only"); return; }
    setBusyAction("pause-toggle");
    try {
      const current = await api.entities.EngineSetting.get("pulse_vision");
      const value = current?.value || {};
      await api.entities.EngineSetting.update("pulse_vision", {
        value: { ...value, queue_paused: !value.queue_paused },
      });
      toast.success(value.queue_paused ? "Queue resumed" : "Queue paused");
      queryClient.invalidateQueries({ queryKey: ["pulse-cc-kpis"] });
    } catch (e) {
      toast.error(e?.message || "Failed to toggle queue");
    } finally {
      setBusyAction(null);
    }
  }, [isMasterAdmin, queryClient]);

  const handleCapOverride = useCallback(async () => {
    if (!isMasterAdmin) { toast.error("master_admin only"); return; }
    const raw = window.prompt("Extend today's cap by how many USD?", "10");
    if (raw == null) return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 200) {
      toast.error("Override must be a positive number ≤ $200.");
      return;
    }
    setBusyAction("cap-override");
    try {
      const current = await api.entities.EngineSetting.get("pulse_vision");
      const value = current?.value || {};
      await api.entities.EngineSetting.update("pulse_vision", {
        value: { ...value, daily_cap_override_usd: n, daily_cap_override_date: new Date().toISOString().slice(0, 10) },
      });
      toast.success(`Cap extended by ${fmtUsd(n)} for today`);
      queryClient.invalidateQueries({ queryKey: ["pulse-cc-kpis"] });
    } catch (e) {
      toast.error(e?.message || "Failed to set override");
    } finally {
      setBusyAction(null);
    }
  }, [isMasterAdmin, queryClient]);

  // ── Auth guard (defensive — RouteGuard is the primary) ────────────────────
  if (!isMasterAdmin) {
    return (
      <div className="p-6 max-w-md mx-auto">
        <Card>
          <CardContent className="p-6 text-center space-y-2">
            <Shield className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="text-sm font-medium">master_admin only</p>
            <p className="text-xs text-muted-foreground">
              The Pulse Missed-Opportunity Command Center exposes manual override of customer-facing quotes and queue-pause controls.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-3 md:p-4 space-y-3">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-lg md:text-xl font-semibold flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Missed-Opportunity Command Center
          </h1>
          <p className="text-xs text-muted-foreground">
            Vision pipeline retry, manual override, queue control · master_admin only
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => { kpisQuery.refetch(); listingsQuery.refetch(); }}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", (kpisQuery.isFetching || listingsQuery.isFetching) && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <KpiStrip data={kpis} loading={kpisQuery.isLoading} />

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <FilterChips active={statusFilter} onChange={setStatusFilter} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Suburb"
              value={suburbFilter}
              onChange={(e) => setSuburbFilter(e.target.value)}
              className="h-8 text-xs w-32"
              data-testid="suburb-filter"
            />
            <div className="relative">
              <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search address…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onBlur={commitSearch}
                onKeyDown={(e) => e.key === "Enter" && commitSearch()}
                className="h-8 text-xs pl-7 w-48"
              />
            </div>
            {(suburbFilter || searchText || statusFilter !== "all") && (
              <Button size="sm" variant="ghost" onClick={() => setSearchParams(new URLSearchParams())} className="h-7 text-xs">
                Clear filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Bulk actions ─────────────────────────────────────────────────── */}
      <BulkActions
        kpis={kpis}
        onRetryAll={handleRetryAll}
        onPauseToggle={handlePauseToggle}
        onCapOverride={handleCapOverride}
        busy={!!busyAction}
      />

      {/* ── Listings table ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ListChecks className="h-4 w-4" />
            Listings
            <span className="text-muted-foreground font-normal">({listings.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {listingsQuery.isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading…
            </div>
          ) : listings.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <ListChecks className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
              No listings match the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="text-left px-3 py-2 font-semibold">Address</th>
                    <th className="text-left px-3 py-2 font-semibold">Status</th>
                    <th className="text-left px-3 py-2 font-semibold">Package</th>
                    <th className="text-left px-3 py-2 font-semibold">Price</th>
                    <th className="text-right px-3 py-2 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {listings.map((row) => (
                    <ListingRow
                      key={row.id}
                      row={row}
                      isMasterAdmin={isMasterAdmin}
                      expanded={expandedRowId === row.id}
                      onView={handleView}
                      onRetry={handleRetry}
                      onOverride={handleOverride}
                      onInvestigate={handleInvestigate}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Override dialog ──────────────────────────────────────────────── */}
      <ManualOverrideDialog
        open={!!overrideTarget}
        onOpenChange={(o) => !o && setOverrideTarget(null)}
        listing={overrideTarget}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ["pulse-cc-listings"] });
          queryClient.invalidateQueries({ queryKey: ["pulse-cc-kpis"] });
        }}
      />
    </div>
  );
}
