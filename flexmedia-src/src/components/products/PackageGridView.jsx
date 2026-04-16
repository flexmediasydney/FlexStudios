import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Edit, Trash2 } from "lucide-react";
import Price from '@/components/common/Price';

export default function PackageGridView({ packages, onEdit, onDelete, projectTypes = [] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {packages.map((pkg) => {
        const typeId = (pkg.project_type_ids || [])[0];
        const projectType = typeId ? projectTypes.find(t => t.id === typeId) : null;
        return (
          <div key={pkg.id} className="border rounded-lg p-4 hover:shadow-md transition-shadow">
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-semibold text-lg truncate">{pkg.name}</h3>
                  <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{pkg.description}</p>
                </div>
                {projectType ? (
                  <span
                    className="flex-shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium text-white mt-1"
                    style={{ backgroundColor: projectType.color || "#3b82f6" }}
                  >
                    {projectType.name}
                  </span>
                ) : (
                  <span className="flex-shrink-0 text-xs text-muted-foreground mt-1">All</span>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Products Included:</span>
                  <Badge variant="secondary">{pkg.products?.length || 0}</Badge>
                </div>
                {pkg.products?.slice(0, 3).map((product, idx) => (
                  <div key={idx} className="text-xs text-muted-foreground pl-2 border-l-2 border-muted">
                    {product.product_name} (qty: {product.quantity})
                  </div>
                ))}
                {pkg.products?.length > 3 && (
                  <div className="text-xs text-muted-foreground italic">+{pkg.products.length - 3} more</div>
                )}
              </div>

              <div className="space-y-1 text-sm border-t pt-3">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Standard:</span>
                  <span className="font-medium"><Price value={pkg.standard_tier?.package_price} /></span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Premium:</span>
                  <span className="font-medium"><Price value={pkg.premium_tier?.package_price} /></span>
                </div>
                {((pkg.standard_task_templates || []).length > 0 || (pkg.premium_task_templates || []).length > 0) && (
                  <div className="flex justify-between pt-1 border-t mt-1">
                    <span className="text-muted-foreground">Task Templates:</span>
                    <div className="flex gap-2">
                      <Badge variant="outline" className="text-[10px]">Std: {(pkg.standard_task_templates || []).length}</Badge>
                      <Badge variant="outline" className="text-[10px]">Prm: {(pkg.premium_task_templates || []).length}</Badge>
                    </div>
                  </div>
                )}
              </div>

              <Badge variant="outline" className={pkg.is_active ? "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-800" : "bg-gray-100 dark:bg-gray-800"}>
                {pkg.is_active ? "Active" : "Inactive"}
              </Badge>

              <div className="flex gap-2 pt-2 border-t">
                <Button variant="ghost" size="sm" className="flex-1" onClick={() => onEdit(pkg)}>
                  <Edit className="h-4 w-4 mr-1" />
                  Edit
                </Button>
                <Button variant="ghost" size="sm" className="flex-1 text-destructive" onClick={() => onDelete(pkg)}>
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