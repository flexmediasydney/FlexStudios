// Quality-of-Life UI Enhancement utilities
import React, { useState, useEffect } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Truncated text with tooltip
export function TruncatedTextWithTooltip({ text, maxLength = 50, className = "" }) {
  if (!text || text.length <= maxLength) return <span className={className}>{text}</span>;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("truncate cursor-help", className)}>
            {text.substring(0, maxLength)}...
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Loading skeleton with staggered animation
export function StaggeredSkeletonLoader({ count = 6, height = "h-12", delay = 50 }) {
  return (
    <div className="space-y-2">
      {Array(count).fill(0).map((_, i) => (
        <div 
          key={i} 
          className={`bg-muted animate-pulse rounded ${height}`}
          style={{ animationDelay: `${i * delay}ms` }}
        />
      ))}
    </div>
  );
}

// Keyboard shortcut hint badge
export function KeyboardHint({ shortcut, label }) {
  return (
    <div className="text-xs flex items-center gap-1 text-muted-foreground">
      <kbd className="px-1.5 py-0.5 bg-muted border border-border rounded font-mono text-xs">
        {shortcut}
      </kbd>
      <span>{label}</span>
    </div>
  );
}

// Safe button with enhanced keyboard/accessibility support
export function EnhancedButton({ children, title, shortcut, ...props }) {
  const ariaLabel = shortcut ? `${title} (${shortcut})` : title;
  return (
    <button
      {...props}
      title={title}
      aria-label={ariaLabel}
      className={cn("focus:ring-2 focus:ring-primary focus:ring-offset-2 transition-all", props.className)}
    >
      {children}
    </button>
  );
}

// Empty state with icon animation
export function EmptyStateCard({ icon: Icon, title, description, action, loading = false }) {
  return (
    <div className="p-12 text-center border-2 border-dashed rounded-xl bg-muted/20">
      {Icon && <Icon className="h-12 w-12 mx-auto mb-3 text-muted-foreground/50 animate-pulse" />}
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-muted-foreground text-sm mb-4">{description}</p>
      {action && !loading && action}
      {loading && <div className="inline-block w-4 h-4 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />}
    </div>
  );
}

// Copy to clipboard button
export function CopyButton({ text, label = "Copy", className = "" }) {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className={cn("text-xs px-2 py-1 rounded hover:bg-muted transition-colors", className)}
      title={copied ? "Copied!" : `Copy ${label}`}
    >
      {copied ? "✓ Copied" : `📋 ${label}`}
    </button>
  );
}

// Animated success flash
export function SuccessFlash({ message, duration = 2000, onComplete }) {
  React.useEffect(() => {
    const timer = setTimeout(onComplete, duration);
    return () => clearTimeout(timer);
  }, [duration, onComplete]);

  return (
    <div className="fixed top-4 right-4 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg animate-in fade-in slide-in-from-top-2 duration-300">
      <p className="text-sm font-medium flex items-center gap-2">
        <span>✓</span> {message}
      </p>
    </div>
  );
}