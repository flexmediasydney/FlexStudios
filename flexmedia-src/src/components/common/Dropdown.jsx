import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Dropdown({ label, children, align = "start", trigger }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger || (
          <Button variant="outline" className="gap-2" aria-haspopup="menu" aria-label={label ? `${label} menu` : 'Options menu'}>
            {label}
            <ChevronDown className="h-4 w-4 opacity-60" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {children || (
          <div className="px-3 py-2 text-sm text-muted-foreground">No options available</div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}