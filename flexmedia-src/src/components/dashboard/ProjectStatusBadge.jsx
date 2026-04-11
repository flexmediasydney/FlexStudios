import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { stageConfig } from "@/components/projects/projectStatuses";

export default function ProjectStatusBadge({ status }) {
  const config = stageConfig(status);
  return (
    <Badge variant="outline" className={cn("font-medium border", config.color, config.textColor, config.borderColor)} title={`Status: ${config.label}`}>
      {config.label}
    </Badge>
  );
}