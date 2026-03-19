import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export default function LoadingOverlay({ isVisible = false, text = "Loading...", fullScreen = false }) {
  if (!isVisible) return null;

  return (
    <div className={cn(
      "flex items-center justify-center gap-3 bg-black/50 z-50",
      fullScreen ? "fixed inset-0" : "absolute inset-0 rounded-lg"
    )}>
      <Loader2 className="h-6 w-6 text-white animate-spin" />
      <p className="text-white font-medium">{text}</p>
    </div>
  );
}