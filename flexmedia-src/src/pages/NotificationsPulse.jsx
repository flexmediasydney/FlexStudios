import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, AlertTriangle, Info, Bell, RefreshCw, User, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { fixTimestamp } from "@/components/utils/dateUtils";

const SEVERITY_CONFIG = {
  critical: { icon: AlertCircle, color: "text-red-500",   bg: "bg-red-50 border-red-200 dark:bg-red-950/20"    },
  warning:  { icon: AlertTriangle, color: "text-amber-500", bg: "bg-amber-50 border-amber-200 dark:bg-amber-950/20" },
  info:     { icon: Info,          color: "text-blue-400",  bg: ""                                               },
};

const CATEGORY_OPTIONS = [
  { value: "all",        label: "All categories" },
  { value: "tonomo",     label: "Tonomo"         },
  { value: "project",    label: "Projects"       },
  { value: "task",       label: "Tasks"          },
  { value: "revision",   label: "Revisions"      },
  { value: "scheduling", label: "Scheduling"     },
  { value: "financial",  label: "Financial"      },
  { value: "system",     label: "System"         },
];

const SEVERITY_OPTIONS = [
  { value: "all",      label: "All severities" },
  { value: "critical", label: "Critical"       },
  { value: "warning",  label: "Warning"        },
  { value: "info",     label: "Info"           },
];

function relTime(ts) {
  if (!ts) return "";
  const ms = Date.now() - new Date(fixTimestamp(ts)).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  if (h < 168) return `${Math.floor(h / 24)}d ago`;
  return new Date(fixTimestamp(ts)).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export default function NotificationsPulse() {
  const { data: currentUser } = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [readFilter, setReadFilter] = useState("all");
  const [userFilter, setUserFilter] = useState("all");

  const isAdmin = currentUser?.role === "master_admin" || currentUser?.role === "admin";

  const { data: allNotifications = [], isLoading, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["pulse-all-notifications"],
    queryFn: () => base44.entities.Notification.list("-created_date", 500),
    refetchInterval: 60_000, // Reduced — realtime handles instant updates
    enabled: isAdmin,
  });

  // Realtime subscription — auto-refetch when new notifications arrive
  useEffect(() => {
    if (!isAdmin) return;

    const unsubscribe = base44.entities.Notification.subscribe((event) => {
      if (!event) return;
      if (event.type === 'create' || event.type === 'update') {
        queryClient.invalidateQueries({ queryKey: ["pulse-all-notifications"] });
      }
    });

    return unsubscribe;
  }, [isAdmin, queryClient]);

  const { data: allUsers = [] } = useQuery({
    queryKey: ["pulse-users"],
    queryFn: () => base44.entities.User.list("-created_date", 200),
    staleTime: 5 * 60_000,
    enabled: isAdmin,
  });

  const userMap = useMemo(() => {
    const m = new Map();
    allUsers.forEach(u => m.set(u.id, u));
    return m;
  }, [allUsers]);

  const filtered = useMemo(() => {
    return allNotifications.filter(n => {
      if (category !== "all" && n.category !== category) return false;
      if (severity !== "all" && n.severity !== severity) return false;
      if (readFilter === "unread" && n.is_read) return false;
      if (readFilter === "read" && !n.is_read) return false;
      if (userFilter !== "all" && n.user_id !== userFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const user = userMap.get(n.user_id);
        if (
          !n.title?.toLowerCase().includes(q) &&
          !n.message?.toLowerCase().includes(q) &&
          !n.project_name?.toLowerCase().includes(q) &&
          !user?.full_name?.toLowerCase().includes(q) &&
          !user?.email?.toLowerCase().includes(q)
        ) return false;
      }
      return true;
    });
  }, [allNotifications, category, severity, readFilter, userFilter, search, userMap]);

  const stats = useMemo(() => ({
    total: allNotifications.length,
    unread: allNotifications.filter(n => !n.is_read).length,
    critical: allNotifications.filter(n => n.severity === "critical" && !n.is_read).length,
    today: allNotifications.filter(n => {
      if (!n.created_date) return false;
      const d = new Date(fixTimestamp(n.created_date));
      const now = new Date();
      return d.toDateString() === now.toDateString();
    }).length,
  }), [allNotifications]);

  if (!isAdmin) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        <Bell className="h-12 w-12 mx-auto mb-4 opacity-20" />
        <p>Admin access required to view the notification pulse.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Notification Pulse</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            All notifications across all users · live business activity
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
          {dataUpdatedAt && (
            <span className="text-xs text-muted-foreground">
              · updated {relTime(new Date(dataUpdatedAt).toISOString())}
            </span>
          )}
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Total (last 500)", value: stats.total, color: "text-foreground" },
          { label: "Unread", value: stats.unread, color: "text-blue-600" },
          { label: "Critical unread", value: stats.critical, color: "text-red-600" },
          { label: "Today", value: stats.today, color: "text-green-600" },
        ].map(s => (
          <div key={s.label} className="bg-muted/40 rounded-xl p-4 border border-border/50">
            <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
            <p className={`text-2xl font-semibold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search by title, project, user…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="h-9 w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CATEGORY_OPTIONS.map(o => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={setSeverity}>
          <SelectTrigger className="h-9 w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {SEVERITY_OPTIONS.map(o => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={readFilter} onValueChange={setReadFilter}>
          <SelectTrigger className="h-9 w-[120px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="unread">Unread</SelectItem>
            <SelectItem value="read">Read</SelectItem>
          </SelectContent>
        </Select>
        <Select value={userFilter} onValueChange={setUserFilter}>
          <SelectTrigger className="h-9 w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All users</SelectItem>
            {allUsers.map(u => (
              <SelectItem key={u.id} value={u.id}>
                {u.full_name || u.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(search || category !== "all" || severity !== "all" || readFilter !== "all" || userFilter !== "all") && (
          <Button variant="ghost" size="sm" onClick={() => {
            setSearch(""); setCategory("all"); setSeverity("all");
            setReadFilter("all"); setUserFilter("all");
          }}>
            Clear filters
          </Button>
        )}
      </div>

      {/* Notification list */}
      {isLoading ? (
        <div className="text-center py-16 text-muted-foreground text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">
          <Bell className="h-10 w-10 mx-auto mb-3 opacity-20" />
          No notifications match your filters
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground mb-2">
            Showing {filtered.length} of {allNotifications.length} notifications
          </p>
          {filtered.map(n => {
            const sc = SEVERITY_CONFIG[n.severity] || SEVERITY_CONFIG.info;
            const Icon = sc.icon;
            const user = userMap.get(n.user_id);

            return (
              <div
                key={n.id}
                className={`flex items-start gap-3 p-3 rounded-lg border transition-colors
                  ${!n.is_read ? sc.bg || "bg-blue-50/30 border-blue-100 dark:bg-blue-950/10" : "border-border/40 hover:bg-muted/30"}
                  ${n.project_id ? "cursor-pointer" : ""}
                `}
                onClick={() => {
                  if (n.project_id) navigate(createPageUrl("ProjectDetails") + `?id=${n.project_id}`);
                }}
              >
                <Icon className={`h-4 w-4 mt-0.5 flex-shrink-0 ${sc.color}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-0.5">
                    <span className="text-sm font-medium truncate">{n.title}</span>
                    <Badge variant="outline" className="text-xs py-0 h-5">{n.category}</Badge>
                    {!n.is_read && (
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-1">{n.message}</p>
                  <div className="flex items-center gap-3 mt-1">
                    {/* Who it went to */}
                    <span className="flex items-center gap-1 text-xs text-muted-foreground/70">
                      <User className="h-3 w-3" />
                      {user?.full_name || user?.email || n.user_id?.slice(0, 8)}
                    </span>
                    {n.project_name && (
                      <span className="text-xs text-muted-foreground/70 truncate max-w-[200px]">
                        {n.project_name}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground/50 ml-auto flex-shrink-0">
                      {relTime(n.created_date)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}