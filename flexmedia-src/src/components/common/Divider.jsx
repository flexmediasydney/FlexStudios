import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export default function Divider({ label, vertical = false, className }) {
  if (vertical) {
    return <Separator orientation="vertical" className={cn("h-6", className)} />;
  }

  if (label) {
    return (
      <div className={cn("flex items-center gap-4", className)}>
        <Separator className="flex-1" />
        <span className="text-xs text-muted-foreground">{label}</span>
        <Separator className="flex-1" />
      </div>
    );
  }

  return <Separator className={className} />;
}