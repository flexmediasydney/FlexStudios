import React, { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, CheckCheck, Trash2, Search, ChevronRight,
         AlertCircle, AlertTriangle, Info, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createPageUrl } from "@/utils";
import { useNotifications } from "@/components/notifications/NotificationContext";

const CATEGORY_TABS = [
  { value: "all",        label: "All" },
  { value: "task",       label: "Tasks",    icon: "📋" },
  { value: "project",    label: "Projects", icon: "📁" },
  { value: "revision",   label: "Revisions",icon: "🔄" },
  { value: "tonomo",     label: "Tonomo",   icon: "⚡" },
  { value: "financial",  label: "Financial",icon: "💰" },
  { value: "scheduling", label: "Scheduling",icon:"📅" },
  { value: "system",     label: "System",   icon: "🔧" },
];

const SEVERITY_CONFIG = {
  critical: { icon: <AlertCircle className="h-4 w-4 text-red-500" />, bg: "bg-red-50 border-red-200 dark:bg-red-950/20" },
  warning:  { icon: <AlertTriangle className="h-4 w-4 text-amber-500" />, bg: "bg-amber-50 border-amber-200 dark:bg-amber-950/20" },
  info:     { icon: <Info className="h-4 w-4 text-blue-400" />, bg: "" },
};

function relTime(ts) {
  if (!ts) return "";
  const safe = (ts.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(ts)) ? ts : ts + "Z";
  const ms = Date.now() - new Date(safe).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  if (h < 168) return `${Math.floor(h/24)}d ago`;
  return new Date(ts).toLocaleDateString("en-AU", { day:"numeric", month:"short", timeZone: "Australia/Sydney" });
}

export default function NotificationsPage() {
  const { notifications, unreadCount, markRead, markAllRead, dismiss, refresh, loading } =
    useNotifications();
  const navigate = useNavigate();
  const [tab, setTab] = useState("all");
  const [readFilter, setReadFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());

  // Keyboard shortcut: Esc to clear search
  React.useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && search) {
        e.preventDefault();
        setSearch('');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [search]);

  const filtered = useMemo(() => {
    return notifications
      .filter(n => !n.is_dismissed)
      .filter(n => tab === "all" || n.category === tab)
      .filter(n => readFilter === "all" || (readFilter === "unread" ? !n.is_read : n.is_read))
      .filter(n => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        // Bug fix: guard against null fields (null + string = "null" giving false matches)
        return ((n.title || '') + ' ' + (n.message || '') + ' ' + (n.project_name || '')).toLowerCase().includes(q);
      });
  }, [notifications, tab, readFilter, search]);

  // Bug fix: memoize per-tab unread counts to avoid O(tabs * notifications) on every render.
  // Previously, each of the 8 category tabs called notifications.filter() inline in JSX,
  // re-scanning the full notifications array 8 times on every render (including when
  // just typing in the search box or toggling a checkbox).
  const tabUnreadCounts = useMemo(() => {
    const counts = {};
    let allCount = 0;
    for (const n of notifications) {
      if (n.is_dismissed || n.is_read) continue;
      allCount++;
      if (n.category) {
        counts[n.category] = (counts[n.category] || 0) + 1;
      }
    }
    counts.all = allCount;
    return counts;
  }, [notifications]);

  const grouped = useMemo(() => {
    // Use Sydney date boundaries so "today" matches the business day, not browser locale
    const sydneyDate = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }); // YYYY-MM-DD
    const todayStr = sydneyDate(new Date());
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const groups = { today: [], thisWeek: [], earlier: [] };
    for (const n of filtered) {
      if (!n.created_date) { groups.earlier.push(n); continue; }
      const d = new Date(n.created_date.endsWith('Z') ? n.created_date : n.created_date + 'Z');
      if (sydneyDate(d) === todayStr) groups.today.push(n);
      else if (d >= weekAgo) groups.thisWeek.push(n);
      else groups.earlier.push(n);
    }
    return groups;
  }, [filtered]);

  function handleNavigate(n) {
    // Mark read first (fire-and-forget), then navigate
    if (!n.is_read) markRead(n.id);
    if (!n.cta_url) return;
    try {
      const params = n.cta_params
        ? (typeof n.cta_params === 'string' ? JSON.parse(n.cta_params) : n.cta_params)
        : {};
      // Strip leading slash to avoid createPageUrl producing "//PageName"
      const pageName = n.cta_url.replace(/^\/+/, '');
      navigate(createPageUrl(pageName) + (params.id ? `?id=${params.id}` : ""));
    } catch { /* ignore */ }
  }

  function toggleSelect(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function bulkMarkRead() {
    // Only mark unread items — skip already-read ones to avoid wasted API calls
    const ids = Array.from(selected).filter(id => {
      const n = notifications.find(n => n.id === id);
      return n && !n.is_read;
    });
    for (let i = 0; i < ids.length; i += 10) {
      await Promise.all(ids.slice(i, i + 10).map(id => markRead(id)));
    }
    setSelected(new Set());
  }

  async function bulkDismiss() {
    // Only dismiss items still present in notifications (not already dismissed via realtime)
    const ids = Array.from(selected).filter(id =>
      notifications.some(n => n.id === id && !n.is_dismissed)
    );
    for (let i = 0; i < ids.length; i += 10) {
      await Promise.all(ids.slice(i, i + 10).map(id => dismiss(id)));
    }
    setSelected(new Set());
  }

  function toggleSelectAll() {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(n => n.id)));
    }
  }

  if (loading && notifications.length === 0) {
    return (
      <div className="p-6 lg:p-8 max-w-4xl space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        {Array(5).fill(0).map((_, i) => (
          <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Bell className="h-7 w-7 text-primary" /> Notifications
          </h1>
          <p className="text-muted-foreground mt-1 flex items-center gap-2">
            {unreadCount > 0 ? (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                  {unreadCount} unread
                </span>
              </>
            ) : (
              <>
                <CheckCheck className="h-4 w-4 text-green-500" />
                You're all caught up
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading} className="shadow-sm">
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          {unreadCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={markAllRead}
            className="shadow-sm"
            title={`Mark all ${unreadCount} notifications as read`}
          >
            <CheckCheck className="h-4 w-4 mr-1.5" />
            <span className="hidden sm:inline">Mark all read</span>
          </Button>
          )}
        </div>
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search notifications... (press Esc to clear)"
            className="pl-9 h-9 transition-all focus-visible:ring-primary/50"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoComplete="off"
            spellCheck="false"
            title="Search by title, message, or project (Esc to clear)"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full p-1 transition-colors"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Select value={readFilter} onValueChange={setReadFilter}>
          <SelectTrigger className="w-32 h-9 shadow-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="font-medium">All</SelectItem>
            <SelectItem value="unread" className="font-medium">Unread only</SelectItem>
            <SelectItem value="read" className="font-medium">Read only</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="h-9 text-xs shadow-sm"
          onClick={toggleSelectAll}
          title={selected.size === filtered.length ? "Deselect all" : "Select all"}
        >
          <input 
            type="checkbox" 
            checked={selected.size === filtered.length && filtered.length > 0}
            readOnly
            className="mr-2 w-3.5 h-3.5 accent-primary cursor-pointer"
          />
          {selected.size === filtered.length && filtered.length > 0 ? "Deselect all" : "Select all"}
        </Button>
        {selected.size > 0 && (
          <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 border animate-in slide-in-from-right">
            <Badge variant="secondary" className="text-xs font-bold">{selected.size} selected</Badge>
            <Button size="sm" variant="outline" className="h-8 text-xs shadow-sm" onClick={bulkMarkRead}>
              <CheckCheck className="h-3.5 w-3.5 mr-1" />
              Mark read
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 shadow-sm"
              onClick={() => {
                if (window.confirm(`Dismiss ${selected.size} notification${selected.size > 1 ? 's' : ''}? This cannot be undone.`)) {
                  bulkDismiss();
                }
              }}
              title={`Dismiss ${selected.size} selected notification${selected.size > 1 ? 's' : ''}`}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Dismiss {selected.size}
            </Button>
          </div>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto gap-1 bg-muted/60 p-1.5">
          {CATEGORY_TABS.map(t => {
            const count = tabUnreadCounts[t.value] || 0;
            return (
              <TabsTrigger key={t.value} value={t.value} className="gap-1.5 text-xs shadow-sm data-[state=active]:shadow-md">
                {t.icon && <span className="text-sm">{t.icon}</span>}
                {t.label}
                {count > 0 && (
                  <Badge className="bg-red-100 text-red-700 text-[10px] h-4 px-1.5 ml-1 font-bold">{count}</Badge>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {CATEGORY_TABS.map(t => (
          <TabsContent key={t.value} value={t.value} className="mt-4">
            {filtered.length === 0 ? (
              <Card className="shadow-sm">
                <CardContent className="py-16 text-center text-muted-foreground">
                  <CheckCheck className="h-10 w-10 mx-auto mb-3 text-green-500 opacity-60" />
                    <p className="text-sm font-medium text-foreground">
                      {search
                        ? `No results for "${search}"`
                        : readFilter === 'unread'
                        ? 'No unread notifications'
                        : readFilter === 'read'
                        ? 'No read notifications'
                        : t.value !== 'all'
                        ? `No ${t.label.toLowerCase()} notifications`
                        : 'No notifications here'}
                    </p>
                    <p className="text-xs mt-1 text-muted-foreground">
                      {search
                        ? 'Try a different search term or check another category'
                        : readFilter !== 'all'
                        ? `Switch to "All" to see ${readFilter === 'unread' ? 'read' : 'all'} notifications`
                        : t.value !== 'all'
                        ? 'Try the "All" tab to see everything'
                        : "You're all caught up"}
                    </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-0">
                {[
                  { label: 'Today', items: grouped.today },
                  { label: 'This week', items: grouped.thisWeek },
                  { label: 'Earlier', items: grouped.earlier },
                ].map(({ label, items }) =>
                  items.length === 0 ? null : (
                    <div key={label}>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1 pb-2 pt-4 first:pt-0">
                        {label}
                      </p>
                      <div className="space-y-1">
                        {items.map(n => {
                          const sc = SEVERITY_CONFIG[n.severity] || SEVERITY_CONFIG.info;
                          return (
                            <div
                              key={n.id}
                              className={`flex items-start gap-3 p-4 rounded-lg border cursor-pointer
                                hover:bg-muted/50 hover:shadow-sm transition-all group active:scale-[0.99]
                                ${!n.is_read ? sc.bg || "bg-blue-50/40 dark:bg-blue-950/10 border-blue-200 shadow-sm" : "border-border/50"}
                                ${selected.has(n.id) ? "ring-2 ring-primary shadow-md" : ""}
                              `}
                              onClick={() => handleNavigate(n)}
                            >
                              <input
                                type="checkbox"
                                className="mt-1 shrink-0 cursor-pointer w-4 h-4 accent-primary"
                                checked={selected.has(n.id)}
                                onChange={e => { e.stopPropagation(); toggleSelect(n.id); }}
                                onClick={e => e.stopPropagation()}
                                title="Select this notification"
                              />

                              <div className="mt-0.5 shrink-0">{sc.icon}</div>

                              <div className="flex-1 min-w-0">
                                <div className="flex items-start justify-between gap-2">
                                  <p className={`text-sm ${!n.is_read ? "font-semibold" : "font-medium"}`}>
                                    {n.title}
                                  </p>
                                  <span className="text-xs text-muted-foreground shrink-0">{relTime(n.created_date)}</span>
                                </div>
                                {n.message && <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{n.message}</p>}
                                <div className="flex items-center gap-2 mt-2 flex-wrap">
                                  {n.project_name && (
                                    <button
                                      className="text-xs text-blue-600 hover:underline truncate max-w-[180px] text-left font-medium"
                                      onClick={e => {
                                        e.stopPropagation();
                                        navigate(createPageUrl('ProjectDetails') + `?id=${n.project_id}`);
                                      }}
                                      title={n.project_name}
                                    >
                                      {n.project_name}
                                    </button>
                                  )}
                                  <Badge className="text-[10px] h-4 capitalize" variant="outline">{(n.category || 'system').replace(/_/g, ' ')}</Badge>
                                  {n.cta_url && (
                                    <span className="text-xs text-primary font-medium ml-auto flex items-center gap-0.5
                                      opacity-0 group-hover:opacity-100 transition-opacity">
                                      {n.cta_label || 'View'} <ChevronRight className="h-3 w-3" />
                                    </span>
                                  )}
                                </div>
                              </div>

                              {!n.is_read && (
                                <div className="w-2 h-2 rounded-full bg-blue-500 shrink-0 mt-2 animate-pulse" title="Unread" />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )
                )}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}