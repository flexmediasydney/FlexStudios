import { useState } from "react";
import { X, Plus, Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Predefined color palette for tags. Colors are assigned deterministically
 * based on the tag text hash so the same tag always gets the same color.
 */
const TAG_COLORS = [
  { bg: "bg-blue-100",    text: "text-blue-700",    border: "border-blue-200",    dot: "bg-blue-500" },
  { bg: "bg-purple-100",  text: "text-purple-700",  border: "border-purple-200",  dot: "bg-purple-500" },
  { bg: "bg-green-100",   text: "text-green-700",   border: "border-green-200",   dot: "bg-green-500" },
  { bg: "bg-amber-100",   text: "text-amber-700",   border: "border-amber-200",   dot: "bg-amber-500" },
  { bg: "bg-pink-100",    text: "text-pink-700",    border: "border-pink-200",    dot: "bg-pink-500" },
  { bg: "bg-cyan-100",    text: "text-cyan-700",    border: "border-cyan-200",    dot: "bg-cyan-500" },
  { bg: "bg-orange-100",  text: "text-orange-700",  border: "border-orange-200",  dot: "bg-orange-500" },
  { bg: "bg-indigo-100",  text: "text-indigo-700",  border: "border-indigo-200",  dot: "bg-indigo-500" },
  { bg: "bg-rose-100",    text: "text-rose-700",    border: "border-rose-200",    dot: "bg-rose-500" },
  { bg: "bg-teal-100",    text: "text-teal-700",    border: "border-teal-200",    dot: "bg-teal-500" },
  { bg: "bg-lime-100",    text: "text-lime-700",    border: "border-lime-200",    dot: "bg-lime-500" },
  { bg: "bg-violet-100",  text: "text-violet-700",  border: "border-violet-200",  dot: "bg-violet-500" },
];

function hashTag(tag) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function getTagColor(tag) {
  return TAG_COLORS[hashTag(tag) % TAG_COLORS.length];
}

/**
 * Display-only tag list (compact, for cards).
 * Props:
 *   tags     — string[]
 *   max      — max tags to show before "+N"
 *   size     — "xs" | "sm"
 */
export function TagList({ tags = [], max = 3, size = "xs" }) {
  if (!tags || tags.length === 0) return null;

  const visible = tags.slice(0, max);
  const overflow = tags.length - max;

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((tag, i) => {
        const color = getTagColor(tag);
        return (
          <span
            key={i}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border font-medium",
              color.bg, color.text, color.border,
              size === "xs" ? "text-[9px] px-1.5 py-0" : "text-[10px] px-2 py-0.5"
            )}
          >
            <span className={cn("rounded-full flex-shrink-0", color.dot, size === "xs" ? "w-1 h-1" : "w-1.5 h-1.5")} />
            {tag}
          </span>
        );
      })}
      {overflow > 0 && (
        <span className={cn(
          "text-muted-foreground font-medium",
          size === "xs" ? "text-[9px]" : "text-[10px]"
        )}>
          +{overflow}
        </span>
      )}
    </div>
  );
}

/**
 * Editable tag manager (for dialogs / detail views).
 * Props:
 *   tags       — string[]
 *   onChange   — (newTags: string[]) => void
 *   maxTags    — max allowed tags
 */
export function TagEditor({ tags = [], onChange, maxTags = 10 }) {
  const [newTag, setNewTag] = useState("");
  const [open, setOpen] = useState(false);

  const addTag = () => {
    const trimmed = newTag.trim();
    if (!trimmed) return;
    if (tags.includes(trimmed)) { setNewTag(""); return; }
    if (tags.length >= maxTags) return;
    onChange([...tags, trimmed]);
    setNewTag("");
  };

  const removeTag = (idx) => {
    onChange(tags.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag, i) => {
          const color = getTagColor(tag);
          return (
            <span
              key={i}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border text-[11px] px-2 py-0.5 font-medium group",
                color.bg, color.text, color.border
              )}
            >
              <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", color.dot)} />
              {tag}
              <button
                type="button"
                onClick={() => removeTag(i)}
                className="opacity-60 hover:opacity-100 transition-opacity ml-0.5 cursor-pointer"
                aria-label={`Remove tag ${tag}`}
                title={`Remove ${tag}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          );
        })}
        {tags.length < maxTags && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full
                           border border-dashed border-muted-foreground/30 text-muted-foreground
                           hover:border-primary/50 hover:text-primary transition-colors cursor-pointer"
                aria-label="Add new tag"
                title="Add tag"
              >
                <Plus className="h-2.5 w-2.5" />
                Add
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-2" align="start">
              <div className="flex gap-1">
                <Input
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
                  placeholder="Tag name"
                  className="h-7 text-xs"
                  autoFocus
                  maxLength={30}
                />
                <Button size="sm" className="h-7 px-2" onClick={addTag} disabled={!newTag.trim()} title="Add tag" aria-label="Add tag">
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );
}

export default TagList;
