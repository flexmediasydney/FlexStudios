import { Users, Copy, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";

export default function EmailHeaderInfo({ from, fromName, to = [], cc = [], bcc = [] }) {
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied");
  };

  const renderAddresses = (addresses, label) => {
    if (!addresses?.length) return null;
    
    const displayText = addresses.join(", ");
    
    return (
      <div className="flex items-start gap-3 py-2">
        <span className="text-xs font-semibold text-muted-foreground min-w-12">{label}:</span>
        <div className="flex-1 flex items-center gap-2">
          <span className="text-sm break-all">{displayText}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => copyToClipboard(displayText)}
          >
            <Copy className="h-3 w-3" />
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-muted/30 rounded-lg p-3 space-y-2 text-sm mb-4">
      <div className="flex items-start gap-3">
        <span className="text-xs font-semibold text-muted-foreground min-w-12">From:</span>
        <div className="flex-1 flex items-center gap-2">
          <span className="break-all">{fromName || from}</span>
          <span className="text-xs text-muted-foreground">({from})</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => copyToClipboard(from)}
          >
            <Copy className="h-3 w-3" />
          </Button>
        </div>
      </div>
      
      {renderAddresses(to, "To")}
      {renderAddresses(cc, "CC")}
      {renderAddresses(bcc, "BCC")}
    </div>
  );
}