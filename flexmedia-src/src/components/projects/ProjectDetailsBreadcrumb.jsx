import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Copy, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ProjectDetailsBreadcrumb({ projectId, projectTitle }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopyLink = () => {
    const link = `${window.location.origin}${createPageUrl("ProjectDetails")}?id=${projectId}`;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center justify-between mb-4">
      <nav className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-label="Breadcrumb">
        <Link 
          to={createPageUrl("Dashboard")} 
          className="hover:text-foreground transition-colors focus:ring-1 focus:ring-primary px-1 rounded"
          title="Back to Dashboard"
        >
          Dashboard
        </Link>
        <ChevronRight className="h-3 w-3" />
        <Link 
          to={createPageUrl("Projects")} 
          className="hover:text-foreground transition-colors focus:ring-1 focus:ring-primary px-1 rounded"
          title="Back to Projects"
        >
          Projects
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground font-medium truncate max-w-[300px]" title={projectTitle}>
          {projectTitle}
        </span>
      </nav>
      
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded font-mono">
          ID: {projectId.substring(0, 8)}...
        </span>
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={handleCopyLink}
          className="h-8 px-2 text-xs"
          title="Copy project link"
          aria-label="Copy project link"
        >
          <Copy className="h-3 w-3 mr-1" />
          {copied ? "Copied!" : "Link"}
        </Button>
      </div>
    </div>
  );
}