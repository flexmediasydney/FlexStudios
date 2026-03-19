import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createPageUrl } from "@/utils";
import ProjectRulebook from "@/components/projects/ProjectRulebook";

export default function SettingsProjectRulebook() {
  return (
    <div className="p-6 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to={createPageUrl("SettingsOrganisation")}>
          <Button variant="ghost" size="icon" aria-label="Back to settings">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Project Rules</h1>
          <p className="text-muted-foreground mt-1">
            Learn how projects handle packages, products, and pricing
          </p>
        </div>
      </div>

      {/* Rulebook */}
      <ProjectRulebook />
    </div>
  );
}