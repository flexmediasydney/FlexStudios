import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

export default function InfoBox({ children, type = "info", icon: Icon = Info, title, className }) {
  const typeMap = {
    info: "bg-blue-50 border-blue-200 text-blue-900",
    success: "bg-green-50 border-green-200 text-green-900",
    warning: "bg-amber-50 border-amber-200 text-amber-900",
    error: "bg-red-50 border-red-200 text-red-900",
  };

  return (
    <div className={cn("p-4 rounded-lg border", typeMap[type], className)}>
      <div className="flex gap-3">
        <Icon className="h-5 w-5 flex-shrink-0 mt-0.5" />
        <div>
          {title && <h4 className="font-semibold mb-1">{title}</h4>}
          <p className="text-sm">{children}</p>
        </div>
      </div>
    </div>
  );
}