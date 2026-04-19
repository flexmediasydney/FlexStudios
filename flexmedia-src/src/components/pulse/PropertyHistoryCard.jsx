/**
 * PropertyHistoryCard — shows sibling `pulse_listings` rows that share a
 * `property_key` with the current listing. Because REA publishes one listing
 * row per campaign (re-listings, off-the-plan units, sold-then-relisted), a
 * single physical property can generate 2-N concurrent or serial listings.
 * Clustering them here gives the user the "everything that ever happened at
 * this address" view without having to navigate to PropertyDetails.
 *
 * Placement:
 *   - <ListingSlideout> (PulseListings.jsx): near the bottom, after agent/
 *     agency + external links.
 *   - Potentially <PropertyDetails> down the road if we decide the dossier
 *     view should mirror the slideout (currently it renders its own
 *     ListingsTab component which does the same job).
 *
 * Data: direct PostgREST query on `pulse_listings` filtered by property_key
 * + id != current. Sorted by first_seen_at DESC (newest campaign first).
 * Capped at 50 rows — properties with more than that are developer sites
 * (e.g. off-the-plan off Chatswood Grand Residences — 5-20+ unit campaigns).
 */
import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, History, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

const HISTORY_LIMIT = 50;

const TYPE_BADGE = {
  for_sale: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  sold: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  for_rent: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  under_contract: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  withdrawn: "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400",
};

const TYPE_LABEL = {
  for_sale: "For Sale",
  sold: "Sold",
  for_rent: "For Rent",
  under_contract: "Under Contract",
  withdrawn: "Withdrawn",
};

function fmtPrice(v) {
  if (!v || v <= 0) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${v}`;
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    return dt.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

/**
 * Normalize display type. A withdrawn campaign still has its original
 * listing_type ("for_sale" etc) — we surface the withdrawn badge when
 * listing_withdrawn_at is populated so the distinction is legible.
 */
function effectiveType(l) {
  if (l.listing_withdrawn_at) return "withdrawn";
  return l.listing_type || null;
}

export default function PropertyHistoryCard({ listing, onOpenListing }) {
  const propertyKey = listing?.property_key;
  const currentId = listing?.id;

  const { data, isLoading, error } = useQuery({
    queryKey: ["property-history", propertyKey, currentId],
    queryFn: async () => {
      if (!propertyKey) return { rows: [], truncated: false };
      // Fetch HISTORY_LIMIT + 1 so we can detect "more exists" without a
      // second count query. The extra row is sliced off before rendering.
      const { data: rows, error: qErr } = await api._supabase
        .from("pulse_listings")
        .select(
          "id, listing_type, listing_withdrawn_at, first_seen_at, last_synced_at, " +
          "asking_price, sold_price, agent_name, agency_name, source_url, address, suburb",
        )
        .eq("property_key", propertyKey)
        .neq("id", currentId)
        .order("first_seen_at", { ascending: false, nullsFirst: false })
        .limit(HISTORY_LIMIT + 1);
      if (qErr) throw qErr;
      const truncated = (rows || []).length > HISTORY_LIMIT;
      return { rows: (rows || []).slice(0, HISTORY_LIMIT), truncated };
    },
    enabled: !!propertyKey && !!currentId,
    staleTime: 60_000,
  });

  // Hide entirely when there's no property_key linkage — nothing useful to show.
  if (!propertyKey) return null;

  const rows = data?.rows || [];

  return (
    <Card className="rounded-lg border-border/60">
      <CardHeader className="pb-2 pt-3 px-4">
        <CardTitle className="text-xs font-semibold flex items-center gap-1.5 text-muted-foreground uppercase tracking-wide">
          <History className="h-3.5 w-3.5" />
          Property History
          {rows.length > 0 && (
            <Badge variant="outline" className="ml-auto text-[10px] font-normal">
              {rows.length}{data?.truncated ? "+" : ""} other {rows.length === 1 ? "campaign" : "campaigns"}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 pb-3 px-4">
        {isLoading && (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading property history…
          </div>
        )}

        {error && !isLoading && (
          <p className="text-xs text-red-600 py-2">
            Couldn't load history: {error?.message || "unknown error"}
          </p>
        )}

        {!isLoading && !error && rows.length === 0 && (
          <p className="text-xs text-muted-foreground py-2">
            No other campaigns found for this property.
          </p>
        )}

        {!isLoading && !error && rows.length > 0 && (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border/60">
                  <th className="py-1.5 pr-2 font-medium">Type</th>
                  <th className="py-1.5 pr-2 font-medium">First seen</th>
                  <th className="py-1.5 pr-2 font-medium">Last synced</th>
                  <th className="py-1.5 pr-2 font-medium text-right">Price</th>
                  <th className="py-1.5 pr-2 font-medium">Agent</th>
                  <th className="py-1.5 pr-2 font-medium">Agency</th>
                  <th className="py-1.5 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const t = effectiveType(r);
                  const priceVal = r.sold_price || r.asking_price;
                  return (
                    <tr
                      key={r.id}
                      className={cn(
                        "border-b border-border/40 last:border-b-0",
                        onOpenListing && "hover:bg-muted/50 cursor-pointer transition-colors",
                      )}
                      onClick={onOpenListing ? () => onOpenListing(r.id) : undefined}
                      title={onOpenListing ? "Open this campaign" : undefined}
                    >
                      <td className="py-1.5 pr-2">
                        {t ? (
                          <span
                            className={cn(
                              "inline-block text-[9px] font-medium px-1.5 py-0.5 rounded-full",
                              TYPE_BADGE[t] || "bg-muted text-muted-foreground",
                            )}
                          >
                            {TYPE_LABEL[t] || t}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">
                        {fmtDate(r.first_seen_at)}
                      </td>
                      <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">
                        {fmtDate(r.last_synced_at)}
                      </td>
                      <td className="py-1.5 pr-2 tabular-nums text-right font-medium">
                        {fmtPrice(priceVal)}
                      </td>
                      <td className="py-1.5 pr-2 truncate max-w-[120px]">
                        {r.agent_name || <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="py-1.5 pr-2 truncate max-w-[140px]">
                        {r.agency_name || <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="py-1.5 text-right">
                        {r.source_url && (
                          <a
                            href={r.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center text-primary/70 hover:text-primary"
                            title="Open on realestate.com.au"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data?.truncated && (
              <p className="mt-2 text-[10px] text-muted-foreground">
                Showing the {HISTORY_LIMIT} most recent campaigns. Additional
                history exists — open the property dossier for the full list.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
