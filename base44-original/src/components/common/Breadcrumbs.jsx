import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { cn } from "@/lib/utils";

export default function Breadcrumbs({ items = [] }) {
  if (items.length === 0) return null;

  return (
    <nav className="flex items-center gap-1 text-sm mb-4">
      {items.map((item, idx) => (
        <div key={idx} className="flex items-center gap-1">
          {idx > 0 && <ChevronRight className="h-4 w-4 text-muted-foreground mx-1" />}
          {item.href ? (
            <Link to={createPageUrl(item.href)} className="text-primary hover:underline">
              {item.label}
            </Link>
          ) : (
            <span className={cn("text-muted-foreground", idx === items.length - 1 && "font-medium text-foreground")}>
              {item.label}
            </span>
          )}
        </div>
      ))}
    </nav>
  );
}