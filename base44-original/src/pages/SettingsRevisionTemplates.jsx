import { PermissionGuard } from "@/components/auth/PermissionGuard";
import RevisionTemplatesManagement from "@/components/revisions/RevisionTemplatesManagement";

export default function SettingsRevisionTemplates() {
  return (
    <PermissionGuard require={["master_admin", "employee"]}>
      <div className="p-6 lg:p-8 space-y-4">
        <div>
          <h1 className="text-2xl font-bold">Request Templates</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Define reusable task workflows for Revisions and Change Requests, across each media type. When a request is raised on a project, these templates auto-create the required tasks.
          </p>
        </div>
        <RevisionTemplatesManagement />
      </div>
    </PermissionGuard>
  );
}