import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Edit, Trash2 } from "lucide-react";
import Price from '@/components/common/Price';

export default function PackageKanbanView({ packages, onEdit, onDelete, projectTypes = [] }) {
  const grouped = {
    active: packages.filter(p => p.is_active),
    inactive: packages.filter(p => !p.is_active)
  };

  const renderColumn = (title, items) => {
    return (
      <div className="flex flex-col bg-slate-50 rounded-lg p-4 min-h-96 flex-1">
        <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
          {title}
          <Badge variant="outline">{items.length}</Badge>
        </h3>
        <div className="space-y-2 flex-1">
          {items.map((pkg) => {
            const typeId = (pkg.project_type_ids || [])[0];
            const projectType = typeId ? projectTypes.find(t => t.id === typeId) : null;
            return (
              <div key={pkg.id} className="bg-white border rounded-lg p-3 hover:shadow transition-shadow">
                <div className="flex items-start justify-between gap-1">
                  <h4 className="font-medium text-sm truncate">{pkg.name}</h4>
                  {projectType ? (
                    <span
                      className="flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium text-white"
                      style={{ backgroundColor: projectType.color || "#3b82f6" }}
                    >
                      {projectType.name}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">All</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{pkg.description}</p>

                <div className="text-xs text-muted-foreground mt-2">
                  <div className="mb-1">
                    <strong>{pkg.products?.length || 0}</strong> products
                  </div>
                  {pkg.products?.slice(0, 2).map((product, idx) => (
                    <div key={idx} className="text-xs">• {product.product_name}</div>
                  ))}
                  {pkg.products?.length > 2 && <div className="text-xs">+ {pkg.products.length - 2} more</div>}
                </div>

                <div className="text-xs text-muted-foreground mt-2">
                  <div>Std: <Price value={pkg.standard_tier?.package_price} /></div>
                  <div>Prem: <Price value={pkg.premium_tier?.package_price} /></div>
                </div>

                <div className="flex gap-1 mt-2">
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs flex-1" onClick={() => onEdit(pkg)}>
                    <Edit className="h-3 w-3 mr-0.5" />
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs flex-1 text-destructive" onClick={() => onDelete(pkg)}>
                    <Trash2 className="h-3 w-3 mr-0.5" />
                    Delete
                  </Button>
                </div>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="text-center py-8 text-sm text-muted-foreground">No packages</div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {renderColumn("Active", grouped.active)}
      {renderColumn("Inactive", grouped.inactive)}
    </div>
  );
}