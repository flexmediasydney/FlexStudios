import { QueryClient } from '@tanstack/react-query';

// ─── Query Key Factories ────────────────────────────────────────────────────
// Centralized key factories ensure consistent cache invalidation patterns.
// Usage: import { queryKeys } from '@/components/lib/query-client';
//        useQuery({ queryKey: queryKeys.projects.detail(id), ... })
//        queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })

export const queryKeys = {
  // ── Projects ───────────────────────────────────────────────────────────────
  projects: {
    all: ['projects'],
    lists: () => [...queryKeys.projects.all, 'list'],
    list: (filters) => [...queryKeys.projects.lists(), filters],
    details: () => [...queryKeys.projects.all, 'detail'],
    detail: (id) => [...queryKeys.projects.details(), id],
    kanban: (filters) => [...queryKeys.projects.all, 'kanban', filters],
    pending: () => ['pendingReviewProjects'],
    createdToday: () => ['projectsCreatedToday'],
    forCalendar: () => ['projects-for-cal'],
    forSecurity: () => ['projects-for-security'],
    pulseSummary: () => ['pulse-projects-summary'],
  },

  // ── Tasks ──────────────────────────────────────────────────────────────────
  tasks: {
    all: ['tasks'],
    byProject: (projectId) => [...queryKeys.tasks.all, 'project', projectId],
    timeLogs: () => ['taskTimeLogs'],
    liveTimers: () => ['liveActiveTimers'],
  },

  // ── Email ──────────────────────────────────────────────────────────────────
  emails: {
    all: ['emails'],
    accounts: () => ['email-accounts'],
    messages: (accountId) => ['email-messages', accountId],
    thread: (threadId) => ['email-thread', threadId],
    labels: (accountId) => ['email-labels', accountId],
    labelsManage: (accountId) => ['email-labels-manage', accountId],
    templates: () => ['email-templates'],
    activity: (messageId) => ['email-activity', messageId],
    accountsLabels: (userId) => ['email-accounts-labels', userId],
  },

  // ── Users ──────────────────────────────────────────────────────────────────
  users: {
    all: ['users'],
    current: () => ['currentUser'],
    byEmail: (email) => ['user', email],
    list: () => ['all-users'],
    forDefaults: () => ['users-for-defaults'],
    forCalAdmin: () => ['all-users-for-cal-admin'],
    hours: () => ['all-users-hours'],
    myEmailAccounts: (userId) => ['my-email-accounts', userId],
  },

  // ── Calendar ───────────────────────────────────────────────────────────────
  calendar: {
    all: ['calendar'],
    connections: (email) => ['calendar-connections', email],
    events: (filters) => ['calendar-events', filters],
  },

  // ── Notes ──────────────────────────────────────────────────────────────────
  notes: {
    all: ['notes'],
    byProject: (projectId) => ['project-notes', projectId],
  },

  // ── Notifications ──────────────────────────────────────────────────────────
  notifications: {
    all: ['notifications'],
    prefs: (userId) => ['notifPrefs', userId],
    digest: (userId) => ['notifDigest', userId],
    allNotifications: () => ['allNotifications'],
  },

  // ── Settings ───────────────────────────────────────────────────────────────
  settings: {
    delivery: () => ['deliverySettings'],
    automationRules: () => ['automationRules'],
    projectTypes: () => ['projectTypes'],
    productCategories: (projectTypeId) => ['productCategories', projectTypeId],
  },

  // ── Tonomo ─────────────────────────────────────────────────────────────────
  tonomo: {
    settings: () => ['tonomoSettings'],
    roleDefaults: () => ['tonomoRoleDefaults'],
    queue: () => ['settingsQueue'],
    queueStats: () => ['tonomoQueueStats'],
    auditCount: () => ['tonomoAuditCount'],
    mappingCoverage: () => ['tonomoMappingCoverage'],
    bookingStats: () => ['tonomoBookingStats'],
    recentProcessing: () => ['tonomoRecentProcessing'],
    audit: (orderId) => ['tonomoAudit', orderId],
    rawPayload: (orderId) => ['tonomoRawPayload', orderId],
    bookingTimeline: (orderId) => ['tonomoBookingTimeline', orderId],
    mappings: () => ['tonomo-project-type-mappings'],
    logs: (limit) => ['tonomoLogs', limit],
    calendarLinkAudit: () => ['calendarLinkAudit'],
    autoLinked: () => ['autoLinkedProjects'],
  },

  // ── Teams ──────────────────────────────────────────────────────────────────
  teams: {
    all: ['teams'],
    internal: () => ['internal-teams'],
    forDefaults: () => ['internal-teams-for-defaults'],
  },

  // ── Products & Packages ────────────────────────────────────────────────────
  products: {
    all: ['products'],
  },
  packages: {
    all: ['packages'],
  },

  // ── Price Matrix ───────────────────────────────────────────────────────────
  priceMatrix: {
    all: ['priceMatrix'],
  },

  // ── Availability ───────────────────────────────────────────────────────────
  availability: {
    photographer: () => ['photographer-availability'],
  },

  // ── Clients ────────────────────────────────────────────────────────────────
  clients: {
    project: (projectId) => ['client-project', projectId],
    media: (projectId) => ['client-media', projectId],
    info: (clientId) => ['client-info', clientId],
  },
};


// ─── Query Client Instance ──────────────────────────────────────────────────

export const queryClientInstance = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2 * 60 * 1000,         // 2 minutes — data considered fresh
      gcTime: 10 * 60 * 1000,           // 10 minutes — garbage collect unused cache
      refetchOnMount: 'always',          // refetch if stale when component mounts
      refetchOnWindowFocus: false,       // disabled — users reported unnecessary refetches
      refetchOnReconnect: 'always',      // refetch when network reconnects
      retry: 2,                          // retry failed queries twice
      retryDelay: (attemptIndex) =>      // exponential backoff: 1s, 2s
        Math.min(1000 * 2 ** attemptIndex, 4000),
    },
    mutations: {
      throwOnError: false,
      retry: 1,
      retryDelay: 1000,
    },
  },
});
