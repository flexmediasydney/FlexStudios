import { useState, useMemo } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";

export default function ProductCategoryHierarchy() {
  const { data: projectTypes = [] } = useEntityList("ProjectType", "order");
  const { data: productCategories = [] } = useEntityList("ProductCategory", "order");
  const { data: products = [] } = useEntityList("Product", "name");
  const { data: packages = [] } = useEntityList("Package", "name");
  
  const [expandedTypes, setExpandedTypes] = useState({});
  const [expandedCategories, setExpandedCategories] = useState({});

  const toggleTypeExpanded = (typeId) => {
    setExpandedTypes(prev => ({ ...prev, [typeId]: !prev[typeId] }));
  };

  const toggleCategoryExpanded = (catId) => {
    setExpandedCategories(prev => ({ ...prev, [catId]: !prev[catId] }));
  };

  // Build hierarchy: ProjectType -> ProductCategory -> Products -> Packages
  const hierarchy = useMemo(() => {
    return projectTypes.map(projectType => {
      const typeCategories = productCategories.filter(pc => pc.project_type_id === projectType.id);
      
      const expandedCategories_data = typeCategories.map(category => {
        const categoryProducts = products.filter(p => 
          (p.project_type_ids || []).length === 0 || (p.project_type_ids || []).includes(projectType.id)
        ).filter(p => p.category === category.name.toLowerCase().replace(/\s+/g, '_'));

        const expandedProducts = categoryProducts.map(product => {
          const productPackages = packages.filter(pkg =>
            pkg.products?.some(item => item.product_id === product.id)
          );
          return { product, packages: productPackages };
        });

        return { category, products: expandedProducts };
      });

      return { projectType, categories: expandedCategories_data };
    });
  }, [projectTypes, productCategories, products, packages]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-2">Project Type → Category → Product → Package Hierarchy</h2>
        <p className="text-muted-foreground">View how products and packages are organized by project type and category.</p>
      </div>

      <div className="space-y-4">
        {hierarchy.map(({ projectType, categories }) => (
          <Card key={projectType.id} className="overflow-hidden">
            <CardHeader 
              className="pb-3 cursor-pointer hover:bg-muted/50 transition"
              onClick={() => toggleTypeExpanded(projectType.id)}
            >
              <div className="flex items-center gap-3">
                {expandedTypes[projectType.id] ? 
                  <ChevronDown className="h-5 w-5" /> : 
                  <ChevronRight className="h-5 w-5" />
                }
                <div className="flex-1">
                  <CardTitle className="text-lg">{projectType.name}</CardTitle>
                  <CardDescription>
                    {categories.length} categor{categories.length !== 1 ? "ies" : "y"} • {products.filter(p => (p.project_type_ids || []).length === 0 || (p.project_type_ids || []).includes(projectType.id)).length} products
                  </CardDescription>
                </div>
                <Badge variant="outline" style={{ backgroundColor: projectType.color, color: "#fff" }}>
                  {projectType.name}
                </Badge>
              </div>
            </CardHeader>

            {expandedTypes[projectType.id] && (
              <CardContent className="pt-0 pl-12 space-y-3">
                {categories.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No categories defined for this project type</p>
                ) : (
                  categories.map(({ category, products: categoryProducts }) => (
                    <div 
                      key={category.id}
                      className="border rounded-lg bg-muted/30 p-3 space-y-2 cursor-pointer hover:bg-muted/50 transition"
                      onClick={() => toggleCategoryExpanded(category.id)}
                    >
                      <div className="flex items-center gap-3">
                        {expandedCategories[category.id] ? 
                          <ChevronDown className="h-4 w-4" /> : 
                          <ChevronRight className="h-4 w-4" />
                        }
                        <div className="flex-1">
                          <p className="font-medium text-sm">{category.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {categoryProducts.length} product{categoryProducts.length !== 1 ? "s" : ""}
                          </p>
                        </div>
                        {category.icon && <span className="text-lg">{category.icon}</span>}
                      </div>

                      {expandedCategories[category.id] && (
                        <div className="pl-7 space-y-2 mt-2">
                          {categoryProducts.length === 0 ? (
                            <p className="text-xs text-muted-foreground italic">No products in this category</p>
                          ) : (
                            categoryProducts.map(({ product, packages: productPackages }) => (
                              <div key={product.id} className="bg-card rounded p-2 border border-border/50">
                                <div className="flex items-start justify-between gap-2 mb-1">
                                  <div>
                                    <p className="text-sm font-medium">{product.name}</p>
                                    <div className="flex gap-1 flex-wrap mt-1">
                                      <Badge variant="outline" className="text-xs">
                                        {product.pricing_type === "per_unit" ? "Per Unit" : "Fixed"}
                                      </Badge>
                                      <Badge 
                                        variant="outline" 
                                        className={`text-xs ${product.product_type === "core" ? "bg-blue-50" : "bg-amber-50"}`}
                                      >
                                        {product.product_type === "core" ? "Core" : "Add-on"}
                                      </Badge>
                                      {!product.is_active && (
                                        <Badge variant="destructive" className="text-xs">Inactive</Badge>
                                      )}
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-xs font-semibold text-blue-600">
                                      ${product.standard_tier?.base_price?.toFixed(2) || "0.00"}
                                    </p>
                                    <p className="text-xs text-muted-foreground">Std</p>
                                  </div>
                                </div>

                                {productPackages.length > 0 && (
                                  <div className="mt-2 pl-2 border-l-2 border-accent space-y-1">
                                    <p className="text-xs font-medium text-muted-foreground">Used in:</p>
                                    {productPackages.map(pkg => (
                                      <div key={pkg.id} className="text-xs bg-accent/10 rounded px-2 py-1">
                                        <p className="font-medium">{pkg.name}</p>
                                        <p className="text-muted-foreground">
                                          ${pkg.standard_tier?.package_price?.toFixed(2) || "0.00"} (Standard)
                                        </p>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            )}
          </Card>
        ))}

        {hierarchy.length === 0 && (
          <Card>
            <CardContent className="pt-6 text-center text-muted-foreground">
              <p>No project types defined. Create project types and product categories to see the hierarchy.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}