import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export default function FeatureGrid({ features = [], columns = 3, className }) {
  return (
    <div className={cn(`grid gap-6 grid-cols-1 md:grid-cols-${Math.min(columns, 2)} lg:grid-cols-${columns}`, className)}>
      {features.map((feature, idx) => {
        const Icon = feature.icon;

        return (
          <Card key={idx} className="p-6 hover:shadow-lg transition-shadow">
            <div className="flex flex-col items-start gap-3">
              {Icon && (
                <div className="p-3 rounded-lg bg-primary/10">
                  <Icon className="h-6 w-6 text-primary" />
                </div>
              )}
              <h3 className="font-semibold">{feature.title}</h3>
              <p className="text-sm text-muted-foreground">{feature.description}</p>
            </div>
          </Card>
        );
      })}
    </div>
  );
}