import { cn } from "@/lib/utils";

export default function TextTruncate({ children, lines = 1, className }) {
  return (
    <p className={cn(
      "overflow-hidden text-ellipsis",
      lines === 1 ? "line-clamp-1" : `line-clamp-${lines}`,
      className
    )} title={children}>
      {children}
    </p>
  );
}