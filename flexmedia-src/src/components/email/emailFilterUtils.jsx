// Consolidated folder filter logic
export const FOLDER_FILTERS = {
  inbox: {
    name: 'Inbox',
    icon: '📥',
    resetState: {
      filterView: 'inbox',
      filterUnread: false,
      filterFrom: null,
      filterLabel: null,
      filterProject: null,
      selectedMessages: new Set(),
      sortBy: 'newest',
      showAttachmentsOnly: false,
    }
  },
  draft: {
    name: 'Draft',
    icon: '✉️',
    resetState: {
      filterView: 'draft',
      filterUnread: false,
      filterFrom: null,
      filterLabel: null,
      filterProject: null,
      selectedMessages: new Set(),
      sortBy: 'newest',
      showAttachmentsOnly: false,
    }
  },
  sent: {
    name: 'Sent',
    icon: '✔️',
    resetState: {
      filterView: 'sent',
      filterUnread: false,
      filterFrom: null,
      filterLabel: null,
      filterProject: null,
      selectedMessages: new Set(),
      sortBy: 'newest',
      showAttachmentsOnly: false,
    }
  },
  archived: {
    name: 'Archived',
    icon: '📦',
    resetState: {
      filterView: 'archived',
      filterUnread: false,
      filterFrom: null,
      filterLabel: null,
      filterProject: null,
      selectedMessages: new Set(),
      sortBy: 'newest',
      showAttachmentsOnly: false,
    }
  },
  deleted: {
    name: 'Deleted',
    icon: '🗑️',
    resetState: {
      filterView: 'deleted',
      filterUnread: false,
      filterFrom: null,
      filterLabel: null,
      filterProject: null,
      selectedMessages: new Set(),
      sortBy: 'newest',
      showAttachmentsOnly: false,
    }
  }
};

export const applyFolderFilter = (folderKey, setters) => {
  const filter = FOLDER_FILTERS[folderKey];
  if (!filter) return;
  
  Object.entries(filter.resetState).forEach(([key, value]) => {
    const setterName = `set${key.charAt(0).toUpperCase() + key.slice(1)}`;
    if (setters[setterName]) {
      setters[setterName](value);
    }
  });
};