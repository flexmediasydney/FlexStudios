/**
 * Branding Preferences Utilities
 * Handles safe preference management, orphan detection, and data integrity
 */

/**
 * Clean orphaned preferences - removes prefs for deleted/inactive categories
 */
export const cleanOrphanedPreferences = (preferences, activeCategories) => {
  const activeCategoryIds = new Set(activeCategories.map(c => c.id));
  return preferences.filter(pref => activeCategoryIds.has(pref.category_id));
};

/**
 * Get preference for a specific category, with fallback
 */
export const getPrefForCategory = (preferences, categoryId) => {
  return preferences?.find(p => p.category_id === categoryId) ?? null;
};

/**
 * Create a new preference template for a category
 */
export const createCategoryPreference = (categoryId, categoryName) => ({
  category_id: categoryId,
  category_name: categoryName,
  enabled: false,
  template_link: '',
  notes: '',
  reference_uploads: []
});

/**
 * Validate preference data structure
 */
export const validatePreference = (pref) => {
  if (!pref.category_id) return false;
  if (!Array.isArray(pref.reference_uploads)) return false;
  return true;
};

/**
 * Validate all preferences and return cleaned array
 */
export const validateAllPreferences = (preferences) => {
  return (preferences ?? [])
    .filter(validatePreference)
    .map(pref => ({
      ...pref,
      reference_uploads: (pref.reference_uploads ?? [])
        .filter(f => f.file_url && f.file_name)
    }));
};

/**
 * Merge new preferences with existing ones (used for updates)
 */
export const mergePreferences = (existing, updates, allCategories) => {
  const merged = [...(existing ?? [])];
  const activeIds = new Set(allCategories.map(c => c.id));

  updates.forEach(update => {
    const idx = merged.findIndex(p => p.category_id === update.category_id);
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], ...update };
    } else if (activeIds.has(update.category_id)) {
      merged.push(update);
    }
  });

  return cleanOrphanedPreferences(merged, allCategories);
};

/**
 * Get categories that are referenced in preferences but no longer exist
 */
export const findOrphanedPreferences = (preferences, activeCategories) => {
  const activeCategoryIds = new Set(activeCategories.map(c => c.id));
  return (preferences ?? []).filter(p => !activeCategoryIds.has(p.category_id));
};

/**
 * Check if category is actively being used in preferences
 */
export const isCategoryInUse = (categoryId, preferences) => {
  const pref = getPrefForCategory(preferences, categoryId);
  return pref?.enabled ?? false;
};

/**
 * Get summary of all enabled preferences
 */
export const getEnabledPreferencesSummary = (preferences) => {
  return (preferences ?? [])
    .filter(p => p.enabled)
    .map(p => ({
      categoryId: p.category_id,
      categoryName: p.category_name,
      hasTemplate: !!p.template_link,
      hasNotes: !!p.notes?.trim(),
      uploadCount: (p.reference_uploads ?? []).length
    }));
};

/**
 * Get total file upload count across all preferences
 */
export const getTotalUploadCount = (preferences) => {
  return (preferences ?? []).reduce((sum, p) => {
    return sum + ((p.reference_uploads ?? []).length || 0);
  }, 0);
};