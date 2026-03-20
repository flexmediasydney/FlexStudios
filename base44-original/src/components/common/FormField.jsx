import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export default function FormField({
  label,
  error,
  required,
  type = "text",
  as = "input",
  hint,
  className,
  ...props
}) {
  const Component = as === "textarea" ? Textarea : as === "select" ? "select" : Input;

  return (
    <div className={cn("space-y-1", className)}>
      {label && (
        <Label className="text-sm font-medium">
          {label}
          {required && <span className="text-destructive ml-1">*</span>}
        </Label>
      )}
      <Component
        {...props}
        className={cn("w-full", error && "border-destructive focus-visible:ring-destructive")}
      />
      {error && <p className="text-xs text-destructive mt-1">{error}</p>}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}