import { Skeleton } from "@/components/ui/skeleton";

export default function SkeletonText({ lines = 3, lineHeight = "h-4", className }) {
  return (
    <div className={`space-y-2 ${className || ""}`}>
      {[...Array(lines)].map((_, i) => (
        <Skeleton key={i} className={`${lineHeight} ${i === lines - 1 ? "w-4/5" : "w-full"}`} />
      ))}
    </div>
  );
}