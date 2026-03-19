import { useState, useEffect, useRef } from 'react';

const DEFAULT_COLUMNS = [
  { id: 'checkbox',    label: '',        width: 36,  order: 0, resizable: false, minWidth: 36,  maxWidth: 36  },
  { id: 'star',        label: '',        width: 28,  order: 1, resizable: false, minWidth: 28,  maxWidth: 28  },
  { id: 'from',        label: 'From',    width: 160, order: 2, resizable: true,  minWidth: 100, maxWidth: 240 },
  { id: 'subject',     label: 'Subject', width: 400, order: 3, resizable: true,  minWidth: 200, maxWidth: 9999, flex: true },
  { id: 'attachments', label: '',        width: 28,  order: 4, resizable: false, minWidth: 28,  maxWidth: 28  },
  { id: 'visibility',  label: '',        width: 32,  order: 5, resizable: false, minWidth: 32,  maxWidth: 32  },
  { id: 'date',        label: 'Date',    width: 76,  order: 6, resizable: false, minWidth: 76,  maxWidth: 76  },
  { id: 'actions',     label: 'Project', width: 210, order: 7, resizable: false, minWidth: 160, maxWidth: 260 },
];

const STORAGE_KEY = 'email-inbox-columns';

export const useColumnManager = () => {
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [isDragging, setIsDragging] = useState(null);
  const [isResizing, setIsResizing] = useState(null);
  const saveTimeoutRef = useRef(null);





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