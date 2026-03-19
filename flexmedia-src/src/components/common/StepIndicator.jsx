import { Check, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

export default function StepIndicator({ steps = [], currentStep = 0, className }) {
  return (
    <div className={cn("flex items-center justify-between", className)}>
      {steps.map((step, idx) => {
        const isCompleted = idx < currentStep;
        const isCurrent = idx === currentStep;

        return (
          <div key={idx} className="flex flex-col items-center flex-1">
            <div className={cn(
              "flex items-center justify-center h-10 w-10 rounded-full font-semibold transition-colors",
              isCompleted ? "bg-green-500 text-white" : isCurrent ? "bg-primary text-white" : "bg-muted text-muted-foreground"
            )}>
              {isCompleted ? <Check className="h-5 w-5" /> : idx + 1}
            </div>
            <p className={cn("text-xs mt-2 text-center", isCurrent && "font-medium text-primary")}>
              {step}
            </p>
            {idx < steps.length - 1 && (
              <div className={cn(
                "h-1 flex-1 mx-2 mt-5 mb-5",
                isCompleted ? "bg-green-500" : "bg-muted"
              )} />
            )}
          </div>
        );
      })}
    </div>
  );
}