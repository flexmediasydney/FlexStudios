import { PermissionGuard } from "@/components/auth/PermissionGuard";
import RevisionTemplatesManagement from "@/components/revisions/RevisionTemplatesManagement";
import { FileText } from "lucide-react";

export default function SettingsRevisionTemplates() {
  return (
    <PermissionGuard require={["master_admin", "admin"]}>
      <div className="p-6 lg:p-8 space-y-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <FileText className="h-8 w-8" />
            Request Templates
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Define reusable task workflows for Revisions and Change Requests, across each media type. When a request is raised on a project, these templates auto-create the required tasks.
          </p>
        </div>
        <RevisionTemplatesManagement />
      </div>
    </PermissionGuard>
  );
}