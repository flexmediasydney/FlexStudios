import React, { memo } from "react";
import { PackageRow, NestedProductRow, ProductRow } from "./PricingTableRow";

export const PricingTableBody = memo(({ 
  paginatedItems, 
  breakdown,
  canEdit, 
  onRemoveItem, 
  onUpdateQty, 
  onUpdateNestedQty 
}) => {
  return (
    <tbody>
      {paginatedItems.map((row, idx) => {
        if (row.type === "package") {
          const pkg = row.item;
          const rowBg = idx % 2 === 0 ? "bg-muted/20" : "";
          
          return [
            <PackageRow
              key={`pkg-${pkg.id}`}
              pkg={pkg}
              canEdit={canEdit}
              onRemove={onRemoveItem}
              rowBg={rowBg}
            />,
            ...pkg.products.map((nestedProd) => (
              <NestedProductRow
                key={`pkg-${pkg.id}-prod-${nestedProd.id}`}
                nestedProd={nestedProd}
                pkg={pkg}
                canEdit={canEdit}
                onUpdateQty={onUpdateNestedQty}
                rowBg={rowBg}
                isPerUnit={nestedProd.pricingType === "per_unit"}
              />
            ))
          ];
        } else {
          const product = row.item;
          const rowBg = idx % 2 === 0 ? "bg-muted/20" : "";
          
          return (
            <ProductRow
              key={`prod-${product.id}`}
              product={product}
              canEdit={canEdit}
              onUpdateQty={onUpdateQty}
              onRemove={onRemoveItem}
              rowBg={rowBg}
            />
          );
        }
      })}
    </tbody>
  );
});

PricingTableBody.displayName = "PricingTableBody";