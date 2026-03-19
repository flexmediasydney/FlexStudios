import React from "react";
import { AlertTriangle, Package, Zap, DollarSign, FileText, Camera, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const ImpactIcons = {
  package: Package,
  pricing: DollarSign,
  project: FileText,
  task: Zap,
  snapshot: Camera,
  activity: History,
};

function formatFieldLabel(field) {
  return field
    .replace(/([A-Z])/g, " $1")
    .replace(/\./g, " → ")
    .replace(/^./, str => str.toUpperCase())
    .trim();
}

export default function ImpactWarningDialog({
  open,
  onOpenChange,
  itemName,
  itemType,
  changes,
  impacts,
  onConfirm,
  isPending,
}) {
  if (!impacts || Object.values(impacts).every(arr => arr?.length === 0)) {
    return null;
  }

  const totalImpacts = Object.values(impacts).flat().length;
  const hasChanges = changes && changes.length > 0;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-100 flex items-center justify-center flex-shrink-0 mt-0.5">
              <AlertTriangle className="h-5 w-5 text-red-600" />
            </div>
            <div className="flex-1">
              <AlertDialogTitle className="text-lg">Review System-Wide Changes</AlertDialogTitle>
              <AlertDialogDescription className="text-sm mt-1.5">
                This change will impact <span className="font-semibold text-red-600">{totalImpacts} item{totalImpacts !== 1 ? "s" : ""}</span> across your system. 
                Please review before confirming.
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        <div className="space-y-4 py-4 border-t border-b">
          {/* Changed fields */}
          {hasChanges && (
            <div className="rounded-lg bg-blue-50 p-3.5 border border-blue-200">
              <p className="text-xs font-semibold text-blue-900 uppercase tracking-wider mb-2.5">Changes Being Made</p>
              <div className="space-y-2">
                {changes.map((change, i) => (
                  <div key={i} className="text-sm bg-white rounded p-2">
                    <div className="font-medium text-gray-900">{formatFieldLabel(change.field)}</div>
                    <div className="text-xs text-gray-600 mt-1">
                      <span className="inline-block bg-red-100 text-red-700 px-2 py-1 rounded mr-2">
                        {change.old_value || "—"}
                      </span>
                      <span className="text-gray-400">→</span>
                      <span className="inline-block bg-green-100 text-green-700 px-2 py-1 rounded ml-2">
                        {change.new_value || "—"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Impacts */}
          <div className="rounded-lg bg-red-50 p-3.5 border border-red-200">
            <p className="text-xs font-semibold text-red-900 uppercase tracking-wider mb-2.5">System-Wide Impact</p>
            <div className="space-y-3">
              {impacts.packages?.length > 0 && (
                <ImpactGroup icon="package" label="Packages Affected" count={impacts.packages.length} items={impacts.packages} />
              )}
              {impacts.pricing?.length > 0 && (
                <ImpactGroup icon="pricing" label="Price Matrices Affected" count={impacts.pricing.length} items={impacts.pricing} />
              )}
              {impacts.projects?.length > 0 && (
                <ImpactGroup icon="project" label="Active Projects Affected" count={impacts.projects.length} items={impacts.projects} />
              )}
              {impacts.tasks?.length > 0 && (
                <ImpactGroup icon="task" label="Project Tasks Affected" count={impacts.tasks.length} items={impacts.tasks} />
              )}
              {impacts.snapshots?.length > 0 && (
                <ImpactGroup icon="snapshot" label="Snapshots Affected" count={impacts.snapshots.length} items={impacts.snapshots} />
              )}
              {impacts.activity?.length > 0 && (
                <ImpactGroup icon="activity" label="Activity References Affected" count={impacts.activity.length} items={impacts.activity} />
              )}
            </div>
          </div>
        </div>

        <AlertDialogFooter className="mt-4">
          <AlertDialogCancel disabled={isPending} className="gap-2">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction 
            onClick={onConfirm} 
            disabled={isPending} 
            className="bg-red-600 hover:bg-red-700 gap-2"
          >
            <AlertTriangle className="h-4 w-4" />
            {isPending ? "Saving..." : "Confirm & Apply Changes"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ImpactGroup({ icon, label, count, items }) {
  const Icon = ImpactIcons[icon];
  return (
    <div className="bg-white rounded p-2.5 border border-red-100">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-red-600" />
        <span className="text-sm font-semibold text-gray-900">{label}</span>
        <span className="ml-auto text-xs font-bold bg-red-600 text-white px-2 py-1 rounded-full">
          {count}
        </span>
      </div>
      <div className="text-sm text-gray-700 space-y-1 ml-6">
        {items.slice(0, 5).map((item, i) => (
          <div key={i} className="truncate text-gray-600">
            <span className="text-red-500">▸</span> {item}
          </div>
        ))}
        {items.length > 5 && (
          <div className="text-gray-500 font-medium italic text-xs">
            + {items.length - 5} more
          </div>
        )}
      </div>
    </div>
  );
}