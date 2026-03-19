import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Edit, Trash2 } from "lucide-react";

const categories = {
  photography: "Photography",
  video: "Video",
  drone: "Drone",
  editing: "Editing",
  virtual_staging: "Virtual Staging",
  other: "Other"
};

export default function ProductKanbanView({ products, onEdit, onDelete, projectTypes = [] }) {
  const grouped = {
    core: products.filter(p => p.product_type === "core"),
    addon: products.filter(p => p.product_type === "addon")
  };

  const renderColumn = (title, items) => {
    return (
      <div className="flex flex-col bg-slate-50 rounded-lg p-4 min-h-96 flex-1">
        <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
          {title}
          <Badge variant="outline">{items.length}</Badge>
        </h3>
        <div className="space-y-2 flex-1">
          {items.map((product) => {
            const typeId = (product.project_type_ids || [])[0];
            const projectType = typeId ? projectTypes.find(t => t.id === typeId) : null;
            return (
              <div key={product.id} className="bg-white border rounded-lg p-3 hover:shadow transition-shadow">
                <h4 className="font-medium text-sm truncate">{product.name}</h4>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{product.description}</p>

                <div className="flex gap-1 flex-wrap mt-2">
                  <Badge variant="outline" className="text-xs">{categories[product.category]}</Badge>
                  {projectType ? (
                    <span
                      className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium text-white"
                      style={{ backgroundColor: projectType.color || "#3b82f6" }}
                    >
                      {projectType.name}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground self-center">All</span>
                  )}
                  <Badge variant="outline" className={`text-xs ${product.is_active ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100"}`}>
                    {product.is_active ? "Active" : "Inactive"}
                  </Badge>
                </div>

                <div className="text-xs text-muted-foreground mt-2">
                  <div>Std: ${product.standard_tier?.base_price?.toFixed(2) || "0.00"}</div>
                  <div>Prem: ${product.premium_tier?.base_price?.toFixed(2) || "0.00"}</div>
                </div>

                <div className="flex gap-1 mt-2">
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs flex-1" onClick={() => onEdit(product)}>
                    <Edit className="h-3 w-3 mr-0.5" />
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs flex-1 text-destructive" onClick={() => onDelete(product)}>
                    <Trash2 className="h-3 w-3 mr-0.5" />
                    Delete
                  </Button>
                </div>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="text-center py-8 text-sm text-muted-foreground">No products</div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {renderColumn("Core Services", grouped.core)}
      {renderColumn("Add-ons", grouped.addon)}
    </div>
  );
}