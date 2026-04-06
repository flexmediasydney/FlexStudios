import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ExternalLink, Palette, FileText, Link2, StickyNote, CheckCircle, XCircle, Download, X, Image as ImageIcon } from "lucide-react";

function isImageFile(name) {
  return /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(name || '');
}

function isPdfFile(name) {
  return /\.pdf$/i.test(name || '');
}

/**
 * Displays agency branding preferences on project details right pane.
 * Shows branding_preferences (per-category), general notes, and files link.
 * Only renders when the agency has at least one branding field set.
 */
export default function AgencyBrandingSummary({ agency }) {
  const [previewFile, setPreviewFile] = useState(null);

  if (!agency) return null;

  const prefs = Array.isArray(agency.branding_preferences) ? agency.branding_preferences : [];
  const enabledPrefs = prefs.filter(p => p.enabled);
  const generalNotes = agency.branding_general_notes || "";
  const filesLink = agency.branding_files_link || "";

  const hasBranding = enabledPrefs.length > 0 || generalNotes || filesLink;
  if (!hasBranding) return null;

  return (
    <>
      <Card className="border-purple-200 dark:border-purple-800/50 bg-purple-50/30 dark:bg-purple-950/10">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Palette className="h-4 w-4 text-purple-600 dark:text-purple-400" />
            Branding — {agency.name}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">

          {generalNotes && (
            <div className="flex items-start gap-2">
              <StickyNote className="h-3.5 w-3.5 text-purple-500 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-foreground leading-relaxed">{generalNotes}</p>
            </div>
          )}

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

                  {pref.notes && (
                    <p className="text-[11px] text-muted-foreground leading-snug">{pref.notes}</p>
                  )}

                  {pref.reference_uploads?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {pref.reference_uploads.map((file, fIdx) => (
                        <button
                          key={fIdx}
                          onClick={() => setPreviewFile(file)}
                          className="inline-flex items-center gap-1 text-[10px] bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded px-1.5 py-0.5 hover:bg-purple-200 dark:hover:bg-purple-800/40 transition-colors cursor-pointer"
                        >
                          <ImageIcon className="h-2 w-2" />
                          {file.file_name || `File ${fIdx + 1}`}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {prefs.length > enabledPrefs.length && (
            <p className="text-[10px] text-muted-foreground flex items-center gap-1">
              <XCircle className="h-3 w-3" />
              {prefs.length - enabledPrefs.length} categor{prefs.length - enabledPrefs.length === 1 ? 'y' : 'ies'} with no branding
            </p>
          )}
        </CardContent>
      </Card>

      {/* File preview lightbox */}
      <Dialog open={!!previewFile} onOpenChange={(open) => { if (!open) setPreviewFile(null); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] p-0 overflow-hidden">
          {previewFile && (
            <div className="flex flex-col">
              {/* Header */}
              <div className="flex items-center justify-between px-4 pr-12 py-3 border-b bg-muted/30">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{previewFile.file_name || 'File'}</p>
                  {previewFile.uploaded_at && (
                    <p className="text-xs text-muted-foreground">
                      Uploaded {new Date(previewFile.uploaded_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-3">
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                  >
                    <a href={previewFile.file_url} download target="_blank" rel="noopener noreferrer">
                      <Download className="h-3.5 w-3.5 mr-1.5" />
                      Download
                    </a>
                  </Button>
                </div>
              </div>

              {/* Preview content */}
              <div className="flex items-center justify-center bg-black/5 dark:bg-black/20 min-h-[300px] max-h-[70vh] overflow-auto p-4">
                {isImageFile(previewFile.file_name) ? (
                  <img
                    src={previewFile.file_url}
                    alt={previewFile.file_name}
                    className="max-w-full max-h-[65vh] object-contain rounded shadow-lg"
                  />
                ) : isPdfFile(previewFile.file_name) ? (
                  <iframe
                    src={previewFile.file_url}
                    title={previewFile.file_name}
                    className="w-full h-[65vh] rounded border"
                  />
                ) : (
                  <div className="text-center space-y-3 py-8">
                    <FileText className="h-12 w-12 text-muted-foreground mx-auto" />
                    <p className="text-sm text-muted-foreground">Preview not available for this file type</p>
                    <Button variant="outline" asChild>
                      <a href={previewFile.file_url} download target="_blank" rel="noopener noreferrer">
                        <Download className="h-4 w-4 mr-2" />
                        Download {previewFile.file_name}
                      </a>
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
