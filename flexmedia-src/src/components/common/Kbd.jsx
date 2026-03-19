import { cn } from "@/lib/utils";

export default function Kbd({ children, className }) {
  return (
    <kbd className={cn(
      "px-2 py-1 rounded border border-gray-300 bg-gray-100 font-mono text-xs font-semibold text-gray-800",
      className
    )}>
      {children}
    </kbd>
  );
}