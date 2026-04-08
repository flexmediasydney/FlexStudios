import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, ImageOff, Maximize2, Minimize2 } from "lucide-react";
import { safeWindowOpen } from "@/utils/sanitizeHtml";
import { cn } from "@/lib/utils";

/**
 * Converts a Dropbox shared folder link to an embeddable URL.
 * Replaces dl=0 with dl=0 (keeps it) and ensures the link works in iframes.
 */
function toEmbedUrl(shareUrl) {
  if (!shareUrl) return null;
  // Dropbox shared links work in iframes as-is
  return shareUrl;
}

export default function ProjectMediaGallery({ project }) {
  const deliverableLink = project?.tonomo_deliverable_link;
  const [expanded, setExpanded] = useState(false);

  if (!deliverableLink) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-muted p-4 mb-4">
            <ImageOff className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-semibold mb-1">Dropbox folder not linked</h3>
          <p className="text-xs text-muted-foreground max-w-sm">
            Files appear once the Dropbox delivery folder is shared for this project.
          </p>
        </CardContent>
      </Card>
    );
  }

  const embedUrl = toEmbedUrl(deliverableLink);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Project Media</h3>
          <Badge variant="outline" className="text-[10px] h-5">Dropbox</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(!expanded)}
            className="text-xs h-7 px-2"
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5 mr-1" /> : <Maximize2 className="h-3.5 w-3.5 mr-1" />}
            {expanded ? "Collapse" : "Expand"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => safeWindowOpen(deliverableLink)}
            className="text-xs h-7 px-2"
          >
            <ExternalLink className="h-3.5 w-3.5 mr-1" />
            Open in Dropbox
          </Button>
        </div>
      </div>

      {/* Embedded Dropbox folder */}
      <div className={cn(
        "rounded-lg border overflow-hidden bg-white transition-all",
        expanded ? "h-[800px]" : "h-[500px]"
      )}>
        <iframe
          src={embedUrl}
          title="Dropbox Media Folder"
          className="w-full h-full border-0"
          allow="autoplay; fullscreen"
          sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-popups-to-escape-sandbox"
        />
      </div>
    </div>
  );
}
