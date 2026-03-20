import ReactMarkdown from "react-markdown";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff } from "lucide-react";

export default function RichTextPreview({ content, label }) {
  const [preview, setPreview] = useState(false);

  return (
    <div className="space-y-2">
      {label && (
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">{label}</label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPreview(!preview)}
            className="gap-1 h-8"
          >
            {preview ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {preview ? "Hide" : "Show"} Preview
          </Button>
        </div>
      )}
      {preview ? (
        <div className="border rounded-lg p-4 bg-white prose prose-sm max-w-none">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      ) : (
        <pre className="p-4 bg-gray-50 rounded border overflow-auto text-sm">{content}</pre>
      )}
    </div>
  );
}