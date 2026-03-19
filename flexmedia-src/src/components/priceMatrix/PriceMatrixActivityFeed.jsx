import { useEntityList } from "@/components/hooks/useEntityData";
import { format } from "date-fns";
import { Clock, User, ChevronDown, ChevronRight, Building } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";

// priceMatrixId = null → show all logs (module-level)
// priceMatrixId = "xxx" → show logs for that specific matrix only
export default function PriceMatrixActivityFeed({ priceMatrixId = null }) {
  const [expandedLog, setExpandedLog] = useState(null);

  const { data: logs = [], loading: isLoading } = useEntityList(
    "PriceMatrixAuditLog",
    "-created_date",
    priceMatrixId ? 50 : 100,
    priceMatrixId ? (log) => log.price_matrix_id === priceMatrixId : null
  );

  if (isLoading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Loading activity...</div>;
  }

  if (logs.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No activity recorded yet. Changes will appear here after saving.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {logs.map((log) => (
        <div key={log.id} className="border rounded-lg overflow-hidden">
          <div
            className="flex items-start gap-3 p-3 cursor-pointer hover:bg-muted/30 transition-colors"
            onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
          >
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
              <User className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">{log.user_name || log.user_email || "System"}</span>
                {!priceMatrixId && log.entity_name && (
                  <Badge variant="outline" className="text-xs flex items-center gap-1">
                    {log.entity_type === "agency"
                      ? <Building className="h-3 w-3" />
                      : <User className="h-3 w-3" />
                    }
                    {log.entity_name}
                  </Badge>
                )}
                <span className="text-sm text-muted-foreground">{log.changes_summary}</span>
              </div>
              <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                {log.created_date
                  ? format(new Date(log.created_date), "dd MMM yyyy, h:mm a")
                  : "Unknown time"}
              </div>
            </div>
            <div className="flex-shrink-0">
              {expandedLog === log.id
                ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                : <ChevronRight className="h-4 w-4 text-muted-foreground" />
              }
            </div>
          </div>

          {expandedLog === log.id && log.changed_fields?.length > 0 && (
            <div className="border-t bg-muted/20 px-3 py-2">
              <div className="text-xs font-medium text-muted-foreground mb-2">Field Changes:</div>
              <div className="space-y-1.5">
                {log.changed_fields.map((change, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-xs flex-wrap">
                    <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                      {change.field}
                    </span>
                    <Badge variant="outline" className="text-red-600 border-red-200 px-1.5 py-0">
                      {change.old_value ?? "—"}
                    </Badge>
                    <span className="text-muted-foreground">→</span>
                    <Badge variant="outline" className="text-green-600 border-green-200 px-1.5 py-0">
                      {change.new_value ?? "—"}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {expandedLog === log.id && (!log.changed_fields || log.changed_fields.length === 0) && (
            <div className="border-t bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
              No field-level diff available for this change.
            </div>
          )}
        </div>
      ))}
    </div>
  );
}