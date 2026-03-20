import FileAttachmentManager from "@/components/common/FileAttachmentManager";

/**
 * @deprecated Use FileAttachmentManager directly
 * Kept for backward compatibility
 */
export default function RevisionAttachments({ attachments = [], onChange, readOnly = false }) {
  return (
    <FileAttachmentManager
      attachments={attachments}
      onChange={onChange}
      readOnly={readOnly}
      label="Attachments"
      maxFiles={20}
      maxSizeBytes={100 * 1024 * 1024}
    />
  );
}