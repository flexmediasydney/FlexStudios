import { Circle } from "lucide-react";
import { cn } from "@/lib/utils";

const statusMap = {
  active: "bg-green-500",
  pending: "bg-amber-500",
  inactive: "bg-gray-400",
  error: "bg-red-500",
};

export default function Status({ status, label, size = "sm", className }) {
  const sizeMap = { xs: "h-2 w-2", sm: "h-3 w-3", md: "h-4 w-4" };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Circle className={cn("fill-current", statusMap[status], sizeMap[size])} />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}