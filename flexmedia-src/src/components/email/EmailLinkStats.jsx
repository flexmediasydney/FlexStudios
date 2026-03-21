import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { format } from 'date-fns';
import { ExternalLink, Link2, Eye } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export default function EmailLinkStats({ messageBody }) {
  const { data: linkClicks = [], isLoading } = useQuery({
    queryKey: ['email-link-stats', messageBody],
    queryFn: async () => {
      // This would normally come from EmailMessage
      // For now return empty - would need message ID
      return [];
    },
    enabled: false // Disabled until integrated properly
  });

  // Parse links from email body (simple implementation)
  const extractLinks = (html) => {
    if (!html) return [];
    
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
    const links = [];
    let match;
    
    while ((match = linkRegex.exec(html))) {
      const url = match[1];
      const text = match[2];
      const existing = links.find(l => l.url === url);
      
      if (existing) {
        existing.count++;
      } else {
        links.push({ url, text, count: 0 });
      }
    }
    
    return links;
  };

  const links = extractLinks(messageBody);
  
  if (links.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold flex items-center gap-2">
        <Link2 className="h-4 w-4" />
        Links
      </h4>
      <div className="space-y-2">
        {links.map((link, idx) => (
          <TooltipProvider key={idx}>
            <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 hover:bg-muted transition-colors group">
              {/* Link dot indicator */}
              <div className="relative flex-shrink-0">
                <div className="w-3 h-3 rounded-full bg-blue-500" />
                {link.count > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="secondary"
                        className="absolute -top-2 -right-2 h-5 w-5 p-0 flex items-center justify-center text-xs cursor-help"
                      >
                        {link.count}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-xs">
                      <div className="text-xs space-y-1">
                        <p className="font-medium">{link.count} click{link.count !== 1 ? 's' : ''}</p>
                        <p className="text-muted-foreground">Last click: {format(new Date(), 'MMM d, h:mm a')}</p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>

              {/* Link text and URL */}
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate font-medium">{link.text}</p>
                <p className="text-xs text-muted-foreground truncate">{new URL(link.url).hostname}</p>
              </div>

              {/* Open link button */}
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <ExternalLink className="h-4 w-4 text-muted-foreground hover:text-foreground" />
              </a>
            </div>
          </TooltipProvider>
        ))}
      </div>
    </div>
  );
}