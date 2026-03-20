import { CheckCircle, Clock, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const statusIcons = {
  completed: CheckCircle,
  pending: Clock,
  error: AlertCircle,
};

export default function Timeline({ items = [] }) {
  return (
    <div className="space-y-6">
      {items.map((item, idx) => {
        const Icon = statusIcons[item.status] || Clock;
        const isLast = idx === items.length - 1;

        return (
          <div key={idx} className="flex gap-4">
            <div className="flex flex-col items-center">
              <Icon className={cn("h-6 w-6", {
                "text-green-600": item.status === "completed",
                "text-blue-600": item.status === "pending",
                "text-red-600": item.status === "error",
              })} />
              {!isLast && <div className="w-0.5 h-12 bg-border mt-2" />}
            </div>
            <div className="pb-6">
              <h4 className="font-semibold">{item.title}</h4>
              {item.description && <p className="text-sm text-muted-foreground mt-1">{item.description}</p>}
              {item.timestamp && <p className="text-xs text-muted-foreground mt-2">{item.timestamp}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}