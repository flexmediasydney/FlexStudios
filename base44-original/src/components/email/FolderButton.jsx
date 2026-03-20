import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export default function FolderButton({
  folder,
  isActive,
  count,
  onClick,
  title
}) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
        isActive 
          ? "bg-primary/90 text-primary-foreground shadow-sm" 
          : "hover:bg-muted/80 text-muted-foreground hover:text-foreground"
      )}
      title={title}
    >
      <span className="flex items-center gap-2 w-full">
        <span>{folder.icon} {folder.name}</span>
        {count > 0 && <Badge variant="secondary" className="ml-auto text-[10px] h-4 px-1.5">{count}</Badge>}
      </span>
    </button>
  );
}