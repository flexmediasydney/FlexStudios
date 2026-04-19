//
// PulseShortcutHelp — "?" sheet listing every Industry Pulse keyboard
// shortcut. Slides in from the right so it sits next to the main canvas
// without obscuring it.
//

import React from "react";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";

// Human-readable shortcut spec. Groups render as separate sections.
const GROUPS = [
  {
    label: "Global",
    items: [
      { keys: ["⌘K", "Ctrl+K"],   desc: "Open command palette" },
      { keys: ["/"],              desc: "Focus quick search" },
      { keys: ["?"],              desc: "Show this help" },
      { keys: ["Esc"],            desc: "Close open slideout / dialog / palette" },
      { keys: ["n"],              desc: "Next tab" },
      { keys: ["p"],              desc: "Previous tab" },
    ],
  },
  {
    label: "Jump to tab (press g, then…)",
    items: [
      { keys: ["g", "c"], desc: "Command Center" },
      { keys: ["g", "a"], desc: "Agents" },
      { keys: ["g", "y"], desc: "Agencies" },
      { keys: ["g", "l"], desc: "Listings" },
      { keys: ["g", "e"], desc: "Events" },
      { keys: ["g", "m"], desc: "Market Data" },
      { keys: ["g", "s"], desc: "Market Share" },
      { keys: ["g", "r"], desc: "Retention" },
      { keys: ["g", "d"], desc: "Sources (data)" },
      { keys: ["g", "x"], desc: "Signals" },
      { keys: ["g", "t"], desc: "Timeline" },
    ],
  },
  {
    label: "Numeric",
    items: [
      { keys: ["1", "2", "…", "9"], desc: "Tabs 1–9" },
      { keys: ["0"],                desc: "Tab 10" },
      { keys: ["-"],                desc: "Tab 11" },
    ],
  },
];

function KeyChip({ k }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.25rem] px-1.5 py-0.5 text-[10px] rounded border bg-muted/60 text-foreground/80 font-mono">
      {k}
    </kbd>
  );
}

export default function PulseShortcutHelp({ open, onClose }) {
  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose?.(); }}>
      <SheetContent side="right" className="w-full sm:max-w-sm overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Keyboard shortcuts</SheetTitle>
          <SheetDescription className="text-xs">
            Move through Industry Pulse without touching the mouse.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-5">
          {GROUPS.map((g) => (
            <section key={g.label}>
              <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                {g.label}
              </h3>
              <ul className="space-y-1.5">
                {g.items.map((it, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs">
                    <span className="flex items-center gap-1">
                      {it.keys.map((k, ki) => (
                        <React.Fragment key={ki}>
                          {ki > 0 && <span className="text-muted-foreground">+</span>}
                          <KeyChip k={k} />
                        </React.Fragment>
                      ))}
                    </span>
                    <span className="text-foreground/80 flex-1 truncate">{it.desc}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="text-[10px] text-muted-foreground pt-2 border-t">
            Shortcuts are suppressed while you're typing in an input, textarea
            or content-editable element.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
