/**
 * MatrixGrid — rows = packages, columns = PRICE TIERS (Standard / Premium).
 *
 * W11.6.28b correction: the previous build (commit b77f370) shipped engine
 * GRADES (Volume / Refined / Editorial) on the column axis. That was wrong —
 * grade is per-round derived and steers Stage 4 voice anchor only; it does
 * NOT change which positions a recipe targets. Joseph's intent was always
 * package × price tier. This file now reads `package_price_tiers` rows
 * (mig 446) for the column axis and uses scope_type='package_x_price_tier'
 * for cell scope (mig 443 vocabulary).
 *
 * Each cell shows TWO numbers — `X authored / Y target` — colour-coded:
 *   slate   X = 0
 *   green   0 < X ≤ Y
 *   amber   X > Y    (over-target — engine drops lowest-priority positions)
 *   red     Y = 0    (defensive — package has no count for this tier)
 *
 * Cells where the package doesn't OFFER a tier render disabled with a
 * tooltip ("Silver Package doesn't have a Premium tier" or similar).
 *
 * The grid is intentionally a CSS grid rather than a <table> so the
 * "Tier defaults" pseudo-row above the body keeps the same visual treatment.
 */
import React, { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle } from "lucide-react";
import Tip, { IconTip } from "./Tip";
import {
  cellHealthColor,
  deriveCellTarget,
  describeTargetBreakdown,
  packageOffersTier,
} from "./constants";

export default function MatrixGrid({
  packages,
  priceTiers,
  // Back-compat alias — older parents still pass `tiers`.
  tiers,
  productLookup, // Map<id, product> for sum-of-products fallback
  cellCounts, // { [`${pkgId}|${tierId}`]: count, ['__defaults__|tierId']: count }
  onCellClick, // (cell) → void
  loading,
}) {
  const cols = priceTiers || tiers || [];

  if (loading) {
    return (
      <div
        className="rounded-md border border-border p-6 text-sm text-muted-foreground"
        data-testid="matrix-loading"
      >
        Loading matrix…
      </div>
    );
  }

  if (!cols || cols.length === 0 || !packages || packages.length === 0) {
    return (
      <div
        className="rounded-md border border-border p-6 text-sm text-muted-foreground"
        data-testid="matrix-empty"
      >
        Matrix needs at least one package and one price tier.
      </div>
    );
  }

  // Single column for the row label + one column per price tier.
  const gridCols = `minmax(180px, 240px) repeat(${cols.length}, minmax(160px, 1fr))`;

  return (
    <Card data-testid="matrix-grid">
      <CardContent className="p-3">
        {/* Header row */}
        <div
          className="grid items-center gap-2 mb-2"
          style={{ gridTemplateColumns: gridCols }}
        >
          <div className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
            Package / Price tier
            <IconTip
              text="Rows are packages. Columns are price tiers (Standard / Premium). Click any cell to author its position list. Engine grade (Volume/Refined/Editorial) is derived per-round and is NOT a matrix axis."
            />
          </div>
          {cols.map((t) => (
            <div
              key={t.id}
              className="text-xs font-semibold flex items-center gap-1.5"
              data-testid={`matrix-tier-header-${t.code}`}
            >
              <span>{t.display_name}</span>
              <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                {t.code}
              </Badge>
            </div>
          ))}
        </div>

        {/* Tier defaults pseudo-row */}
        <div
          className="grid items-center gap-2 mb-2 pb-2 border-b border-dashed"
          style={{ gridTemplateColumns: gridCols }}
        >
          <div className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
            Tier defaults
            <IconTip
              text="The broadest scope. Positions added here inherit DOWN into every package × price tier cell underneath. Override at the cell level for per-package adjustments."
            />
          </div>
          {cols.map((t) => {
            const count = cellCounts?.[`__defaults__|${t.id}`] ?? 0;
            return (
              <CellButton
                key={t.id}
                authored={count}
                target={null}
                offered={true}
                kind="defaults"
                packageName="Tier defaults"
                tierLabel={t.display_name}
                onClick={() =>
                  onCellClick({ kind: "defaults", priceTierId: t.id, tier: t })
                }
                testId={`matrix-cell-defaults-${t.code}`}
              />
            );
          })}
        </div>

        {/* Body: one row per package */}
        {packages.map((pkg) => (
          <PackageRow
            key={pkg.id}
            pkg={pkg}
            cols={cols}
            cellCounts={cellCounts}
            productLookup={productLookup}
            gridCols={gridCols}
            onCellClick={onCellClick}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function PackageRow({ pkg, cols, cellCounts, productLookup, gridCols, onCellClick }) {
  // Compute target + offered state per tier once per render. Both helpers
  // consume the productLookup so non-image-class products (video,
  // floorplan_qa, agent_portraits) are filtered from the image-shortlist
  // sum and don't make a tier "offered" on their own.
  const tierState = useMemo(() => {
    const out = {};
    for (const t of cols) {
      const offered = packageOffersTier(pkg, t.code, productLookup);
      const target = offered
        ? deriveCellTarget(pkg, t.code, productLookup)
        : { value: null, source: "tier_not_offered", breakdown: [] };
      out[t.id] = { offered, target };
    }
    return out;
  }, [pkg, cols, productLookup]);

  return (
    <div
      className="grid items-center gap-2 mb-2"
      style={{ gridTemplateColumns: gridCols }}
      data-testid={`matrix-row-${pkg.id}`}
    >
      <div className="text-xs font-medium flex items-center gap-1">
        <span className="truncate" title={pkg.name}>{pkg.name}</span>
      </div>
      {cols.map((t) => {
        const authored = cellCounts?.[`${pkg.id}|${t.id}`] ?? 0;
        const { offered, target } = tierState[t.id];
        return (
          <CellButton
            key={t.id}
            authored={authored}
            target={target?.value ?? null}
            targetTooltip={describeTargetBreakdown(target)}
            offered={offered}
            kind="cell"
            packageName={pkg.name}
            tierLabel={t.display_name}
            onClick={() => {
              if (!offered) return;
              onCellClick({
                kind: "cell",
                packageId: pkg.id,
                package: pkg,
                priceTierId: t.id,
                tier: t,
                target,
              });
            }}
            testId={`matrix-cell-${pkg.id}-${t.code}`}
          />
        );
      })}
    </div>
  );
}

function CellButton({
  authored,
  target,
  targetTooltip,
  offered,
  kind,
  packageName,
  tierLabel,
  onClick,
  testId,
}) {
  // Disabled cell → package doesn't offer this tier.
  if (offered === false) {
    return (
      <Tip
        text={`${packageName || "This package"} doesn't have a ${tierLabel || "this"} tier.`}
      >
        <div
          data-testid={testId}
          data-kind="disabled"
          aria-disabled="true"
          className={cn(
            "rounded-md border border-dashed border-border bg-muted/40 px-3 py-2.5 text-left text-muted-foreground cursor-not-allowed",
          )}
        >
          <div className="text-xs italic">N/A</div>
          <div className="text-[10px] opacity-70">tier not offered</div>
        </div>
      </Tip>
    );
  }

  const color = cellHealthColor(authored, target);
  const overTarget = target != null && authored > target;
  const colorClass =
    color === "green"
      ? "border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-900"
      : color === "amber"
        ? "border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900"
        : color === "red"
          ? "border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-900"
          : "border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700";

  const button = (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-kind={kind}
      data-over-target={overTarget ? "true" : "false"}
      className={cn(
        "rounded-md border px-3 py-2.5 text-left transition-colors w-full",
        colorClass,
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-base font-semibold tabular-nums leading-none">
          {authored}
        </span>
        <span className="text-xs opacity-70">authored</span>
        <span className="text-xs opacity-50 mx-0.5">/</span>
        <span className="text-sm font-semibold tabular-nums leading-none">
          {target != null ? target : "—"}
        </span>
        <span className="text-xs opacity-70">target</span>
        {overTarget && (
          <AlertTriangle
            className="h-3 w-3 ml-auto text-amber-700"
            data-testid={`${testId}-over-target-icon`}
          />
        )}
      </div>
      {overTarget && (
        <div
          className="text-[10px] mt-1 font-medium"
          data-testid={`${testId}-over-target-warning`}
        >
          Over target: {authored} authored / {target} target
        </div>
      )}
    </button>
  );

  // If we have a target tooltip, wrap. Otherwise return the button bare.
  if (targetTooltip) {
    return <Tip text={targetTooltip}>{button}</Tip>;
  }
  return button;
}
