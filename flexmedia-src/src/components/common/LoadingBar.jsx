import { cn } from "@/lib/utils";

export default function LoadingBar({ visible = true, className }) {
  if (!visible) return null;
  return (
    <div className={cn("h-1 w-full bg-gradient-to-r from-primary to-accent animate-pulse", className)} />
  );
}