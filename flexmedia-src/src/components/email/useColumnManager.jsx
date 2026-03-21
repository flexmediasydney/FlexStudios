import { useState, useEffect, useRef, useCallback } from 'react';

const DEFAULT_COLUMNS = [
  { id: 'checkbox',    label: '',        width: 36,  order: 0, resizable: false, minWidth: 36,  maxWidth: 36  },
  { id: 'from',        label: 'From',    width: 160, order: 1, resizable: true,  minWidth: 100, maxWidth: 240 },
  { id: 'subject',     label: 'Subject', width: 400, order: 2, resizable: true,  minWidth: 200, maxWidth: 9999, flex: true },
  { id: 'attachments', label: '',        width: 28,  order: 3, resizable: false, minWidth: 28,  maxWidth: 28  },
  { id: 'visibility',  label: '',        width: 32,  order: 4, resizable: false, minWidth: 32,  maxWidth: 32  },
  { id: 'date',        label: 'Date',    width: 76,  order: 5, resizable: false, minWidth: 76,  maxWidth: 76  },
  { id: 'actions',     label: 'Project', width: 150, order: 6, resizable: true, minWidth: 100, maxWidth: 220 },
];

const STORAGE_KEY = 'email-inbox-columns';

const loadSavedColumns = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    // Merge saved widths/order into defaults (handles new columns added later)
    return DEFAULT_COLUMNS.map(def => {
      const saved = parsed.find(s => s.id === def.id);
      if (!saved) return def;
      return { ...def, width: saved.width || def.width, order: saved.order ?? def.order };
    });
  } catch {
    return null;
  }
};

export const useColumnManager = () => {
  const [columns, setColumns] = useState(() => loadSavedColumns() || DEFAULT_COLUMNS);
  const [isDragging, setIsDragging] = useState(null);
  const [isResizing, setIsResizing] = useState(null);
  const saveTimeoutRef = useRef(null);

  // Debounced save to localStorage
  const saveToStorage = useCallback((cols) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      try {
        const toSave = cols.map(({ id, width, order }) => ({ id, width, order }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
      } catch {}
    }, 300);
  }, []);

  // Save whenever columns change
  useEffect(() => {
    saveToStorage(columns);
  }, [columns, saveToStorage]);

  const reorderColumns = (draggedId, targetId) => {
    const draggedIdx = columns.findIndex(c => c.id === draggedId);
    const targetIdx = columns.findIndex(c => c.id === targetId);

    if (draggedIdx === -1 || targetIdx === -1) return;

    const newColumns = [...columns];
    const [draggedCol] = newColumns.splice(draggedIdx, 1);
    newColumns.splice(targetIdx, 0, draggedCol);

    // Update order values
    newColumns.forEach((col, idx) => {
      col.order = idx;
    });

    setColumns(newColumns);
  };

  const resizeColumn = (columnId, newWidth) => {
    setColumns(columns.map(col => {
      if (col.id !== columnId) return col;
      const constrainedWidth = Math.max(col.minWidth, Math.min(col.maxWidth, newWidth));
      return { ...col, width: constrainedWidth };
    }));
  };

  const resetToDefault = () => {
    setColumns(DEFAULT_COLUMNS);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  };

  const fitToScreen = (containerWidth) => {
    if (!containerWidth || containerWidth <= 0 || !Number.isFinite(containerWidth)) return;

    // Sum everything that has a fixed pixel width (not the flex/subject column)
    const fixedWidth = columns
      .filter(c => !c.flex)
      .reduce((sum, c) => sum + (c.width || 0), 0);

    // Give 'subject' (flex:true) all remaining space, minimum 200px
    const subjectWidth = Math.max(200, containerWidth - fixedWidth - 2);

    setColumns(prev => prev.map(col =>
      col.flex ? { ...col, width: subjectWidth } : col
    ));
  };

  const getSortedColumns = () => {
    return [...columns].sort((a, b) => a.order - b.order);
  };

  return {
    columns: getSortedColumns(),
    reorderColumns,
    resizeColumn,
    resetToDefault,
    fitToScreen,
    isDragging,
    setIsDragging,
    isResizing,
    setIsResizing
  };
};
