import { ArrowUp, ArrowDown } from "lucide-react";

export default function SortIndicator({ sortBy, sortOrder, columnKey }) {
  if (sortBy !== columnKey) return null;

  const Icon = sortOrder === "asc" ? ArrowUp : ArrowDown;
  return <Icon className="h-4 w-4 inline ml-1" />;
}