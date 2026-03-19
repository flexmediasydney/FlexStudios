import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function EmptyState({ icon: Icon = AlertCircle, title, description, action, className }) {
  return (
    <div className={`flex flex-col items-center justify-center py-12 text-center ${className || ""}`}>
      <Icon className="h-12 w-12 text-muted-foreground mb-4" />
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      {description && <p className="text-muted-foreground mb-4 max-w-sm">{description}</p>}
      {action && <Button onClick={action.onClick}>{action.label}</Button>}
    </div>
  );
}