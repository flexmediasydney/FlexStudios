import { cn } from "@/lib/utils"

const SHAPE_CLASSES = {
  line: "rounded-md h-4 w-full",
  circle: "rounded-full aspect-square",
  card: "rounded-xl h-28 w-full",
  avatar: "rounded-full h-10 w-10",
  text: "rounded h-3 w-3/4",
};

function Skeleton({
  className,
  shape,
  ...props
}) {
  return (
    <div
      role="status"
      aria-label="Loading"
      aria-busy="true"
      data-testid="skeleton"
      className={cn(
        "animate-pulse rounded-md bg-muted",
        shape && SHAPE_CLASSES[shape],
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }