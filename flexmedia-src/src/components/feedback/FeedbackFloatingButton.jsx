import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Bug } from 'lucide-react';
import FeedbackSubmitDialog from './FeedbackSubmitDialog';
import { cn } from '@/lib/utils';

/**
 * Global floating "Report" button. Mounted once in the root Layout.
 * Hidden on /feedback itself (the page has its own prominent submit entry).
 *
 * z-40 keeps it below Radix dialogs/sheets (z-50) so it never sits on top of
 * the submit modal it opens.
 */
export default function FeedbackFloatingButton() {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const location = useLocation();

  // Hide on the Feedback page itself. The registered route is /Feedback; an
  // explicit /feedback redirect sends visitors to /Feedback so either form
  // still matches after normalisation.
  const path = (location.pathname || '').toLowerCase().replace(/\/+$/, '');
  if (path === '/feedback') return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        className={cn(
          'fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full shadow-lg transition-all duration-200',
          'bg-primary text-primary-foreground hover:bg-primary/90',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
          hover ? 'pl-3 pr-4 py-3' : 'p-3'
        )}
        aria-label="Report an issue or idea"
        title="Report an issue or idea"
      >
        <Bug className="h-5 w-5 flex-shrink-0" />
        <span
          className={cn(
            'overflow-hidden whitespace-nowrap text-xs font-semibold transition-all duration-200',
            hover ? 'max-w-[80px] opacity-100' : 'max-w-0 opacity-0'
          )}
        >
          Report
        </span>
      </button>

      <FeedbackSubmitDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
