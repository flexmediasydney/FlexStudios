import { Label as LabelUI } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export default function Label({ children, required, optional, hint, className, ...props }) {
  return (
    <div className="space-y-1">
      <LabelUI className={cn("text-sm font-medium", className)} {...props}>
        {children}
        {required && <span className="text-destructive ml-1">*</span>}
        {optional && <span className="text-muted-foreground ml-1 text-xs">(optional)</span>}
      </LabelUI>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}