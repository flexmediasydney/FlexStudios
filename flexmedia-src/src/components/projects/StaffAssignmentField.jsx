import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronRight, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function StaffAssignmentField({
  label,
  value,
  onChange,
  options, // Array of { id, label, type: "user" | "team" }
  placeholder = "Assign staff...",
  defaultOption = null, // { id: '__use_default__', label: 'Use Default (Name)', type: 'user'|'team' }
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef(null);

  const filtered = options.filter(opt =>
    opt.label.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedOption = value ? options.find(opt => opt.id === value.id) : null;

  return (
    <div className="relative" ref={containerRef}>
      {value && selectedOption ? (
        <div className="flex items-center justify-between p-3 bg-gradient-to-r from-primary/5 to-transparent rounded-lg border border-primary/10 hover:border-primary/20 transition-colors group">
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm text-foreground">{selectedOption.label}</div>
            <Badge variant="secondary" className="mt-1 text-xs">
              {selectedOption.type === "team" ? "Team" : "Individual"}
            </Badge>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onChange(null)}
            className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-all"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start text-muted-foreground hover:text-foreground hover:bg-muted/50"
          onClick={() => setOpen(!open)}
        >
          <span className="truncate">{placeholder}</span>
        </Button>
      )}

      {open && (
        <Card className="absolute top-full mt-2 w-full z-50 p-0 shadow-xl border-primary/20 rounded-lg overflow-hidden">
          <div className="p-3 border-b bg-muted/30">
            <Input
              placeholder={`Search ${label}...`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="border-0 bg-background focus-visible:ring-0 text-sm"
              autoFocus
            />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {/* "Use Default" option — always shown at top when available */}
            {defaultOption && !query && (
              <button
                key="__use_default__"
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(defaultOption);
                  setQuery("");
                  setOpen(false);
                }}
                className="w-full text-left px-4 py-3 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors border-b group bg-blue-50/50 dark:bg-blue-900/10"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm text-blue-700 dark:text-blue-400">{defaultOption.label}</div>
                    <div className="text-xs text-blue-600/70 dark:text-blue-400/70 mt-0.5">
                      Auto-assigned on save
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-blue-400 group-hover:text-blue-600 transition-colors flex-shrink-0" />
                </div>
              </button>
            )}
            {filtered.length > 0 ? (
              filtered.map((opt) => (
                <button
                  key={`${opt.type}:${opt.id}`}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange(opt);
                    setQuery("");
                    setOpen(false);
                  }}
                  className="w-full text-left px-4 py-3 hover:bg-primary/5 transition-colors border-b last:border-b-0 group"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm text-foreground">{opt.label}</div>
                      <div className="text-xs text-muted-foreground capitalize mt-0.5">
                        {opt.type === "team" ? "Team" : "Individual"}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0" />
                  </div>
                </button>
              ))
            ) : (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No staff available
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}