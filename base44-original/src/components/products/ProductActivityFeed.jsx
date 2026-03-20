import { useState } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Clock, ChevronDown, ChevronRight, User, Plus, Edit, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";

const actionConfig = {
  create: { label: "Created", icon: Plus, cls: "bg-green-100 text-green-700 border-green-200" },
  update: { label: "Updated", icon: Edit, cls: "bg-blue-100 text-blue-700 border-blue-200" },
  delete: { label: "Deleted", icon: Trash2, cls: "bg-red-100 text-red-700 border-red-200" }
};

export default function ProductActivityFeed({ productId }) {
  const [expanded, setExpanded] = useState({});
  const filter = productId ? { product_id: productId } : null;
  const { data: logs, loading } = useEntityList("ProductAuditLog", "-created_date", productId ? 100 : 200, filter);

  const filtered = logs;

  const toggle = (id) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  if (loading) return <div className="py-8 text-center text-sm text-muted-foreground">Loading activity...</div>;

  if (filtered.length === 0) {
    return (
      <Card className="p-8 text-center">
        <Clock className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
        <p className="text-muted-foreground text-sm">No activity recorded yet</p>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {filtered.map(log => {
        const cfg = actionConfig[log.action] || actionConfig.update;
        const Icon = cfg.icon;
        const isExpanded = expanded[log.id];
        const hasDetails = log.changed_fields?.length > 0 || log.changes_summary;

        return (
          <Card key={log.id} className="p-4">
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center flex-shrink-0 mt-0.5">
                <User className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{log.user_name || log.user_email || "System"}</span>
                  <Badge className={`text-xs border ${cfg.cls}`}>
                    <Icon className="h-3 w-3 mr-1" />
                    {cfg.label}
                  </Badge>
                  <span className="text-sm font-medium">{log.product_name}</span>
                </div>
                {log.changes_summary && (
                  <p className="text-xs text-muted-foreground mt-1">{log.changes_summary}</p>
                )}
                <div className="flex items-center gap-3 mt-1">
                   <span className="text-xs text-muted-foreground">
                     {log.created_date ? formatDistanceToNow(new Date(fixTimestamp(log.created_date)), { addSuffix: true }) : "—"}
                   </span>
                  {hasDetails && (
                    <button
                      onClick={() => toggle(log.id)}
                      className="text-xs text-primary flex items-center gap-0.5 hover:underline"
                    >
                      {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      {isExpanded ? "Hide" : "Details"}
                    </button>
                  )}
                </div>

                {isExpanded && log.changed_fields?.length > 0 && (
                  <div className="mt-2 space-y-1 border-l-2 border-muted pl-3">
                    {log.changed_fields.map((cf, i) => (
                      <div key={i} className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{cf.field}</span>:{" "}
                        <span className="line-through text-red-500">{cf.old_value || "—"}</span>
                        {" → "}
                        <span className="text-green-600">{cf.new_value || "—"}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}