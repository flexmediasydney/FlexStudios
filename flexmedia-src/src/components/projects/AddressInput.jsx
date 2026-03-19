import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { base44 } from "@/api/base44Client";
import { Loader2, AlertCircle, MapPin } from "lucide-react";

export default function AddressInput({ value, onChange, placeholder }) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);
  const debounceTimer = useRef(null);

  useEffect(() => {
    if (!value || value.length < 2) {
      setSuggestions([]);
      setOpen(false);
      setError(null);
      return;
    }

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    
    debounceTimer.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await base44.functions.invoke('searchAustralianAddresses', {
          searchText: value
        });
        
        if (response.data?.error) {
          setError(response.data.error);
          setSuggestions([]);
        } else {
          setSuggestions(response.data?.predictions || []);
          setOpen(true);
        }
      } catch (err) {
        console.error('Error fetching address suggestions:', err);
        setError('Failed to fetch address suggestions');
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(debounceTimer.current);
  }, [value]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={containerRef}>
      <Input
        value={value || ""}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(e.target.value.length > 2);
        }}
        onFocus={() => value && value.length > 2 && setOpen(true)}
        placeholder={placeholder}
        className="pr-8"
      />
      {loading && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
      {open && (
        <Card className="absolute top-full mt-1 w-full z-50 p-0 shadow-lg max-h-64 overflow-y-auto">
          {error ? (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          ) : suggestions.length > 0 ? (
            suggestions.map((suggestion) => (
              <button
                key={suggestion.placeId}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(suggestion.description);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 hover:bg-muted transition-colors border-b last:border-b-0 text-sm flex items-start gap-2"
              >
                <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-foreground truncate">{suggestion.mainText}</div>
                  <div className="text-xs text-muted-foreground truncate">{suggestion.description}</div>
                </div>
              </button>
            ))
          ) : loading ? (
            <div className="flex items-center justify-center py-4 gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Searching...</span>
            </div>
          ) : (
            <div className="px-3 py-3 text-sm text-muted-foreground text-center">
              No addresses found
            </div>
          )}
        </Card>
      )}
    </div>
  );
}