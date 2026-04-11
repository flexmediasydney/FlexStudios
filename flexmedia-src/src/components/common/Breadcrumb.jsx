import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';
import { createPageUrl } from '@/utils';
import { cn } from '@/lib/utils';

/**
 * Breadcrumb navigation component for showing current page hierarchy
 * Usage: <Breadcrumb items={[{label: "Projects", href: "Projects"}, {label: "My Project"}]} />
 */
export default function Breadcrumb({ items = [], className }) {
  if (!items || items.length === 0) return null;

  return (
    <nav className={cn("flex items-center gap-1 text-xs", className)} aria-label="Breadcrumb">
      <Link
        to={createPageUrl('Dashboard')}
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted/40"
        title="Home"
        aria-label="Dashboard"
      >
        <Home className="h-3.5 w-3.5" />
      </Link>

      {items.map((item, idx) => (
        <React.Fragment key={idx}>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 mx-0.5" aria-hidden="true" />
          {item.href ? (
            <Link
              to={createPageUrl(item.href)}
              className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted/40 max-w-xs truncate"
              title={item.label}
            >
              {item.label}
            </Link>
          ) : (
            <span className="font-medium text-foreground p-1 max-w-xs truncate" aria-current="page" title={item.label}>
              {item.label}
            </span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}