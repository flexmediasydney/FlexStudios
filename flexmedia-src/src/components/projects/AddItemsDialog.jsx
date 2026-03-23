import { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, Package, Box, Check, AlertTriangle, Info } from "lucide-react";
import { useEntityList } from "@/components/hooks/useEntityData";

// Map product.category enum → category name aliases for matching
const CATEGORY_SLUG_MAP = {
  photography: ["photography"],
  video: ["video"],
  drone: ["drone"],
  editing: ["editing", "edit"],
  virtual_staging: ["virtual staging", "virtual_staging", "staging"],
  other: ["other"],
};

function QtyControl({ qty, min = 1, max, onChange }) {
  const handleDecrement = () => {
    const newQty = qty - 1;
    if (newQty >= min) {
      onChange(newQty);
    }
  };

  const handleIncrement = () => {
    if (max && qty >= max) return;
    onChange(qty + 1);
  };

  return (
    <div className="flex items-center gap-0.5 border rounded bg-background" onClick={e => e.stopPropagation()}>
      <button
        type="button"
        onClick={handleDecrement}
        disabled={qty <= min}
        className="px-1.5 py-0.5 text-xs hover:bg-muted rounded-l disabled:opacity-40"
      >−</button>
      <span className="text-xs font-medium w-6 text-center select-none">{qty}</span>
      <button
        type="button"
        onClick={handleIncrement}
        disabled={!!(max && qty >= max)}
        className="px-1.5 py-0.5 text-xs hover:bg-muted rounded-r disabled:opacity-40"
      >+</button>
    </div>
  );
}

export default function AddItemsDialog({
  open,
  onOpenChange,
  availableProducts,
  availablePackages,
  onAddProduct,
  onAddPackage,
  isLoading,
  projectTypeId,
  // Current project state — needed for overlap detection
  currentProducts = [],
  currentPackages = [],
  allProducts: allProductsFull = [],
}) {
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("products");
  // pendingProducts: { [productId]: qty }
  const [pendingProducts, setPendingProducts] = useState({});
  // pendingPackage: { id, qty, productQtyOverrides: { [productId]: qty } } | null
  // Only 1 package allowed per project
  const [pendingPackage, setPendingPackage] = useState(null);

  // Reset all selection state when dialog opens to prevent stale data
  useEffect(() => {
    if (open) {
      setSearch("");
      setActiveTab("products");
      setPendingProducts({});
      setPendingPackage(null);
    }
  }, [open]);

  const { data: allCategories = [] } = useEntityList("ProductCategory");

  const hasExistingPackage = currentPackages.length > 0;

  // Categories relevant to this project type
  const categories = useMemo(() => {
    return allCategories
      .filter(c => c.is_active !== false && (!projectTypeId || c.project_type_id === projectTypeId))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [allCategories, projectTypeId]);

  const filteredProducts = useMemo(() => {
    const q = search.toLowerCase();
    return availableProducts.filter(p =>
      !q || p.name?.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q)
    );
  }, [availableProducts, search]);

  const filteredPackages = useMemo(() => {
    const q = search.toLowerCase();
    return availablePackages.filter(p =>
      !q || p.name?.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q)
    );
  }, [availablePackages, search]);

  // Group products by ProductCategory
  const productsByCategory = useMemo(() => {
    const groups = [];
    const usedIds = new Set();
    categories.forEach(cat => {
      const catNameLower = cat.name?.toLowerCase().trim();
      const matches = filteredProducts.filter(p => {
        const prodCat = p.category?.toLowerCase();
        if (!prodCat) return false;
        const slugs = CATEGORY_SLUG_MAP[prodCat] || [prodCat];
        return slugs.some(s => catNameLower === s || catNameLower?.startsWith(s) || s.startsWith(catNameLower));
      });
      if (matches.length > 0) {
        groups.push({ category: cat, products: matches });
        matches.forEach(p => usedIds.add(p.id));
      }
    });
    const uncategorised = filteredProducts.filter(p => !usedIds.has(p.id));
    if (uncategorised.length > 0) {
      groups.push({ category: { name: "Other", color: "#6b7280", icon: "📦" }, products: uncategorised });
    }
    return groups;
  }, [filteredProducts, categories]);

  // ── Product selection ──────────────────────────────────────────────────────
  const toggleProduct = (product) => {
    const id = product.id;
    setPendingProducts(prev => {
      if (prev[id] !== undefined) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      // Start with min_quantity, respecting max constraint
      const min = product.min_quantity || 1;
      const max = product.max_quantity;
      const startQty = max && min > max ? max : min;
      return { ...prev, [id]: startQty };
    });
  };

  const setProductQty = (id, qty) => {
    if (qty < 1) return;
    const product = availableProducts.find(p => p.id === id);
    if (product) {
      const min = product.min_quantity || 1;
      const max = product.max_quantity;
      if (qty < min || (max && qty > max)) return;
    }
    setPendingProducts(prev => prev[id] !== undefined ? { ...prev, [id]: qty } : prev);
  };

  // ── Package selection ──────────────────────────────────────────────────────
  const selectPackage = (pkg) => {
    if (pendingPackage?.id === pkg.id) {
      setPendingPackage(null);
      return;
    }
    // Build initial product qty overrides from the package template,
    // respecting min/max from product definitions
    const overrides = {};
    (pkg.products || []).forEach(templateItem => {
      const productId = templateItem.product_id;
      let qty = templateItem.quantity || 1;
      const product = allProductsFull.find(p => p.id === productId);
      
      if (product) {
        const min = product.min_quantity || 1;
        const max = product.max_quantity;
        // Clamp to valid range
        if (qty < min) qty = min;
        if (max && qty > max) qty = max;
      }
      
      overrides[productId] = qty;
    });
    setPendingPackage({ id: pkg.id, qty: 1, productQtyOverrides: overrides });
  };

  const setPackageProductQty = (productId, qty) => {
    if (qty < 1) return;
    const product = allProductsFull.find(p => p.id === productId);
    if (product) {
      const min = product.min_quantity || 1;
      const max = product.max_quantity;
      if (qty < min || (max && qty > max)) return;
    }
    setPendingPackage(prev => prev ? {
      ...prev,
      productQtyOverrides: { ...prev.productQtyOverrides, [productId]: qty }
    } : null);
  };

  // ── Overlap analysis for selected package ─────────────────────────────────
  const packageOverlapInfo = useMemo(() => {
    if (!pendingPackage) return null;
    const pkg = availablePackages.find(p => p.id === pendingPackage.id);
    if (!pkg) return null;
    const overlaps = [];
    (pkg.products || []).forEach(templateItem => {
      const existing = currentProducts.find(p => p.product_id === templateItem.product_id);
      if (existing) {
        const product = allProductsFull.find(p => p.id === templateItem.product_id);
        overlaps.push({
          productId: templateItem.product_id,
          productName: product?.name || templateItem.product_name || templateItem.product_id,
          existingQty: existing.quantity || 1,
          packageQty: templateItem.quantity || 1,
        });
      }
    });
    return overlaps.length > 0 ? overlaps : null;
  }, [pendingPackage, currentProducts, availablePackages, allProductsFull]);

  // ── Confirm ────────────────────────────────────────────────────────────────
  const handleConfirm = () => {
    // Add standalone products
    Object.entries(pendingProducts).forEach(([id, qty]) => {
      onAddProduct(id, qty);
    });
    // Add package (with product qty overrides)
    if (pendingPackage) {
      onAddPackage(pendingPackage.id, pendingPackage.qty, pendingPackage.productQtyOverrides);
    }
    setPendingProducts({});
    setPendingPackage(null);
    setSearch("");
    onOpenChange(false);
  };

  const handleClose = () => {
    setSearch("");
    setPendingProducts({});
    setPendingPackage(null);
    onOpenChange(false);
  };

  const selectedCount = Object.keys(pendingProducts).length + (pendingPackage ? 1 : 0);

  // ── Render product card ────────────────────────────────────────────────────
  const renderProductCard = (product, category) => {
    const isSelected = pendingProducts[product.id] !== undefined;
    const qty = pendingProducts[product.id] ?? (product.min_quantity || 1);
    const isPerUnit = product.pricing_type === "per_unit";

    return (
      <div
        key={product.id}
        onClick={() => toggleProduct(product)}
        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all select-none ${
          isSelected
            ? "border-primary bg-primary/5 shadow-sm"
            : "border-border bg-card hover:bg-muted/40 hover:border-muted-foreground/30"
        }`}
      >
        <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 mt-0.5 transition-colors ${
          isSelected ? "border-primary bg-primary" : "border-muted-foreground/40"
        }`}>
          {isSelected && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
        </div>
        <div
          className="w-7 h-7 rounded-md flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5"
          style={{ backgroundColor: category?.color || "#6b7280" }}
        >
          {product.name?.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground leading-tight">{product.name}</p>
          {product.description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{product.description}</p>
          )}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {isPerUnit && <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">Per Unit</Badge>}
            {product.product_type === "addon" && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-amber-300 text-amber-700">Add-on</Badge>
            )}
          </div>
        </div>
        {isSelected && isPerUnit && (
          <div className="shrink-0">
            <QtyControl
              qty={qty}
              min={product.min_quantity || 1}
              max={product.max_quantity}
              onChange={q => setProductQty(product.id, q)}
            />
          </div>
        )}
      </div>
    );
  };

  // ── Render package card ────────────────────────────────────────────────────
  const renderPackageCard = (pkg) => {
    const isSelected = pendingPackage?.id === pkg.id;
    const overrides = isSelected ? pendingPackage.productQtyOverrides : {};

    return (
      <div key={pkg.id} className={`rounded-lg border transition-all ${
        isSelected ? "border-primary bg-primary/5 shadow-sm" : "border-border bg-card"
      }`}>
        {/* Package header row */}
        <div
          onClick={() => selectPackage(pkg)}
          className="flex items-start gap-3 p-3 cursor-pointer select-none hover:bg-muted/20 rounded-lg"
        >
          <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 mt-0.5 transition-colors ${
            isSelected ? "border-primary bg-primary" : "border-muted-foreground/40"
          }`}>
            {isSelected && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
          </div>
          <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
            <Package className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground leading-tight">{pkg.name}</p>
            {pkg.description && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{pkg.description}</p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
              {pkg.products?.length || 0} product{pkg.products?.length !== 1 ? "s" : ""} included
            </p>
          </div>
          {isSelected && (
           <div onClick={e => e.stopPropagation()}>
             <QtyControl
               qty={pendingPackage.qty}
               min={1}
               max={undefined}
               onChange={q => setPendingPackage(prev => ({ ...prev, qty: q }))}
             />
           </div>
          )}
        </div>

        {/* Expanded: all package products with qty editing */}
        {isSelected && pkg.products?.length > 0 && (
          <div className="border-t mx-3 mb-3">
            {/* Overlap warning */}
            {packageOverlapInfo && (
              <div className="flex items-start gap-2 mt-2 p-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>
                  {packageOverlapInfo.length} product{packageOverlapInfo.length > 1 ? "s" : ""} already on this project will be absorbed into the package:&nbsp;
                  {packageOverlapInfo.map(o => o.productName).join(", ")}.
                </span>
              </div>
            )}
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mt-3 mb-1.5 px-1">
              Included Products
            </p>
            <div className="space-y-1">
              {pkg.products.map(templateItem => {
                const product = allProductsFull.find(p => p.id === templateItem.product_id);
                const isPerUnit = product?.pricing_type === "per_unit";
                const currentQty = overrides[templateItem.product_id] ?? templateItem.quantity ?? 1;
                const isOverlapping = packageOverlapInfo?.some(o => o.productId === templateItem.product_id);

                return (
                  <div
                    key={templateItem.product_id}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded ${
                      isOverlapping ? "bg-amber-50 border border-amber-200" : "bg-muted/30"
                    }`}
                  >
                    {isOverlapping && <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />}
                    <span className="text-xs flex-1 truncate">
                      {product?.name || templateItem.product_name || templateItem.product_id}
                    </span>
                    {isOverlapping && (
                      <span className="text-[10px] text-amber-600 shrink-0">
                        was {packageOverlapInfo.find(o => o.productId === templateItem.product_id)?.existingQty}
                      </span>
                    )}
                    {isPerUnit ? (
                      <QtyControl
                        qty={currentQty}
                        min={product?.min_quantity || 1}
                        max={product?.max_quantity}
                        onChange={q => setPackageProductQty(templateItem.product_id, q)}
                      />
                    ) : (
                      <span className="text-[10px] text-muted-foreground">Fixed</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b">
          <DialogTitle className="text-base font-semibold">Add to Project</DialogTitle>
        </DialogHeader>

        {/* Search */}
        <div className="px-5 py-3 border-b">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search products & packages..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 h-9 text-sm"
              autoFocus
            />
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0">
          <TabsList className="mx-5 mt-3 mb-0 grid grid-cols-2 h-9 shrink-0">
            <TabsTrigger value="products" className="text-xs">
              <Box className="h-3.5 w-3.5 mr-1.5" />
              Products
              {filteredProducts.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-xs px-1.5 py-0 h-4">{filteredProducts.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="packages" className="text-xs">
              <Package className="h-3.5 w-3.5 mr-1.5" />
              Packages
              {filteredPackages.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-xs px-1.5 py-0 h-4">{filteredPackages.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {/* Products Tab */}
          <TabsContent value="products" className="flex-1 overflow-y-auto px-5 py-3 mt-0 space-y-4">
            {filteredProducts.length === 0 ? (
              <div className="text-center py-10 text-sm text-muted-foreground">
                {search ? "No products match your search." : "All products are already added."}
              </div>
            ) : productsByCategory.length > 0 ? (
              productsByCategory.map(({ category, products }) => (
                <div key={category.name}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-base">{category.icon || "📦"}</span>
                    <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: category.color || "#6b7280" }}>
                      {category.name}
                    </span>
                    <div className="flex-1 h-px bg-border" />
                  </div>
                  <div className="space-y-1.5">
                    {products.map(product => renderProductCard(product, category))}
                  </div>
                </div>
              ))
            ) : (
              <div className="space-y-1.5">
                {filteredProducts.map(product => renderProductCard(product, null))}
              </div>
            )}
          </TabsContent>

          {/* Packages Tab */}
          <TabsContent value="packages" className="flex-1 overflow-y-auto px-5 py-3 mt-0 space-y-2">
            {/* 1-package limit warning */}
            {hasExistingPackage && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>This project already has a package. Only one package is allowed per project. Remove the existing package first to add a new one.</span>
              </div>
            )}
            {!hasExistingPackage && filteredPackages.length === 0 && (
              <div className="text-center py-10 text-sm text-muted-foreground">
                {search ? "No packages match your search." : "No packages available."}
              </div>
            )}
            {!hasExistingPackage && filteredPackages.length > 0 && (
              <>
                <div className="flex items-start gap-2 p-2 rounded bg-blue-50 border border-blue-200 text-xs text-blue-700">
                  <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>Only one package can be assigned per project. Select a package to review and adjust product quantities before adding.</span>
                </div>
                {filteredPackages.map(pkg => renderPackageCard(pkg))}
              </>
            )}
          </TabsContent>
        </Tabs>

        {/* Footer */}
        <div className="px-5 py-3 border-t flex items-center gap-2">
          <Button variant="outline" size="sm" className="flex-1" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="flex-1"
            disabled={selectedCount === 0 || isLoading}
            onClick={handleConfirm}
          >
            {selectedCount > 0 ? `Add ${selectedCount} Item${selectedCount > 1 ? "s" : ""}` : "Add Selected"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}