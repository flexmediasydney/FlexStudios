import { cn } from "@/lib/utils";

export default function NotificationBadge({ count = 0, children, className, maxCount = 99 }) {
  const displayCount = count > maxCount ? `${maxCount}+` : count;
  const showBadge = count > 0;

  return (
    <div className={cn("relative inline-block", className)}>
      {children}
      {showBadge && (
        <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs font-bold rounded-full h-5 w-5 flex items-center justify-center">
          {displayCount}
        </span>
      )}
    </div>
  );
}