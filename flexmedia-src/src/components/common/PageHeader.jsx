import { cn } from "@/lib/utils";

export default function PageHeader({ title, description, icon: Icon, action, subtitle, className }) {
  return (
    <div className={cn("mb-8 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4", className)}>
      <div className="flex items-start gap-3">
        {Icon && <Icon className="h-8 w-8 text-primary mt-1 flex-shrink-0" />}
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
          {description && <p className="text-muted-foreground mt-2">{description}</p>}
        </div>
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}