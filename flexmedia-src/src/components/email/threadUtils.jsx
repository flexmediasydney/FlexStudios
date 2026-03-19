// Utility functions for email thread operations

/**
 * Creates a stable unique key for a thread combining account and Gmail thread ID
 * Uses triple-pipe separator to avoid collisions
 */
export const createThreadUniqueKey = (emailAccountId, gmailThreadId) => {
  return `${emailAccountId}|||${gmailThreadId}`;
};

/**
 * Extracts account ID from thread uniqueKey
 */
export const getAccountIdFromKey = (uniqueKey) => {
  if (!uniqueKey || !uniqueKey.includes('|||')) return null;
  return uniqueKey.split('|||')[0];
};

/**
 * Extracts Gmail thread ID from thread uniqueKey
 */
export const getThreadIdFromKey = (uniqueKey) => {
  if (!uniqueKey || !uniqueKey.includes('|||')) return null;
  return uniqueKey.split('|||')[1];
};

/**
 * Gets account IDs from a set of thread IDs
 */
export const getAccountIdsFromThreads = (threadIds, threads) => {
  return Array.from(new Set(
    Array.from(threadIds).map(threadId => {
      const thread = threads.find(t => t.threadId === threadId);
      return thread?.email_account_id;
    }).filter(Boolean)
  ));
};