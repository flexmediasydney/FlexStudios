/**
 * QuoteProvenanceShim — local placeholder for @/components/marketshare/QuoteProvenance.
 *
 * QuoteProvenance is being built in parallel by another agent and will land
 * at `flexmedia-src/src/components/marketshare/QuoteProvenance.jsx`. Until it
 * arrives, the Retention tab renders this shim so the module graph resolves
 * and CI stays green.
 *
 * Swap-out: once the real component merges, change the import in
 * `PulseRetention.jsx` back to `@/components/marketshare/QuoteProvenance`
 * and delete this file.
 *
 * Props contract (match the real component):
 *   listing: { package, quoted_price, quote_status, resolved_tier, pricing_method, ... }
 *   compact?: boolean
 */
import React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export default function QuoteProvenanceShim({ listing, compact = false }) {
  const pkg = listing?.package;
  if (!pkg) return <span className="text-muted-foreground">—</span>;

  const short = String(pkg).replace(" Package", "");
  const isUnclassified = short === "UNCLASSIFIABLE";

  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] h-4 px-1",
        isUnclassified && "text-muted-foreground italic",
        compact && "max-w-[120px] truncate"
      )}
      title={listing?.pricing_method ? `Pricing: ${listing.pricing_method}` : undefined}
    >
      {isUnclassified ? "unclassified" : short}
    </Badge>
  );
}
