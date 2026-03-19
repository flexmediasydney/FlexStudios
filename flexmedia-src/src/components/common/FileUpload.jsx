import { Upload, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function FileUpload({ onFileSelect, accept, multiple = false, maxSize, className }) {
  const [isDragActive, setIsDragActive] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);

  const handleDrag = (e) => {
    e.preventDefault();
    setIsDragActive(e.type.includes("enter"));
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragActive(false);
    const files = Array.from(e.dataTransfer.files);
    processFiles(files);
  };

  const handleChange = (e) => {
    const files = Array.from(e.target.files);
    processFiles(files);
  };

  const processFiles = (files) => {
    if (maxSize) {
      files = files.filter(f => f.size <= maxSize);
    }
    setSelectedFiles(multiple ? files : [files[0]]);
    onFileSelect(multiple ? files : files[0]);
  };

  return (
    <div
      onDragEnter={handleDrag}
      onDragLeave={handleDrag}
      onDragOver={handleDrag}
      onDrop={handleDrop}
      className={cn(
        "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors",
        isDragActive ? "border-primary bg-primary/5" : "border-gray-300 hover:border-gray-400",
        className
      )}
    >
      <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
      <p className="text-sm font-medium">Drag files here or click to browse</p>
      {maxSize && <p className="text-xs text-muted-foreground mt-1">Max {(maxSize / 1024 / 1024).toFixed(1)}MB</p>}
      <input type="file" onChange={handleChange} accept={accept} multiple={multiple} className="hidden" id="file-input" />
      <label htmlFor="file-input" className="block mt-2">
        <Button variant="outline" size="sm" asChild>
          <span>Select Files</span>
        </Button>
      </label>
      {selectedFiles.length > 0 && (
        <div className="mt-4 space-y-2">
          {selectedFiles.map((file, idx) => (
            <div key={idx} className="flex items-center gap-2 text-sm">
              <span className="flex-1 text-left">{file.name}</span>
              <button onClick={() => setSelectedFiles(selectedFiles.filter((_, i) => i !== idx))}>
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}