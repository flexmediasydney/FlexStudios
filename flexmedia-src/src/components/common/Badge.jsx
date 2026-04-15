import { cn } from "@/lib/utils";

const statusBadges = {
  success: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  error: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  info: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  neutral: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
  primary: "bg-primary/10 text-primary",
};

export default function StatusBadge({ status = "neutral", children, className, dot = false }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium", statusBadges[status], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />}
      {children}
    </span>
  );
}