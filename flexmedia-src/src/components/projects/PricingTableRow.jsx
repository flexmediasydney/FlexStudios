import React, { memo } from "react";
import { TrendingUp, Package, Lock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import Price from '@/components/common/Price';

const QtyControl = memo(({ qty, minQty, maxQty, onChange }) => {
  return (
    <div className="inline-flex items-center gap-1 border rounded px-1 py-0.5">
      <button
        onClick={() => onChange(qty - 1)}
        className="px-1.5 py-0.5 text-xs hover:bg-muted rounded disabled:opacity-30 font-bold focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:outline-none"
        disabled={qty <= minQty}
      >
        −
      </button>
      <span className="font-mono text-sm font-medium w-6 text-center tabular-nums">{qty}</span>
      <button
        onClick={() => onChange(qty + 1)}
        className="px-1.5 py-0.5 text-xs hover:bg-muted rounded disabled:opacity-30 font-bold focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:outline-none"
        disabled={maxQty != null && qty >= maxQty}
      >
        +
      </button>
    </div>
  );
});

QtyControl.displayName = "QtyControl";

// Shared renderer for a line's total cell — sticker price with strikethrough
// + effective price + "matrix −X%" tag when a blanket rebate applies to this
// line. Both packages and products use this so the rendering is consistent.
const LineTotalCell = memo(({ lineTotal, lineTotalEffective, blanketPct }) => {
  const hasBlanket = blanketPct > 0 && lineTotalEffective != null && lineTotalEffective < lineTotal;
  if (!hasBlanket) {
    return (
      <span className="font-semibold font-mono">
        <Price value={lineTotal || 0} />
      </span>
    );
  }
  return (
    <div className="flex items-center justify-end gap-1.5">
      <span
        className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1 rounded border bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30 dark:text-purple-300 dark:border-purple-900/40"
        title={`Matrix blanket discount: ${blanketPct}% off`}
      >
        −{blanketPct}%
      </span>
      <span className="font-mono text-muted-foreground line-through text-[11px]">
        <Price value={lineTotal || 0} />
      </span>
      <span className="font-semibold font-mono text-purple-700 dark:text-purple-400">
        <Price value={lineTotalEffective || 0} />
      </span>
    </div>
  );
});
LineTotalCell.displayName = "LineTotalCell";

export const PackageRow = memo(({ pkg, canEdit, onRemove, rowBg }) => (
  <tr className={`border-b ${rowBg}`}>
    <td className="py-3 px-3">
      <div className="flex items-center gap-2">
        <Package className="h-4 w-4 text-amber-600 flex-shrink-0" />
        <div>
          <p className="font-medium">{pkg.name}</p>
          <p className="text-xs text-muted-foreground">package</p>
        </div>
      </div>
    </td>
    <td className="py-3 px-3 text-center">
      <span className="inline-flex items-center gap-1 font-mono text-muted-foreground text-sm">
        1 <Lock className="h-3 w-3 opacity-40" />
      </span>
    </td>
    <td className="py-3 px-3 text-right font-mono text-muted-foreground text-xs">
      <Price value={pkg.basePrice || 0} />
    </td>
    <td className="py-3 px-3 text-right">
      <LineTotalCell
        lineTotal={pkg.lineTotal}
        lineTotalEffective={pkg.lineTotalEffective}
        blanketPct={pkg.blanketPct}
      />
    </td>
    {canEdit && (
      <td className="py-3 px-3">
        <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive"
          onClick={() => onRemove("packages", pkg.id)}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </td>
    )}
  </tr>
));

PackageRow.displayName = "PackageRow";

export const NestedProductRow = memo(({ nestedProd, pkg, canEdit, onUpdateQty, rowBg, isPerUnit }) => {
  const actualExtraQty = nestedProd.extraQty || 0;
  const extraCost = nestedProd.lineTotal || 0;

  return (
    <tr className={`border-b text-xs ${rowBg}`}>
      <td className="py-2 px-3 pl-10">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
          <div>
            <p className="font-medium">{nestedProd.name}</p>
            <p className="text-xs text-muted-foreground capitalize">
              {nestedProd.category}
              {isPerUnit && actualExtraQty > 0 && (
                <span className="text-amber-600 ml-1">+{actualExtraQty} extra</span>
              )}
            </p>
          </div>
        </div>
      </td>
      <td className="py-2 px-3 text-center">
        {canEdit && isPerUnit ? (
          <QtyControl
            qty={nestedProd.quantity}
            minQty={nestedProd.includedQty}
            maxQty={nestedProd.maxQuantity}
            onChange={(newQty) => onUpdateQty(pkg.id, nestedProd.id, newQty)}
          />
        ) : (
          <span className="inline-flex items-center gap-1 font-mono text-muted-foreground">
            {nestedProd.quantity} {!isPerUnit && <Lock className="h-2.5 w-2.5 opacity-30" />}
          </span>
        )}
      </td>
      <td className="py-2 px-3 text-right font-mono text-muted-foreground">
        {isPerUnit ? <><Price value={nestedProd.unitPrice || 0} />/unit</> : "—"}
      </td>
      <td className="py-2 px-3 text-right font-mono text-muted-foreground">
        {isPerUnit && actualExtraQty > 0 ? (
          (() => {
            const blanketPct = nestedProd.blanketPct || 0;
            const effective = nestedProd.lineTotalEffective ?? extraCost;
            const hasBlanket = blanketPct > 0 && effective < extraCost;
            if (!hasBlanket) {
              return <span className="text-amber-700 font-semibold">+<Price value={extraCost} /></span>;
            }
            // Extras line with product-% blanket applied: strikethrough + effective + tag.
            return (
              <span className="inline-flex items-center justify-end gap-1">
                <span className="text-[9px] font-semibold px-1 rounded border bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30 dark:text-purple-300 dark:border-purple-900/40">
                  −{blanketPct}%
                </span>
                <span className="font-mono text-muted-foreground line-through text-[10px]">
                  +<Price value={extraCost} />
                </span>
                <span className="font-semibold text-purple-700 dark:text-purple-400">
                  +<Price value={effective} />
                </span>
              </span>
            );
          })()
        ) : (
          <span className="text-muted-foreground cursor-help" title="Included in package — no extra charge">incl.</span>
        )}
      </td>
      {canEdit && <td />}
    </tr>
  );
});

NestedProductRow.displayName = "NestedProductRow";

export const ProductRow = memo(({ product, canEdit, onUpdateQty, onRemove, rowBg }) => {
  const isPerUnit = product.pricingType === "per_unit";
  const actualExtraQty = product.extraQty || 0;

  return (
    <tr className={`border-b ${rowBg}`}>
      <td className="py-3 px-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-blue-600 flex-shrink-0" />
          <div>
            <p className="font-medium">{product.name}</p>
            <p className="text-xs text-muted-foreground capitalize">
              {product.category}
              {isPerUnit && actualExtraQty > 0 && (
                <span className="text-amber-600 ml-1">+{actualExtraQty} extra</span>
              )}
            </p>
          </div>
        </div>
      </td>
      <td className="py-3 px-3 text-center">
        {canEdit && isPerUnit ? (
          <QtyControl
            qty={product.quantity}
            minQty={product.minQuantity}
            maxQty={product.maxQuantity}
            onChange={(newQty) => onUpdateQty(product.id, newQty)}
          />
        ) : (
          <span className="inline-flex items-center gap-1 font-mono text-muted-foreground">
            {product.quantity} <Lock className="h-2.5 w-2.5 opacity-30" />
          </span>
        )}
      </td>
      <td className="py-3 px-3 text-right font-mono text-muted-foreground text-xs">
        {isPerUnit
          ? product.unitPrice > 0
            ? <><Price value={product.unitPrice} />/unit</>
            : <><Price value={product.basePrice || 0} />/unit</>
          : <Price value={product.basePrice || 0} />}
      </td>
      <td className="py-3 px-3 text-right">
        <LineTotalCell
          lineTotal={product.lineTotal}
          lineTotalEffective={product.lineTotalEffective}
          blanketPct={product.blanketPct}
        />
      </td>
      {canEdit && (
        <td className="py-3 px-3">
          <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive"
            onClick={() => onRemove("products", product.id)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </td>
      )}
    </tr>
  );
});

ProductRow.displayName = "ProductRow";