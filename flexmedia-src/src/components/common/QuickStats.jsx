import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function QuickStats({ stats = [], loading = false, columns = 4 }) {
  const colMap = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 6: "grid-cols-6" };

  if (loading) {
    return (
      <div className={cn("grid gap-4", colMap[columns])}>
        {[...Array(4)].map((_, i) => (
          <Card key={i} className="p-4">
            <Skeleton className="h-4 w-20 mb-2" />
            <Skeleton className="h-8 w-24" />
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className={cn("grid gap-4", colMap[columns])}>
      {stats.map((stat, i) => (
        <Card key={i} className="p-4 hover:shadow-md transition-shadow">
          <p className="text-xs font-medium text-muted-foreground">{stat.label}</p>
          <p className="text-2xl font-bold mt-1">{stat.value}</p>
          {stat.subtext && <p className="text-xs text-muted-foreground mt-1">{stat.subtext}</p>}
        </Card>
      ))}
    </div>
  );
}