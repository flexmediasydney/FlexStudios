import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export default function FloatingActionButton({ onClick, icon: Icon = Plus, label, position = "bottom-right", className }) {
  const positions = {
    "bottom-right": "bottom-6 right-6",
    "bottom-left": "bottom-6 left-6",
    "top-right": "top-6 right-6",
    "top-left": "top-6 left-6",
  };

  return (
    <Button
      onClick={onClick}
      size="lg"
      className={cn(
        "fixed rounded-full shadow-lg hover:shadow-xl transition-shadow",
        positions[position],
        className
      )}
    >
      <Icon className="h-6 w-6 mr-2" />
      {label}
    </Button>
  );
}