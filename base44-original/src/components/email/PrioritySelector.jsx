import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ChevronDown, X } from "lucide-react";

const priorityConfig = {
  low: { bg: 'bg-slate-100', text: 'text-slate-700', label: 'Low' },
  medium: { bg: 'bg-orange-100', text: 'text-orange-700', label: 'Medium' },
  attention: { bg: 'bg-red-100', text: 'text-red-700', label: 'Attention' },
  completed: { bg: 'bg-green-100', text: 'text-green-700', label: 'Completed' }
};

export default function PrioritySelector({ priority, onPriorityChange, compact = false }) {
  const config = priority ? priorityConfig[priority] : null;

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {compact && config ? (
            <Button variant="ghost" size="sm" className={`gap-1 h-6 px-2 ${config.bg} ${config.text} text-xs font-medium`}>
              {config.label}
              <ChevronDown className="h-3 w-3" />
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="gap-2">
              {config ? config.label : 'Set Priority'}
              <ChevronDown className="h-4 w-4" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {Object.entries(priorityConfig).map(([key, cfg]) => (
            <DropdownMenuItem
              key={key}
              onClick={() => onPriorityChange(key)}
              className={priority === key ? 'bg-muted' : ''}
            >
              <div className={`w-2 h-2 rounded-full mr-2 ${cfg.bg.replace('100', '500')}`} />
              {cfg.label}
            </DropdownMenuItem>
          ))}
          {priority && (
            <>
              <div className="border-t my-1" />
              <DropdownMenuItem onClick={() => onPriorityChange(null)}>
                <X className="h-3 w-3 mr-2" />
                Clear Priority
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}