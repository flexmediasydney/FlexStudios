import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Palette, FileText, Link2, StickyNote, CheckCircle, XCircle } from "lucide-react";

/**
 * Displays agency branding preferences on project details right pane.
 * Shows branding_preferences (per-category), general notes, and files link.
 * Only renders when the agency has at least one branding field set.
 */
export default function AgencyBrandingSummary({ agency }) {
  if (!agency) return null;

  const prefs = Array.isArray(agency.branding_preferences) ? agency.branding_preferences : [];
  const enabledPrefs = prefs.filter(p => p.enabled);
  const generalNotes = agency.branding_general_notes || "";
  const filesLink = agency.branding_files_link || "";

  // Check if any branding data exists at all
  const hasBranding = enabledPrefs.length > 0 || generalNotes || filesLink;
  if (!hasBranding) return null;

  return (
    <Card className="border-purple-200 dark:border-purple-800/50 bg-purple-50/30 dark:bg-purple-950/10">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Palette className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          Branding — {agency.name}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">

        {/* General notes */}
        {generalNotes && (
          <div className="flex items-start gap-2">
            <StickyNote className="h-3.5 w-3.5 text-purple-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-foreground leading-relaxed">{generalNotes}</p>
          </div>
        )}

        {/* Shared files link */}
        {filesLink && (
          <a
            href={filesLink}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs text-purple-700 dark:text-purple-300 hover:text-purple-900 dark:hover:text-purple-100 hover:underline transition-colors"
          >
            <Link2 className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate">Branding Assets Folder</span>
            <ExternalLink className="h-3 w-3 flex-shrink-0" />
          </a>
        )}

        {/* Per-category preferences */}
        {enabledPrefs.length > 0 && (
          <div className="space-y-2">
            {enabledPrefs.map((pref, idx) => (
              <div key={pref.category_id || idx} className="bg-white dark:bg-background border border-purple-100 dark:border-purple-900/30 rounded-md px-2.5 py-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-foreground">{pref.category_name || "Unknown Category"}</span>
                  <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-300">
                    <CheckCircle className="h-2.5 w-2.5 mr-0.5" />
                    Active
                  </Badge>
                </div>

                {/* Template link */}
                {pref.template_link && (
                  <a
                    href={pref.template_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-[11px] text-purple-600 dark:text-purple-400 hover:underline mb-1"
                  >
                    <FileText className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">Template</span>
                    <ExternalLink className="h-2.5 w-2.5 flex-shrink-0" />
                  </a>
                )}

                {/* Notes */}
                {pref.notes && (
                  <p className="text-[11px] text-muted-foreground leading-snug">{pref.notes}</p>
                )}

                {/* Reference uploads */}
                {pref.reference_uploads?.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {pref.reference_uploads.map((file, fIdx) => (
                      <a
                        key={fIdx}
                        href={file.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[10px] bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded px-1.5 py-0.5 hover:bg-purple-200 dark:hover:bg-purple-800/40 transition-colors"
                      >
                        {file.file_name || `File ${fIdx + 1}`}
                        <ExternalLink className="h-2 w-2" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Disabled categories summary */}
        {prefs.length > enabledPrefs.length && (
          <p className="text-[10px] text-muted-foreground flex items-center gap-1">
            <XCircle className="h-3 w-3" />
            {prefs.length - enabledPrefs.length} categor{prefs.length - enabledPrefs.length === 1 ? 'y' : 'ies'} with no branding
          </p>
        )}
      </CardContent>
    </Card>
  );
}
