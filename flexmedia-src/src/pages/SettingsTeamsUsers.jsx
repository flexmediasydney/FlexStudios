import React, { useState, useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import InternalTeamsManagement from "@/components/settings/InternalTeamsManagement";
import UsersManagement from "@/components/settings/UsersManagement";
import StaffDefaultsPanel from "@/components/settings/StaffDefaultsPanel";
import CalendarIntegration from "@/components/calendar/CalendarIntegration";
import { Shield, Calendar, Users, ChevronDown, ChevronRight, Clock, UserCog } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import RolesSecurityPanel from "@/components/settings/RolesSecurityPanel";

export default function SettingsTeamsUsers() {
  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 lg:p-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Shield className="h-8 w-8" />
            Security & Access Control
          </h1>
          <p className="text-muted-foreground mt-1">Manage users, teams, roles, and permissions</p>
        </div>
        
        <Tabs defaultValue="teams" className="space-y-4">
          <TabsList>
            <TabsTrigger value="teams">
              <Users className="h-4 w-4 mr-1.5" />
              Teams
            </TabsTrigger>
            <TabsTrigger value="users">
              <Users className="h-4 w-4 mr-1.5" />
              Users
            </TabsTrigger>
            <TabsTrigger value="calendars">
              <Calendar className="h-4 w-4 mr-1.5" />
              Calendars
            </TabsTrigger>
            <TabsTrigger value="hours">
              <Clock className="h-4 w-4 mr-1.5" />
              Working Hours
            </TabsTrigger>
            <TabsTrigger value="staff-defaults">
              <UserCog className="h-4 w-4 mr-1.5" />
              Project Staff Defaults
            </TabsTrigger>
            <TabsTrigger value="security">
              <Shield className="h-4 w-4 mr-1.5" />
              Roles & Security
            </TabsTrigger>
          </TabsList>
          <TabsContent value="teams">
            <InternalTeamsManagement />
          </TabsContent>
          <TabsContent value="users">
            <UsersManagement />
          </TabsContent>
          <TabsContent value="calendars">
            <AdminCalendarManagement />
          </TabsContent>
          <TabsContent value="staff-defaults">
            <StaffDefaultsPanel />
          </TabsContent>
          <TabsContent value="security">
            <RolesSecurityPanel />
          </TabsContent>
          <TabsContent value="hours">
            <WorkingHoursAdmin />
          </TabsContent>
        </Tabs>
      </div>
    </PermissionGuard>
  );
}

function CleanupButton() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const handleRun = async () => {
    setRunning(true);
    setResult(null);
    try {
      const res = await api.functions.invoke('cleanupOrphanedCalendarEvents', {});
      setResult(res.data);
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-2 flex-shrink-0">
      <button
        onClick={handleRun}
        disabled={running}
        className="px-3 py-1.5 rounded-lg border text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
      >
        {running ? "Running…" : "Run Cleanup"}
      </button>
      {result && !result.error && (
        <p className="text-xs text-green-700">
          ✓ {result.orphaned_project_links} links + {result.orphaned_account_events} events cleaned
        </p>
      )}
      {result?.error && (
        <p className="text-xs text-red-600">✕ {result.error}</p>
      )}
    </div>
  );
}

function AdminCalendarManagement() {
  const [expandedUser, setExpandedUser] = useState(null);

  const { data: users = [] } = useQuery({
    queryKey: ["all-users-for-cal-admin"],
    queryFn: () => api.entities.User.list(),
    staleTime: 60_000,
  });

  const { data: allConnections = [] } = useQuery({
    queryKey: ["all-calendar-connections-admin"],
    queryFn: () => api.asServiceRole
      ? api.asServiceRole.entities.CalendarConnection.list('-created_date', 1000)
      : api.entities.CalendarConnection.list('-created_date', 1000),
    staleTime: 30_000,
  });

  // Group connections by user email
  const connectionsByUser = users.map(u => {
    const userConns = allConnections.filter(c => c.created_by === u.email);
    const isAdmin = u.role === 'master_admin' || u.role === 'admin';
    const limit = isAdmin ? 5 : 2;
    return { user: u, connections: userConns, limit, atLimit: userConns.length >= limit };
  }).filter(g => g.connections.length > 0 || g.user.role === 'master_admin');

  const totalConnections = allConnections.length;
  const atLimitUsers = connectionsByUser.filter(g => g.atLimit).length;
  const brokenConnections = allConnections.filter(c => !c.refresh_token).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Calendar Connections</h2>
        <p className="text-sm text-muted-foreground mt-1">
          View and manage all team members' Google Calendar connections.
          Regular users: max 2. Admins: max 5.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border p-4">
          <div className="text-2xl font-bold">{totalConnections}</div>
          <div className="text-xs text-muted-foreground mt-1">Total connections</div>
        </div>
        <div className={`rounded-lg border p-4 ${atLimitUsers > 0 ? 'border-amber-200 bg-amber-50' : ''}`}>
          <div className="text-2xl font-bold">{atLimitUsers}</div>
          <div className="text-xs text-muted-foreground mt-1">Users at limit</div>
        </div>
        <div className={`rounded-lg border p-4 ${brokenConnections > 0 ? 'border-red-200 bg-red-50' : ''}`}>
          <div className="text-2xl font-bold text-red-600">{brokenConnections}</div>
          <div className="text-xs text-muted-foreground mt-1">Broken (no token)</div>
        </div>
      </div>

      {/* Admin cleanup action */}
      <div className="rounded-lg border border-dashed p-4 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Orphaned event cleanup</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Removes broken project links and events from disconnected accounts.
            Safe to run at any time.
          </p>
        </div>
        <CleanupButton />
      </div>

      {/* Per-user breakdown */}
      <div className="space-y-2">
        {connectionsByUser.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No calendar connections found.</p>
        ) : (
          connectionsByUser.map(({ user, connections, limit, atLimit }) => (
            <div key={user.id} className="border rounded-lg overflow-hidden">
              <button
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors text-left"
                onClick={() => setExpandedUser(expandedUser === user.id ? null : user.id)}
              >
                <div className="flex items-center gap-3">
                  <Users className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <div>
                    <span className="font-medium text-sm">{user.full_name || user.email}</span>
                    <span className="text-xs text-muted-foreground ml-2">{user.email}</span>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {user.role}
                  </Badge>
                  {atLimit && (
                    <Badge className="text-xs bg-amber-100 text-amber-700 border-amber-200">
                      At limit
                    </Badge>
                  )}
                  {connections.some(c => !c.refresh_token) && (
                    <Badge className="text-xs bg-red-100 text-red-700 border-red-200">
                      Broken token
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {connections.length} / {limit}
                  </span>
                  {expandedUser === user.id
                    ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    : <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  }
                </div>
              </button>

              {expandedUser === user.id && (
                <div className="border-t p-4">
                  <CalendarIntegration
                    selectedUserEmail={user.email}
                    compact={false}
                  />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function WorkingHoursAdmin() {
  const queryClient = useQueryClient();
  const { data: users = [] } = useQuery({
    queryKey: ['all-users-hours'],
    queryFn: () => api.entities.User.list(),
    staleTime: 60_000,
  });
  const { data: allAvailability = [] } = useQuery({
    queryKey: ['photographer-availability'],
    queryFn: () => api.entities.PhotographerAvailability.list(),
    staleTime: 30_000,
  });
  const [selectedUser, setSelectedUser] = useState(null);

  const userAvailability = useMemo(() =>
    allAvailability.filter(a => a.user_id === selectedUser),
    [allAvailability, selectedUser]
  );

  const availByDay = useMemo(() => {
    const map = {};
    for (let d = 0; d < 7; d++) {
      map[d] = userAvailability.find(a => a.day_of_week === d) || {
        day_of_week: d, start_time: '09:00', end_time: '17:00', is_available: d >= 1 && d <= 5
      };
    }
    return map;
  }, [userAvailability]);

  const saveDay = async (dayData) => {
    // Validate time format and ordering
    if (dayData.is_available) {
      if (!dayData.start_time || !dayData.end_time) {
        toast.error("Start and end time are required for available days");
        return;
      }
      if (dayData.start_time >= dayData.end_time) {
        toast.error("End time must be after start time");
        return;
      }
    }
    const existing = userAvailability.find(a => a.day_of_week === dayData.day_of_week);
    const payload = { ...dayData, user_id: selectedUser };
    if (existing) {
      await api.entities.PhotographerAvailability.update(existing.id, payload);
    } else {
      await api.entities.PhotographerAvailability.create(payload);
    }
    queryClient.invalidateQueries({ queryKey: ['photographer-availability'] });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Working Hours</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Set availability windows per team member. Unavailable hours are shaded in the team calendar.
        </p>
      </div>
      <div className="max-w-xs">
        <select
          className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
          value={selectedUser || ''}
          onChange={e => setSelectedUser(e.target.value || null)}
        >
          <option value="">Select a team member…</option>
          {users.map(u => (
            <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
          ))}
        </select>
      </div>
      {selectedUser && (
        <div className="space-y-2 max-w-lg">
          {DAYS.map((day, i) => {
            const avail = availByDay[i];
            return (
              <div key={i} className="flex items-center gap-3 p-3 border rounded-lg">
                <div className="w-10 text-sm font-medium">{day}</div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={avail.is_available}
                    onChange={e => saveDay({ ...avail, is_available: e.target.checked })}
                    className="rounded"
                  />
                  <span className="text-sm text-muted-foreground">Available</span>
                </label>
                {avail.is_available && (
                  <>
                    <input
                      type="time"
                      value={avail.start_time}
                      onChange={e => saveDay({ ...avail, start_time: e.target.value })}
                      className="border rounded px-2 py-1 text-sm bg-background"
                    />
                    <span className="text-muted-foreground text-sm">to</span>
                    <input
                      type="time"
                      value={avail.end_time}
                      onChange={e => saveDay({ ...avail, end_time: e.target.value })}
                      className="border rounded px-2 py-1 text-sm bg-background"
                    />
                  </>
                )}
                {!avail.is_available && (
                  <span className="text-sm text-muted-foreground italic">Day off</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}