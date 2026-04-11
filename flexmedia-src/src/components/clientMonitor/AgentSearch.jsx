import React, { useState } from "react";
import { api } from "@/api/supabaseClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";

export default function AgentSearch({ onSelect }) {
  const [searchInput, setSearchInput] = useState("");
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const handleSearch = async (value) => {
    setSearchInput(value);

    if (value.length < 2) {
      setResults([]);
      return;
    }

    setIsLoading(true);
    try {
      const agents = await api.entities.Agent.list();
      const filtered = agents
        .filter(
          (agent) =>
            agent.name.toLowerCase().includes(value.toLowerCase()) ||
            (agent.email && agent.email.toLowerCase().includes(value.toLowerCase()))
        )
        .slice(0, 10);
      setResults(filtered);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search agents by name or email..."
          value={searchInput}
          onChange={(e) => handleSearch(e.target.value)}
          className="pl-10"
        />
        {isLoading && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((agent) => (
            <Card
              key={agent.id}
              className="p-3 cursor-pointer hover:bg-muted/50 transition-all duration-200"
              onClick={() => onSelect(agent)}
            >
              <div className="font-medium text-sm text-foreground">{agent.name}</div>
              <div className="text-sm text-muted-foreground">{agent.email}</div>
              {agent.current_agency_name && (
                <div className="text-xs text-muted-foreground">
                  {agent.current_agency_name}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {searchInput.length >= 2 && results.length === 0 && !isLoading && (
        <div className="text-center py-6 text-muted-foreground text-sm">
          <p>No agents found matching "{searchInput}"</p>
        </div>
      )}
    </div>
  );
}