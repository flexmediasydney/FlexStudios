import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, Loader2 } from "lucide-react";
import { useProjectPricingCalculator } from "./hooks/useProjectPricingCalculator";
import { PricingTableBody } from "./PricingTableBody";

/**
 * Displays pricing breakdown in the project creation form.
 * Uses the same useProjectPricingCalculator + PricingTableBody as the detail page
 * so package nested product rows are shown correctly.
 */
export default function ProjectFormPricingDisplay({
  products = [],
  packages = [],
  pricingTier = "standard",
  calculatedPrice = 0,
  isCalculating = false,
  products_data = [],
  packages_data = [],
  // 2026-04-20: new props for matrix resolution in the live preview. When
  // the parent ProjectForm has selected an agent/agency + project type, the
  // preview fetches matrices and applies blanket discount + overrides so
  // the on-screen number matches what the backend will save.
  agentId = null,
  agencyId = null,
  projectTypeId = null,
  discountType = "fixed",
  discountValue = 0,
  discountMode = "discount",
}) {
  const tierKey = pricingTier === "premium" ? "premium_tier" : "standard_tier";

  const formState = useMemo(
    () => ({ products, packages, discount_type: discountType, discount_value: discountValue, discount_mode: discountMode }),
    [products, packages, discountType, discountValue, discountMode],
  );
  const pricingContext = useMemo(
    () => ({ agent_id: agentId, agency_id: agencyId, project_type_id: projectTypeId }),
    [agentId, agencyId, projectTypeId],
  );

  const { breakdown } = useProjectPricingCalculator(formState, products_data, packages_data, tierKey, pricingContext);

  if (!products?.length && !packages?.length) return null;

  const allItems = [
    ...breakdown.packages.map((item, idx) => ({ type: "package", item, idx })),
    ...breakdown.products.map((item, idx) => ({ type: "product", item, idx: breakdown.packages.length + idx })),
  ];

  return (
    <Card className="bg-gradient-to-br from-primary/5 via-transparent to-accent/5 border-primary/20">
      <CardContent className="pt-4 pb-5 space-y-4">
        {allItems.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-3 font-semibold text-muted-foreground">Item</th>
                  <th className="text-center py-2 px-3 font-semibold text-muted-foreground w-28">Qty</th>
                  <th className="text-right py-2 px-3 font-semibold text-muted-foreground w-24">Unit Price</th>
                  <th className="text-right py-2 px-3 font-semibold text-muted-foreground w-28">Total</th>
                </tr>
              </thead>
              <PricingTableBody
                paginatedItems={allItems}
                breakdown={breakdown}
                canEdit={false}
                onRemoveItem={() => {}}
                onUpdateQty={() => {}}
                onUpdateNestedQty={() => {}}
              />
            </table>
          </div>
        )}

        <div className="pt-2 border-t">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Estimated Project Value</p>
              <p className={`text-2xl font-bold font-mono ${isCalculating ? "opacity-50" : ""}`}>
                {isCalculating ? (
                  <span className="flex items-center gap-2 text-muted-foreground text-base">
                    <Loader2 className="h-4 w-4 animate-spin" /> Calculating...
                  </span>
                ) : (
                  `$${Number(calculatedPrice > 0 ? calculatedPrice : breakdown.total || 0).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                )}
              </p>
              {!isCalculating && (
                <p className="text-xs text-muted-foreground mt-1">
                  {(calculatedPrice > 0 || breakdown.total > 0) ? "Matrix-adjusted pricing applied" : "Add agent for matrix pricing"}
                </p>
              )}
            </div>
            <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
              <DollarSign className="h-6 w-6 text-primary" />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}