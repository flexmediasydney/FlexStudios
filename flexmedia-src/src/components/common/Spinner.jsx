import { cn } from "@/lib/utils";

export default function Spinner({ size = "default", className }) {
  const sizeMap = {
    small: "h-4 w-4",
    default: "h-6 w-6",
    large: "h-8 w-8",
  };

  return (
    <div className={cn("inline-block animate-spin rounded-full border border-primary border-t-transparent", sizeMap[size], className)} />
  );
}