import * as React from "react"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/90 hover:shadow-md",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/90 hover:shadow-md",
        success:
          "border-transparent bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-950/60",
        warning:
          "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-950/60",
        outline: "text-foreground hover:bg-muted/50",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  ...props
}) {
  return (<div data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />);
}

export { Badge, badgeVariants }