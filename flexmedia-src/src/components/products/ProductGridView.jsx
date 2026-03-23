import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Edit, Trash2 } from "lucide-react";
import Price from '@/components/common/Price';

const categories = {
  photography: "Photography",
  video: "Video",
  drone: "Drone",
  editing: "Editing",
  virtual_staging: "Virtual Staging",
  other: "Other"
};

export default function ProductGridView({ products, onEdit, onDelete, projectTypes = [] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {products.map((product) => {
        const typeId = (product.project_type_ids || [])[0];
        const projectType = typeId ? projectTypes.find(t => t.id === typeId) : null;
        return (
          <div key={product.id} className="border rounded-lg p-4 hover:shadow-md transition-shadow">
            <div className="space-y-3">
              {product.thumbnail_url && (
                <img src={product.thumbnail_url} alt={product.name} className="w-full h-40 object-cover rounded" />
              )}
              <div>
                <h3 className="font-semibold text-lg truncate">{product.name}</h3>
                <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{product.description}</p>
              </div>

              <div className="flex gap-2 flex-wrap">
                <Badge variant={product.product_type === "core" ? "default" : "secondary"}>
                  {product.product_type === "core" ? "Core" : "Add-on"}
                </Badge>
                <Badge variant="outline">{categories[product.category] || product.category}</Badge>
                {projectType ? (
                  <span
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium text-white"
                    style={{ backgroundColor: projectType.color || "#3b82f6" }}
                  >
                    {projectType.name}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground self-center">All Types</span>
                )}
                <Badge variant="outline" className={product.is_active ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100"}>
                  {product.is_active ? "Active" : "Inactive"}
                </Badge>
              </div>

              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Standard:</span>
                  <span className="font-medium"><Price value={product.standard_tier?.base_price} /></span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Premium:</span>
                  <span className="font-medium"><Price value={product.premium_tier?.base_price} /></span>
                </div>
                {product.pricing_type === "per_unit" && (
                  <div className="text-xs text-muted-foreground mt-1">+ per-unit pricing</div>
                )}
              </div>

              <div className="flex gap-2 pt-2 border-t">
                <Button variant="ghost" size="sm" className="flex-1" onClick={() => onEdit(product)}>
                  <Edit className="h-4 w-4 mr-1" />
                  Edit
                </Button>
                <Button variant="ghost" size="sm" className="flex-1 text-destructive" onClick={() => onDelete(product)}>
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}