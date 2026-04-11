import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Clock } from "lucide-react";

export default function SnoozeDialog({ open, onOpenChange, onSnooze }) {
  const [selectedOption, setSelectedOption] = useState(null);

  const snoozeOptions = [
    { label: "1 hour", minutes: 60 },
    { label: "4 hours", minutes: 240 },
    { label: "Tomorrow 9am", type: "tomorrow_9am" },
    { label: "Next Monday 9am", type: "next_monday_9am" },
    { label: "In 2 days", minutes: 2880 },
    { label: "In 1 week", minutes: 10080 },
  ];

  const computeSnoozeTime = (option) => {
    const now = new Date();
    if (option.minutes) {
      return new Date(now.getTime() + option.minutes * 60 * 1000).toISOString();
    }
    if (option.type === 'tomorrow_9am') {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      return tomorrow.toISOString();
    }
    if (option.type === 'next_monday_9am') {
      const nextMonday = new Date(now);
      const dayOfWeek = nextMonday.getDay();
      // dayOfWeek: 0=Sun, 1=Mon, 2=Tue, ..., 6=Sat
      // If today is Monday (1), go to next Monday (7 days ahead).
      // If today is Sunday (0), go to tomorrow (1 day ahead).
      // Otherwise, calculate days until next Monday.
      const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 7 : (8 - dayOfWeek);
      nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
      nextMonday.setHours(9, 0, 0, 0);
      return nextMonday.toISOString();
    }
    // Fallback: 1 hour from now
    return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  };

  const handleSnooze = (option) => {
    const snoozeUntil = computeSnoozeTime(option);
    onSnooze({ ...option, snooze_until: snoozeUntil });
    setSelectedOption(null);
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogTitle>Snooze email</AlertDialogTitle>
        <AlertDialogDescription>
          Choose when to see this email again
        </AlertDialogDescription>
        <div className="grid grid-cols-2 gap-2 my-4">
          {snoozeOptions.map((option) => (
            <button
              key={option.label}
              onClick={() => handleSnooze(option)}
              className="p-3 text-sm rounded-lg border border-input hover:bg-muted transition-colors text-left cursor-pointer"
            >
              <Clock className="h-3 w-3 inline mr-1" />
              {option.label}
            </button>
          ))}
        </div>
        <div className="flex gap-3 justify-end">
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}