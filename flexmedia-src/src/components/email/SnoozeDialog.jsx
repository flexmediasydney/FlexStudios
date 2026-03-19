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

  const handleSnooze = (option) => {
    onSnooze(option);
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
              className="p-3 text-sm rounded-lg border border-input hover:bg-muted transition-colors text-left"
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