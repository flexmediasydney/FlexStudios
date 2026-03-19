import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function InputGroup({ icon: Icon, button, children, className }) {
  return (
    <div className={cn("relative flex items-center", className)}>
      {Icon && <Icon className="absolute left-3 h-4 w-4 text-muted-foreground" />}
      <div className={cn("flex-1", Icon && "pl-10")}>
        {children}
      </div>
      {button && <div className="absolute right-1">{button}</div>}
    </div>
  );
}