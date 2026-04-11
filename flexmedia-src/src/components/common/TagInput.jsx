import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { cn } from "@/lib/utils";

export default function TagInput({ tags = [], onTagsChange, placeholder = "Add tags...", maxTags, label }) {
  const [input, setInput] = useState("");

  const handleKeyDown = (e) => {
    if ((e.key === "Enter" || e.key === ",") && input.trim()) {
      e.preventDefault();
      if (!maxTags || tags.length < maxTags) {
        onTagsChange([...tags, input.trim()]);
        setInput("");
      }
    }
    if (e.key === "Backspace" && !input && tags.length > 0) {
      onTagsChange(tags.slice(0, -1));
    }
  };

  const removeTag = (idx) => {
    onTagsChange(tags.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-2">
      {label && <label className="text-sm font-medium">{label}</label>}
      <div className="border rounded-lg p-2 space-y-2 focus-within:ring-1 focus-within:ring-primary transition-shadow">
        <div className="flex flex-wrap gap-2">
          {tags.map((tag, idx) => (
            <div key={idx} className="bg-primary/10 text-primary px-3 py-1 rounded-full text-sm flex items-center gap-2">
              {tag}
              <button onClick={() => removeTag(idx)} className="hover:opacity-70" aria-label={`Remove tag ${tag}`}>
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="border-0 p-0 focus-visible:ring-0"
        />
      </div>
      {maxTags && <p className="text-xs text-muted-foreground">{tags.length}/{maxTags}</p>}
    </div>
  );
}