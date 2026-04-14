import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Download, FileText, Image, Video } from 'lucide-react';

function getFileCategory(file) {
  const name = (file.file_name || '').toLowerCase();
  const type = (file.file_type || '').toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|svg|bmp|tiff?)$/i.test(name) || type.startsWith('image/')) return 'image';
  if (/\.(mp4|mov|webm|avi|mkv)$/i.test(name) || type.startsWith('video/')) return 'video';
  if (/\.pdf$/i.test(name) || type === 'application/pdf') return 'pdf';
  return 'other';
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export default function AttachmentLightbox({ files, initialIndex = 0, onClose }) {
  const [index, setIndex] = useState(initialIndex);
  const [zoomed, setZoomed] = useState(false);

  const file = files[index];
  const category = file ? getFileCategory(file) : 'other';
  const total = files.length;

  const goPrev = useCallback(() => {
    setZoomed(false);
    setIndex(i => (i > 0 ? i - 1 : total - 1));
  }, [total]);

  const goNext = useCallback(() => {
    setZoomed(false);
    setIndex(i => (i < total - 1 ? i + 1 : 0));
  }, [total]);

  // Keyboard navigation + close
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, goPrev, goNext]);

  // Body scroll lock
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  if (!file) return null;

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = file.file_url;
    a.download = file.file_name || 'download';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const CategoryIcon = category === 'image' ? Image : category === 'video' ? Video : FileText;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90"
      onClick={handleOverlayClick}
    >
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 z-10">
        <div className="flex items-center gap-2 text-white/70 text-sm">
          <CategoryIcon className="h-4 w-4" />
          <span className="truncate max-w-[300px]">{file.file_name || 'File'}</span>
          {file.file_size && <span className="text-white/50">({formatSize(file.file_size)})</span>}
        </div>
        <div className="flex items-center gap-1">
          {category === 'image' && (
            <button
              onClick={() => setZoomed(z => !z)}
              className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors"
              title={zoomed ? 'Zoom out' : 'Zoom in'}
            >
              {zoomed ? <ZoomOut className="h-5 w-5" /> : <ZoomIn className="h-5 w-5" />}
            </button>
          )}
          <button
            onClick={handleDownload}
            className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors"
            title="Download"
          >
            <Download className="h-5 w-5" />
          </button>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors"
            title="Close (Esc)"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Navigation arrows */}
      {total > 1 && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); goPrev(); }}
            className="absolute left-3 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/50 text-white/80 hover:text-white hover:bg-black/70 transition-colors"
            title="Previous"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); goNext(); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/50 text-white/80 hover:text-white hover:bg-black/70 transition-colors"
            title="Next"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}

      {/* Content area */}
      <div className="flex-1 flex items-center justify-center w-full px-16 py-14" onClick={handleOverlayClick}>
        {category === 'image' && (
          <img
            src={file.file_url}
            alt={file.file_name}
            className={`max-h-full transition-transform duration-200 rounded ${
              zoomed ? 'max-w-none cursor-zoom-out scale-150' : 'max-w-full cursor-zoom-in'
            }`}
            onClick={(e) => { e.stopPropagation(); setZoomed(z => !z); }}
            draggable={false}
          />
        )}
        {category === 'video' && (
          <video
            src={file.file_url}
            controls
            autoPlay
            className="max-w-full max-h-full rounded"
            onClick={(e) => e.stopPropagation()}
          >
            Your browser does not support the video tag.
          </video>
        )}
        {category === 'pdf' && (
          <iframe
            src={file.file_url}
            title={file.file_name}
            className="w-full max-w-4xl h-full rounded bg-white"
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {category === 'other' && (
          <div
            className="flex flex-col items-center gap-4 text-white/80"
            onClick={(e) => e.stopPropagation()}
          >
            <FileText className="h-16 w-16 text-white/40" />
            <p className="text-lg font-medium">{file.file_name || 'File'}</p>
            {file.file_size && <p className="text-sm text-white/50">{formatSize(file.file_size)}</p>}
            <p className="text-sm text-white/50">Preview not available for this file type</p>
            <button
              onClick={handleDownload}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              <Download className="h-4 w-4" />
              Download
            </button>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      {total > 1 && (
        <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center px-4 py-3 z-10">
          <span className="text-white/60 text-sm">{index + 1} / {total}</span>
        </div>
      )}
    </div>,
    document.body
  );
}
