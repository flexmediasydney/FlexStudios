import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NoPermission({ title = "Access Denied", message, action }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-64 text-center">
      <Lock className="h-12 w-12 text-muted-foreground mb-4" />
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-muted-foreground mb-4 max-w-sm">{message || "You don't have permission to access this resource."}</p>
      {action && <Button onClick={action.onClick}>{action.label}</Button>}
    </div>
  );
}