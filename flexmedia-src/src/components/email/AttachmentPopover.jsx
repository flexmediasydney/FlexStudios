import { 
  FileIcon, 
  Download, 
  FileText, 
  Image as ImageIcon, 
  FileArchive, 
  File 
} from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

export default function AttachmentPopover({ attachments }) {
  if (!attachments || attachments.length === 0) return null;

  const handleDownload = async (attachment) => {
    if (!attachment.file_url) {
      alert('No download link available');
      return;
    }

    try {
      // Try direct download first
      const link = document.createElement("a");
      link.href = attachment.file_url;
      link.download = attachment.filename || 'download';
      link.setAttribute('target', '_blank');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Download error:', error);
      // Fallback: open in new tab
      window.open(attachment.file_url, '_blank');
    }
  };

  const formatSize = (bytes) => {
    if (!bytes || bytes <= 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
  };

  const getFileIcon = (filename, mimeType) => {
    const ext = filename?.split('.').pop()?.toLowerCase();
    const mime = mimeType?.toLowerCase() || '';
    
    if (mime.includes('pdf') || ext === 'pdf') return { icon: FileText, color: 'text-red-500' };
    if (mime.includes('image') || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return { icon: ImageIcon, color: 'text-blue-500' };
    if (mime.includes('zip') || mime.includes('compressed') || ['zip', 'rar', '7z'].includes(ext)) return { icon: FileArchive, color: 'text-amber-500' };
    if (['doc', 'docx'].includes(ext)) return { icon: FileText, color: 'text-blue-600' };
    if (['xls', 'xlsx'].includes(ext)) return { icon: FileText, color: 'text-green-600' };
    return { icon: File, color: 'text-gray-500' };
  };

  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <button className="flex items-center gap-1 text-primary hover:opacity-75 transition-opacity cursor-pointer">
          <FileIcon className="h-4 w-4" />
          <span className="text-xs font-medium">{attachments.length}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-64 p-2">
        <div className="space-y-1">
          {attachments.map((att, idx) => {
            const { icon: Icon, color } = getFileIcon(att.filename, att.mime_type);
            return (
              <button
                key={idx}
                onClick={() => handleDownload(att)}
                className="w-full flex items-center justify-between gap-2 p-2 rounded hover:bg-muted transition-colors text-left group"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Icon className={`h-4 w-4 flex-shrink-0 ${color}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{att.filename}</p>
                    <p className="text-xs text-muted-foreground">{formatSize(att.size)}</p>
                  </div>
                </div>
                <Download className="h-3 w-3 text-muted-foreground group-hover:text-primary flex-shrink-0" />
              </button>
            );
          })}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}