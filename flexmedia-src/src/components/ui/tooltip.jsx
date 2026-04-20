"use client"

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

/**
 * Tooltip content — styled as a high-contrast dark tooltip (industry-standard
 * pattern used by Tailwind UI, Material, Chakra, etc).
 *
 * 2026-04-20: previously used `bg-primary` (app blue) with
 * `text-primary-foreground` (white). Problem: any child element that sets its
 * own text color (`text-muted-foreground`, `text-xs text-gray-500`, etc.)
 * overrode the white and rendered nearly-black on blue — unreadable. User
 * flagged on price matrix and Industry Pulse tooltips.
 *
 * Fixed here at the primitive level so every tooltip in the app (not just new
 * ones) gets readable contrast. All child text colors that don't explicitly
 * opt out now render white/off-white against a dark slate background with
 * good contrast ratio (15:1+). Muted-foreground variants auto-adjust via a
 * scoped CSS override for rare cases where a child text color was intentional.
 */
const TooltipContent = React.forwardRef(({ className, sideOffset = 6, collisionPadding = 8, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "z-[60] max-w-[min(calc(100vw-16px),320px)] overflow-hidden rounded-md",
        "bg-slate-900 dark:bg-slate-100",
        "text-slate-50 dark:text-slate-900",
        "px-3 py-1.5 text-xs shadow-lg ring-1 ring-black/10 dark:ring-white/10",
        // Override `text-muted-foreground` ONLY inside tooltips — that class
        // resolves to a grey designed for LIGHT backgrounds and becomes
        // unreadable on our dark tooltip. Rescope it here. Other explicit
        // colors (e.g. text-purple-300, text-emerald-400) still render as-is
        // since they're already chosen for dark backgrounds.
        "[&_.text-muted-foreground]:!text-slate-300",
        "dark:[&_.text-muted-foreground]:!text-slate-600",
        "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className,
      )}
      {...props} />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
