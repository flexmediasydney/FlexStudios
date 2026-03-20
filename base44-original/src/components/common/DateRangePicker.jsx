import { Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar as CalendarUI } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { format } from "date-fns";
import { useState } from "react";

export default function DateRangePicker({ value, onChange, label }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-2">
      {label && <label className="text-sm font-medium">{label}</label>}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-full justify-start gap-2">
            <Calendar className="h-4 w-4" />
            {value?.from ? (
              <>
                {format(value.from, "MMM d, yyyy")}
                {value.to && ` - ${format(value.to, "MMM d, yyyy")}`}
              </>
            ) : (
              "Pick a date range"
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0">
          <div className="flex gap-4 p-4">
            <CalendarUI
              mode="range"
              selected={value}
              onSelect={(range) => {
                onChange(range);
                if (range?.to) setOpen(false);
              }}
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}