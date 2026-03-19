import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, ExternalLink, X } from "lucide-react";
import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";

export default function FilePreviewModal({ isOpen, onClose, file }) {
  const [previewUrl, setPreviewUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isOpen && file) {
      setLoading(true);
      setError(null);
      base44.functions
        .invoke('getDropboxFilePreview', { filePath: file.path })
        .then(res => {
          setPreviewUrl(res.data.url);
          setLoading(false);
        })
        .catch(err => {
          setError('Failed to load preview');
          setLoading(false);
        });
    }
  }, [isOpen, file]);

  if (!file) return null;

  // Get file type
  const ext = file.name.split('.').pop()?.toLowerCase();
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
  const isPdf = ext === 'pdf';
  const isVideo = ['mp4', 'mov', 'webm'].includes(ext);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader className="flex flex-row items-center justify-between">
          <div>
            <DialogTitle className="truncate">{file.name}</DialogTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {(file.size / 1024 / 1024).toFixed(2)} MB • {new Date(file.modified).toLocaleDateString()}
            </p>
          </div>
          <div className="flex gap-2 ml-4">
            {previewUrl && (
              <Button
                size="icon"
                variant="outline"
                asChild
              >
                <a href={previewUrl} download target="_blank" rel="noopener noreferrer">
                  <Download className="h-4 w-4" />
                </a>
              </Button>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto bg-muted rounded-lg flex items-center justify-center min-h-96">
          {loading ? (
            <div className="text-muted-foreground">Loading preview...</div>
          ) : error ? (
            <div className="text-destructive text-center">
              <p>{error}</p>
              {previewUrl && (
                <Button variant="link" asChild className="mt-4">
                  <a href={previewUrl} target="_blank" rel="noopener noreferrer">
                    Open in new tab <ExternalLink className="h-4 w-4 ml-2" />
                  </a>
                </Button>
              )}
            </div>
          ) : previewUrl ? (
            isImage ? (
              <img src={previewUrl} alt={file.name} className="max-w-full max-h-full object-contain" />
            ) : isPdf || isVideo ? (
              <div className="text-center">
                <p className="text-muted-foreground mb-4">Preview not available in browser</p>
                <Button asChild>
                  <a href={previewUrl} target="_blank" rel="noopener noreferrer">
                    Open {ext.toUpperCase()} <ExternalLink className="h-4 w-4 ml-2" />
                  </a>
                </Button>
              </div>
            ) : (
              <div className="text-center">
                <p className="text-muted-foreground mb-4">Preview not available for {ext} files</p>
                <Button asChild>
                  <a href={previewUrl} target="_blank" rel="noopener noreferrer">
                    Download File <Download className="h-4 w-4 ml-2" />
                  </a>
                </Button>
              </div>
            )
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}