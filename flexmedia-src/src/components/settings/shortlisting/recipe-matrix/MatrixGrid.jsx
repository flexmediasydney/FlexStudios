/**
 * MatrixGrid — rows = packages, columns = price tiers.
 *
 * Each cell shows a position count + colour-coded health (green / amber /
 * red) and is click-to-edit. The first row is "Tier defaults" — the
 * broadest scope that inherits down into every cell underneath.
 *
 * Cell health rules (see constants.cellHealthColor):
 *   - 0 positions          → red
 *   - 0 < count < target   → amber
 *   - count ≥ target       → green
 *
 * The grid is intentionally a 12-column CSS grid rather than a <table>
 * so we can render the "Tier defaults" pseudo-row with the same visual
 * treatment.
 */
import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { IconTip } from "./Tip";
import { cellHealthColor } from "./constants";

export default function MatrixGrid({
  packages,
  tiers,
  cellCounts, // { [`${pkgId}|${tierId}`]: count, ['__defaults__|tierId']: count }
  expectedTargets, // { [tierId]: number }
  onCellClick, // (cell) → void
  loading,
}) {
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

  if (!tiers || tiers.length === 0 || !packages || packages.length === 0) {
    return (
      <div
        className="rounded-md border border-border p-6 text-sm text-muted-foreground"
        data-testid="matrix-empty"
      >
        Matrix needs at least one package and one price tier.
      </div>
    );
  }

  // Single column for the row label + one column per tier.
  const cols = `minmax(160px, 220px) repeat(${tiers.length}, minmax(140px, 1fr))`;

  return (
    <Card data-testid="matrix-grid">
      <CardContent className="p-3">
        {/* Header row */}
        <div
          className="grid items-center gap-2 mb-2"
          style={{ gridTemplateColumns: cols }}
        >
          <div className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
            Package / Tier
            <IconTip
              text="Rows are packages. Columns are price tiers (Standard / Premium / etc). Click any cell to author its position list."
            />
          </div>
          {tiers.map((t) => (
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
          style={{ gridTemplateColumns: cols }}
        >
          <div className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
            Tier defaults
            <IconTip
              text="The broadest scope. Positions added here inherit DOWN into every package × tier cell underneath. Override at the cell level for per-package adjustments."
            />
          </div>
          {tiers.map((t) => {
            const count = cellCounts?.[`__defaults__|${t.id}`] ?? 0;
            return (
              <CellButton
                key={t.id}
                count={count}
                expectedTarget={null}
                kind="defaults"
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
          <div
            key={pkg.id}
            className="grid items-center gap-2 mb-2"
            style={{ gridTemplateColumns: cols }}
            data-testid={`matrix-row-${pkg.id}`}
          >
            <div className="text-xs font-medium flex items-center gap-1">
              <span className="truncate" title={pkg.name}>{pkg.name}</span>
              {pkg.expected_count_target ? (
                <Badge
                  variant="secondary"
                  className="text-[10px] py-0 px-1.5"
                  title="Package expected_count_target"
                >
                  ~{pkg.expected_count_target}
                </Badge>
              ) : null}
            </div>
            {tiers.map((t) => {
              const count = cellCounts?.[`${pkg.id}|${t.id}`] ?? 0;
              const expected =
                expectedTargets?.[t.id] ?? pkg.expected_count_target ?? null;
              return (
                <CellButton
                  key={t.id}
                  count={count}
                  expectedTarget={expected}
                  kind="cell"
                  onClick={() =>
                    onCellClick({
                      kind: "cell",
                      packageId: pkg.id,
                      package: pkg,
                      priceTierId: t.id,
                      tier: t,
                    })
                  }
                  testId={`matrix-cell-${pkg.id}-${t.code}`}
                />
              );
            })}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CellButton({ count, expectedTarget, kind, onClick, testId }) {
  const color = cellHealthColor(count, expectedTarget);
  const colorClass =
    color === "green"
      ? "border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-900"
      : color === "amber"
        ? "border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900"
        : "border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-900";

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-kind={kind}
      className={cn(
        "rounded-md border px-3 py-2.5 text-left transition-colors",
        colorClass,
      )}
    >
      <div className="text-sm font-semibold">
        {count} position{count === 1 ? "" : "s"}
      </div>
      <div className="text-[10px] opacity-80">
        {expectedTarget != null ? (
          <>target ~{expectedTarget}</>
        ) : (
          <>no target</>
        )}
      </div>
    </button>
  );
}
