import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useState } from "react";

export default function SearchInput({ onSearch, placeholder = "Search...", debounce = 300 }) {
  const [value, setValue] = useState("");

  const handleChange = (e) => {
    const newValue = e.target.value;
    setValue(newValue);
    onSearch(newValue);
  };

  return (
    <div className="relative flex-1 max-w-sm">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <Input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        className="pl-10 pr-8"
      />
      {value && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setValue(""); onSearch(""); }}
          className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
          title="Clear search"
          aria-label="Clear search"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}