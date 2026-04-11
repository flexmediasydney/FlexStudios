import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { MoreVertical } from "lucide-react";

export default function ActionMenu({ actions = [], children }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {children || <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label="Open actions menu"><MoreVertical className="h-4 w-4" /></Button>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action, idx) => (
          action.separator ? (
            <DropdownMenuSeparator key={idx} />
          ) : (
            <DropdownMenuItem key={idx} onClick={action.onClick} disabled={action.disabled} className={action.danger ? "text-red-600 focus:text-red-600" : ""}>
              {action.icon && <action.icon className="h-4 w-4 mr-2" />}
              {action.label}
            </DropdownMenuItem>
          )
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}