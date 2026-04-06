import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronRight } from "lucide-react";

export default function AgentSearchField({ agents, value, onChange, placeholder }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef(null);

  // Sync query when value is set externally (e.g. editing an existing project)
  useEffect(() => {
    if (!open) {
      setQuery(value?.name || "");
    }
  }, [value?.id, open]);

  const filtered = agents.filter(agent =>
    agent.name.toLowerCase().includes(query.toLowerCase()) ||
    agent.email?.toLowerCase().includes(query.toLowerCase()) ||
    agent.current_agency_name?.toLowerCase().includes(query.toLowerCase())
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

  const selectedAgent = value?.id ? agents.find(a => a.id === value.id) : null;

  return (
    <div className="relative" ref={containerRef}>
      <div className="relative">
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder || "Search agent..."}
          className="pr-12"
        />
        {selectedAgent && !open && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <Badge variant="secondary" className="text-xs bg-primary/10 text-primary">
              ✓ {(selectedAgent.name || 'Agent').split(" ")[0]}
            </Badge>
          </div>
        )}
      </div>

      {open && filtered.length > 0 && (
        <Card className="absolute top-full mt-1 w-full z-50 p-0 shadow-xl border border-primary/10 rounded-lg overflow-hidden">
          <div className="max-h-64 overflow-y-auto">
            {filtered.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(agent);
                  setQuery(agent.name);
                  setOpen(false);
                }}
                className="w-full text-left px-4 py-3 hover:bg-primary/5 transition-colors border-b last:border-b-0 group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm text-foreground">
                      {agent.name}
                    </div>
                    {agent.current_agency_name && (
                      <div className="text-xs text-muted-foreground">
                        {agent.current_agency_name}
                      </div>
                    )}
                    {agent.email && (
                      <div className="text-xs text-muted-foreground">
                        {agent.email}
                      </div>
                    )}
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0 mt-0.5" />
                </div>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}