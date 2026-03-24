import { useState, useMemo, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";

const StarDiagram = ({ products, packages, selectedItem, onSelectItem }) => {
  if (!selectedItem) {
    return (
      <div className="flex items-center justify-center h-96 text-muted-foreground">
        <p>Select a product or package from the list to view its relationships</p>
      </div>
    );
  }

  const isProduct = selectedItem.type === "product";
  const center = { x: 300, y: 200 };
  const radius = 150;

  let relatedItems = [];
  if (isProduct) {
    relatedItems = packages.filter(pkg =>
      pkg.products?.some(p => p.product_id === selectedItem.id)
    ).map(pkg => ({
      ...pkg,
      quantity: pkg.products?.find(p => p.product_id === selectedItem.id)?.quantity || 1
    }));
  } else {
    relatedItems = selectedItem.products?.map(prod => {
      const fullProduct = products.find(p => p.id === prod.product_id);
      return fullProduct ? { ...fullProduct, quantity: prod.quantity } : null;
    }).filter(Boolean) || [];
  }

  const angleSlice = relatedItems.length > 0 ? (360 / relatedItems.length) : 0;

  return (
    <svg width="100%" height="400" viewBox="0 0 600 400" className="w-full">
      {/* Connection lines */}
      {relatedItems.map((item, idx) => {
        const angle = (idx * angleSlice - 90) * (Math.PI / 180);
        const x = center.x + radius * Math.cos(angle);
        const y = center.y + radius * Math.sin(angle);
        return (
          <g key={`conn-${idx}`}>
            <line x1={center.x} y1={center.y} x2={x} y2={y} stroke="#cbd5e1" strokeWidth="2" strokeDasharray="4,4" />
            <circle cx={(center.x + x) / 2} cy={(center.y + y) / 2} r="14" fill="white" stroke="#94a3b8" strokeWidth="1" />
            <text
              x={(center.x + x) / 2}
              y={(center.y + y) / 2}
              textAnchor="middle"
              dy="0.35em"
              fontSize="12"
              fontWeight="600"
              fill="#475569"
            >
              x{item.quantity}
            </text>
          </g>
        );
      })}

      {/* Center node */}
      <g>
        <circle cx={center.x} cy={center.y} r="45" fill={isProduct ? "#dbeafe" : "#dcfce7"} stroke={isProduct ? "#3b82f6" : "#10b981"} strokeWidth="2" />
        <text x={center.x} y={center.y - 8} textAnchor="middle" fontSize="11" fontWeight="700" fill={isProduct ? "#1e40af" : "#065f46"}>
          {selectedItem.name.substring(0, 20)}
        </text>
        <text x={center.x} y={center.y + 8} textAnchor="middle" fontSize="10" fill="#64748b">
          {relatedItems.length} connection{relatedItems.length !== 1 ? "s" : ""}
        </text>
      </g>

      {/* Related items */}
      {relatedItems.map((item, idx) => {
        const angle = (idx * angleSlice - 90) * (Math.PI / 180);
        const x = center.x + radius * Math.cos(angle);
        const y = center.y + radius * Math.sin(angle);
        const isProduct2 = !isProduct;
        return (
          <g key={`item-${idx}`}>
            <circle
              cx={x}
              cy={y}
              r="38"
              fill={isProduct2 ? "#dbeafe" : "#dcfce7"}
              stroke={isProduct2 ? "#3b82f6" : "#10b981"}
              strokeWidth="2"
            />
            <text x={x} y={y - 8} textAnchor="middle" fontSize="10" fontWeight="600" fill={isProduct2 ? "#1e40af" : "#065f46"}>
              {item.name.substring(0, 12)}
            </text>
            <text x={x} y={y + 2} textAnchor="middle" fontSize="8" fill="#64748b">
              S: ${item.standard_tier?.base_price || item.standard_tier?.package_price || "0"}
            </text>
            <text x={x} y={y + 10} textAnchor="middle" fontSize="8" fill="#64748b">
              P: ${item.premium_tier?.base_price || item.premium_tier?.package_price || "0"}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

export default function ProductPackageHierarchy() {
  const queryClient = useQueryClient();
  const { data: products, loading: productsLoading } = useEntityList("Product", "name");
  const { data: packages, loading: packagesLoading } = useEntityList("Package", "name");
  const [selectedItem, setSelectedItem] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState({ products: true, packages: true });
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await queryClient.invalidateQueries();
    refetchEntityList("Product");
    refetchEntityList("Package");
    setIsRefreshing(false);
    setSelectedItem(null);
  };

  // Subscribe to package changes to keep hierarchy in sync
  useEffect(() => {
    const unsubscribe = api.entities.Package.subscribe((event) => {
      // Clear selected item if the modified package was selected
      setSelectedItem(prev => 
        prev?.id === event.id && prev?.type === "package" ? null : prev
      );
    });
    return unsubscribe;
  }, []);

  const activeProducts = useMemo(() => products.filter(p => p.is_active), [products]);
  const activePackages = useMemo(() => packages.filter(p => p.is_active), [packages]);

  const stats = {
    totalProducts: activeProducts.length,
    totalPackages: activePackages.length,
    totalConnections: activePackages.reduce((sum, pkg) => sum + (pkg.products?.length || 0), 0)
  };

  const getRelationshipCount = (item, type) => {
    if (type === "product") {
      return activePackages.filter(pkg => pkg.products?.some(p => p.product_id === item.id)).length;
    } else {
      return item.products?.length || 0;
    }
  };

  if (productsLoading || packagesLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Product & Package Relationships</h2>
        <Button 
          variant="outline" 
          size="sm"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="gap-2"
        >
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold text-blue-600">{stats.totalProducts}</div>
            <p className="text-sm text-muted-foreground mt-1">Active Products</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold text-green-600">{stats.totalPackages}</div>
            <p className="text-sm text-muted-foreground mt-1">Active Packages</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold text-purple-600">{stats.totalConnections}</div>
            <p className="text-sm text-muted-foreground mt-1">Total Dependencies</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-1 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center justify-between cursor-pointer" onClick={() => setExpandedGroups(prev => ({ ...prev, products: !prev.products }))}>
                Products
                {expandedGroups.products ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </CardTitle>
            </CardHeader>
            {expandedGroups.products && (
              <CardContent className="space-y-1">
                {activeProducts.map(product => (
                  <div
                    key={product.id}
                    onClick={() => setSelectedItem({ ...product, type: "product" })}
                    className={`p-3 rounded-lg cursor-pointer transition ${
                      selectedItem?.id === product.id && selectedItem?.type === "product"
                        ? "bg-blue-100 border border-blue-300"
                        : "bg-muted hover:bg-muted/80"
                    }`}
                  >
                    <p className="text-sm font-medium truncate">{product.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {getRelationshipCount(product, "product")} package{getRelationshipCount(product, "product") !== 1 ? "s" : ""}
                    </p>
                  </div>
                ))}
              </CardContent>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center justify-between cursor-pointer" onClick={() => setExpandedGroups(prev => ({ ...prev, packages: !prev.packages }))}>
                Packages
                {expandedGroups.packages ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </CardTitle>
            </CardHeader>
            {expandedGroups.packages && (
              <CardContent className="space-y-1">
                {activePackages.map(pkg => (
                  <div
                    key={pkg.id}
                    onClick={() => setSelectedItem({ ...pkg, type: "package" })}
                    className={`p-3 rounded-lg cursor-pointer transition ${
                      selectedItem?.id === pkg.id && selectedItem?.type === "package"
                        ? "bg-green-100 border border-green-300"
                        : "bg-muted hover:bg-muted/80"
                    }`}
                  >
                    <p className="text-sm font-medium truncate">{pkg.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {getRelationshipCount(pkg, "package")} product{getRelationshipCount(pkg, "package") !== 1 ? "s" : ""}
                    </p>
                  </div>
                ))}
              </CardContent>
            )}
          </Card>
        </div>

        <div className="col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {selectedItem ? `${selectedItem.type === "product" ? "Product" : "Package"}: ${selectedItem.name}` : "Relationship Diagram"}
              </CardTitle>
              <CardDescription>
                {selectedItem 
                  ? selectedItem.type === "product" 
                    ? `Used in ${getRelationshipCount(selectedItem, "product")} package(s)`
                    : `Contains ${getRelationshipCount(selectedItem, "package")} product(s)`
                  : "Select a product or package to view relationships"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <StarDiagram products={activeProducts} packages={activePackages} selectedItem={selectedItem} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}