import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useEffect, useState } from "react";

export default function CommandPalette({ isOpen, onClose, commands = [] }) {
  const [search, setSearch] = useState("");

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const filtered = commands.filter(cmd =>
    cmd.title.toLowerCase().includes(search.toLowerCase()) ||
    cmd.description?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="p-0 shadow-lg">
        <Command>
          <CommandInput
            placeholder="Search commands..."
            value={search}
            onValueChange={setSearch}
            className="border-b"
          />
          <CommandList>
            <CommandEmpty>No commands found.</CommandEmpty>
            {filtered.map((cmd) => (
              <CommandGroup key={cmd.category} heading={cmd.category}>
                <CommandItem
                  onSelect={() => {
                    cmd.action();
                    onClose();
                    setSearch("");
                  }}
                  className="cursor-pointer"
                >
                  <span className="flex-1">
                    <div className="font-medium">{cmd.title}</div>
                    {cmd.description && (
                      <div className="text-xs text-muted-foreground">{cmd.description}</div>
                    )}
                  </span>
                </CommandItem>
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}