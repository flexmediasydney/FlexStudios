import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronRight, Plus, X } from "lucide-react";

export default function ProductPackageSearchField({
  items,
  selectedItems,
  onChange,
  placeholder,
  type = "product", // "product" or "package"
  maxQuantity,
  minQuantity = 1
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef(null);

  const filtered = items.filter(item =>
    item.name.toLowerCase().includes(query.toLowerCase()) ||
    item.category?.toLowerCase().includes(query.toLowerCase())
  );

  const available = filtered.filter(
    item => !selectedItems.some(sel => (sel.product_id || sel.package_id || sel) === item.id)
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

  const toggleItem = (item) => {
    const itemId = item.id;
    if (selectedItems.some(sel => (sel.product_id || sel.package_id || sel) === itemId)) {
      onChange(selectedItems.filter(sel => (sel.product_id || sel.package_id || sel) !== itemId));
    } else {
      const newItem = type === "product"
        ? { product_id: itemId, quantity: minQuantity }
        : { package_id: itemId, quantity: 1 };
      onChange([...selectedItems, newItem]);
    }
    setQuery("");
    setOpen(false);
  };

  const updateQuantity = (itemId, quantity) => {
    const min = minQuantity || 1;
    const max = maxQuantity;
    let q = Math.max(min, parseInt(quantity) || min);
    if (max) q = Math.min(q, max);
    
    onChange(
      selectedItems.map(sel => {
        const selId = sel.product_id || sel.package_id || sel;
        return selId === itemId ? { ...sel, quantity: q } : sel;
      })
    );
  };

  const removeItem = (itemId) => {
    onChange(selectedItems.filter(sel => (sel.product_id || sel.package_id || sel) !== itemId));
  };

  return (
    <div className="space-y-3">
      {/* Selected Items */}
      <div className="space-y-2">
        {selectedItems.map(item => {
          const itemId = item.product_id || item.package_id || item;
          const itemData = items.find(i => i.id === itemId);
          if (!itemData) return null;

          return (
            <div
              key={itemId}
              className="flex items-center justify-between gap-3 p-3 bg-gradient-to-r from-primary/5 to-transparent rounded-lg border border-primary/10 hover:border-primary/20 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-foreground">{itemData.name}</div>
                {itemData.category && (
                  <div className="text-xs text-muted-foreground capitalize">{itemData.category}</div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {type === "product" && (
                  <Input
                    type="number"
                    min={minQuantity || 1}
                    max={maxQuantity}
                    value={item.quantity || minQuantity || 1}
                    onChange={(e) => updateQuantity(itemId, e.target.value)}
                    className="w-14 h-9 text-center text-sm"
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeItem(itemId)}
                  className="h-9 w-9 text-destructive hover:bg-destructive/10"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Search Input */}
      <div className="relative" ref={containerRef}>
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start text-muted-foreground hover:text-foreground hover:bg-muted/50 border-dashed"
          onClick={() => setOpen(!open)}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add {type === "product" ? "product" : "package"}...
        </Button>

        {open && (
          <Card className="absolute top-full mt-2 w-full z-50 p-0 shadow-xl border-primary/20 rounded-lg overflow-hidden">
            <div className="p-3 border-b bg-muted/30">
              <Input
                placeholder={`Search ${type}s...`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="border-0 bg-background focus-visible:ring-0 text-sm"
                autoFocus
              />
            </div>
            <div className="max-h-64 overflow-y-auto">
              {available.length > 0 ? (
                available.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      toggleItem(item);
                    }}
                    className="w-full text-left px-4 py-3 hover:bg-primary/5 transition-colors border-b last:border-b-0 group"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm text-foreground">{item.name}</div>
                        {item.category && (
                          <div className="text-xs text-muted-foreground capitalize mt-0.5">
                            {item.category}
                          </div>
                        )}
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0 mt-0.5" />
                    </div>
                  </button>
                ))
              ) : (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No available {type}s
                </div>
              )}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}