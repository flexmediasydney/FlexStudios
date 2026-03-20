import { useState, useMemo, useEffect, useRef } from "react";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Zap, RefreshCw, ChevronDown, ChevronRight, ExternalLink, Copy } from "lucide-react";
import { parsePayload, parseTS, toSydney, relativeTime, ACTION_COLORS, ACTION_LABELS } from "@/components/tonomo/tonomoUtils";

export default function TonomoPulse() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [view, setView] = useState("stream"); // stream | grouped | dashboard
  const [filter, setFilter] = useState("all");
  const [expandedId, setExpandedId] = useState(null);
  const [expandedGroupId, setExpandedGroupId] = useState(null);
  const [cardTabs, setCardTabs] = useState({});
  const seenIds = useRef(new Set());
  const [newIds, setNewIds] = useState(new Set());
  const glowTimeouts = useRef({});

  const { data: logs = [], refetch } = useQuery({
    queryKey: ['tonomoPulse'],
    queryFn: async () => {
      const result = await base44.entities.TonomoWebhookLog.list('-received_at', 200);
      return result;
    },
    staleTime: 5 * 1000,
    refetchInterval: autoRefresh ? 5000 : false,
  });

  useEffect(() => {
    return () => {
      Object.values(glowTimeouts.current).forEach(clearTimeout);
    };
  }, []);

  const parsedRecords = useMemo(() => {
    return logs.map(log => ({
      record: log,
      parsed: parsePayload(log.raw_payload || "{}"),
      receivedDate: parseTS(log.received_at) || parseTS(log.received_date) || parseTS(log.created_date) || parseTS(log.created_at)
    }));
  }, [logs]);

  useEffect(() => {
    const currentIds = new Set(parsedRecords.map(p => p.record.id));
    const added = new Set();
    currentIds.forEach(id => {
      if (!seenIds.current.has(id)) {
        added.add(id);
        glowTimeouts.current[id] = setTimeout(() => {
          setNewIds(prev => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          delete glowTimeouts.current[id];
        }, 10000);
      }
    });
    if (added.size > 0) {
      setNewIds(prev => new Set([...prev, ...added]));
    }
    seenIds.current = currentIds;
  }, [parsedRecords]);

  const today = useMemo(() => {
    const sydneyNow = new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
    const sydneyToday = new Date(sydneyNow).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" });
    return parsedRecords.filter(p => {
      if (!p.receivedDate) return false;
      const logDate = p.receivedDate.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" });
      return logDate === sydneyToday;
    });
  }, [parsedRecords]);

  const thisWeek = useMemo(() => {
    // Calculate Monday 00:00 Sydney time without relying on locale string parsing.
    // Use UTC offset for Australia/Sydney via Intl.DateTimeFormat to get a reliable
    // Sydney "wall clock" date, then work purely in UTC milliseconds.
    const now = new Date();
    const sydneyParts = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).formatToParts(now);
    const get = (type) => parseInt(sydneyParts.find(p => p.type === type)?.value || '0');
    const sydneyDate = new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')));
    const dayOfWeek = sydneyDate.getUTCDay();
    const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const mondayStart = new Date(sydneyDate);
    mondayStart.setUTCDate(sydneyDate.getUTCDate() - diff);
    mondayStart.setUTCHours(0, 0, 0, 0);
    return parsedRecords.filter(p => p.receivedDate >= mondayStart);
  }, [parsedRecords]);

  const eventBreakdown = useMemo(() => {
    const counts = {};
    const todayRecords = parsedRecords.filter(p => {
      if (!p.receivedDate) return false;
      const sydneyNow = new Date().toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" });
      const recDate = p.receivedDate.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" });
      return recDate === sydneyNow;
    });
    todayRecords.forEach(p => {
      const action = p.parsed.action || 'unknown';
      counts[action] = (counts[action] || 0) + 1;
    });
    counts.errors = todayRecords.filter(p => p.record.parse_error).length;
    return counts;
  }, [parsedRecords]);

  const signalHealth = useMemo(() => {
    const todayRecords = parsedRecords.filter(p => {
      if (!p.receivedDate) return false;
      const sydneyNow = new Date().toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" });
      const recDate = p.receivedDate.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" });
      return recDate === sydneyNow;
    });
    const fields = ['has_photographer', 'has_services', 'has_address', 'has_agent'];
    const result = {};
    fields.forEach(field => {
      const t = todayRecords.filter(p => p.record[field]).length;
      const f = todayRecords.length - t;
      const pct = todayRecords.length > 0 ? Math.round((t / todayRecords.length) * 100) : 0;
      result[field.replace('has_', '')] = { true: t, false: f, percent: pct };
    });
    return result;
  }, [parsedRecords]);

  const stats = useMemo(() => {
    const fullCoverage = today.filter(p =>
      p.record.has_photographer && p.record.has_services && p.record.has_address && 
      p.record.has_agent && p.record.has_appointment_time
    ).length;
    const errors = parsedRecords.filter(p => p.record.parse_error).length;
    return {
      today: today.length,
      thisWeek: thisWeek.length,
      errors,
      coverage: today.length > 0 ? Math.round((fullCoverage / today.length) * 100) : 0,
    };
  }, [parsedRecords, today, thisWeek]);

  const filteredRecords = useMemo(() => {
    if (filter === "all") return parsedRecords;
    if (filter === "errors") return parsedRecords.filter(p => p.record.parse_error);
    if (filter === "cancelled_orders") return parsedRecords.filter(p => p.parsed.isOrderCancelled);
    return parsedRecords.filter(p => p.parsed.action === filter);
  }, [parsedRecords, filter]);

  const groupedRecords = useMemo(() => {
    const groups = {};
    filteredRecords.forEach(p => {
      const oid = p.parsed.orderId;
      if (!groups[oid]) groups[oid] = [];
      groups[oid].push(p);
    });
    
    return Object.entries(groups).map(([orderId, records]) => {
      const latest = records[0];
      const sorted = [...records].sort((a, b) => a.receivedDate - b.receivedDate);
      
      const deduped = sorted.filter((p, idx) => {
        if (idx === 0) return true;
        const prev = sorted[idx - 1];
        if (p.parsed.action === "booking_created_or_changed" && prev.parsed.action === "booking_created_or_changed") {
          return p.parsed.invoiceAmount !== prev.parsed.invoiceAmount || p.parsed.orderStatus !== prev.parsed.orderStatus;
        }
        return true;
      });
      
      const hasCompleted = records.some(p => p.parsed.action === "booking_completed");
      const hasCancelled = records.some(p => p.parsed.isOrderCancelled);
      const hasFullyCancelled = records.some(p => p.parsed.isFullyCancelled);
      
      let borderColor = "#3b3f4d";
      if (hasCompleted) borderColor = "#10b981";
      else if (hasFullyCancelled) borderColor = "#ef4444";
      else if (hasCancelled) borderColor = "#dc2626";
      
      return {
        orderId,
        records: deduped,
        latest,
        count: deduped.length,
        hasCompleted,
        hasCancelled,
        hasFullyCancelled,
        borderColor
      };
    }).sort((a, b) => b.latest.receivedDate - a.latest.receivedDate);
  }, [filteredRecords]);

  const handleCardClick = (id) => {
    setExpandedId(expandedId === id ? null : id);
    if (!cardTabs[id]) {
      setCardTabs({ ...cardTabs, [id]: "details" });
    }
  };

  const handleGroupClick = (orderId) => {
    setExpandedGroupId(expandedGroupId === orderId ? null : orderId);
  };

  const handleTabChange = (id, tab) => {
    setCardTabs({ ...cardTabs, [id]: tab });
  };

  return (
    <ErrorBoundary>
    <div className="min-h-screen" style={{ backgroundColor: "#0f1117" }}>
      {/* Header */}
      <div className="sticky top-0 z-10" style={{ backgroundColor: "#1a1d27", borderBottom: "1px solid #2a2d3a" }}>
        <div className="px-6 py-3 flex items-center justify-between" style={{ height: "56px" }}>
          <div className="flex items-center gap-3">
            <Zap className="h-6 w-6" style={{ color: "#f59e0b" }} />
            <h1 className="text-xl font-bold text-white">Tonomo Pulse</h1>
            <div className="flex items-center gap-2">
              <div 
                className="h-2 w-2 rounded-full" 
                style={{ 
                  backgroundColor: "#22c55e",
                  animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite"
                }} 
              />
              <span className="text-xs font-medium uppercase tracking-wide" style={{ color: "#22c55e" }}>LIVE</span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <StatPill label="Today" value={stats.today} />
            <StatPill label="This Week" value={stats.thisWeek} />
            <StatPill label="Errors" value={stats.errors} />
            <StatPill label="Coverage" value={`${stats.coverage}%`} />
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
              <span className="text-sm text-white">Auto</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <div className="flex gap-1 rounded-full p-1" style={{ backgroundColor: "#2a2d3a" }}>
              <button
                className="px-3 py-1 rounded-full text-sm transition-colors"
                style={view === "stream" ? { backgroundColor: "#ffffff", color: "#000000" } : { color: "#9ca3af" }}
                onClick={() => setView("stream")}
              >
                Stream
              </button>
              <button
                className="px-3 py-1 rounded-full text-sm transition-colors"
                style={view === "grouped" ? { backgroundColor: "#ffffff", color: "#000000" } : { color: "#9ca3af" }}
                onClick={() => setView("grouped")}
              >
                Grouped
              </button>
              <button
                className="px-3 py-1 rounded-full text-sm transition-colors"
                style={view === "dashboard" ? { backgroundColor: "#ffffff", color: "#000000" } : { color: "#9ca3af" }}
                onClick={() => setView("dashboard")}
              >
                Dashboard
              </button>
              <button
                className="px-3 py-1 rounded-full text-sm transition-colors"
                style={view === "diagnostics" ? { backgroundColor: "#ffffff", color: "#000000" } : { color: "#9ca3af" }}
                onClick={() => setView("diagnostics")}
              >
                Diagnostics
              </button>
            </div>
          </div>
        </div>

        {/* Filter bar */}
        <div 
          className="px-4 pb-3 overflow-x-auto" 
          style={{ 
            height: "44px",
            borderBottom: "1px solid #2a2d3a",
            scrollbarWidth: "none",
            msOverflowStyle: "none"
          }}
        >
          <div className="flex gap-2">
            {["all", "scheduled", "rescheduled", "canceled", "changed", "booking_created_or_changed", "booking_completed", "new_customer", "errors", "cancelled_orders"].map(f => {
              const isActive = filter === f;
              const color = f === "all" ? "#3b3f4d" : 
                           f === "errors" || f === "cancelled_orders" ? ACTION_COLORS.error : 
                           ACTION_COLORS[f] || ACTION_COLORS.unknown;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className="px-3 py-1 rounded-full text-xs whitespace-nowrap transition-colors"
                  style={isActive ? {
                    backgroundColor: color,
                    color: 'white'
                  } : {
                    backgroundColor: '#2a2d3a',
                    color: '#9ca3af'
                  }}
                >
                  {f === "all" ? "All" : 
                   f === "errors" ? "errors" : 
                   f === "cancelled_orders" ? "cancelled_orders" :
                   ACTION_LABELS[f]}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="p-6">
        {filteredRecords.length === 0 ? (
          <div className="text-center" style={{ marginTop: "80px" }}>
            <Zap className="h-12 w-12 mx-auto mb-4" style={{ color: "#f59e0b" }} />
            <p className="text-white text-base">
              {filter === "all" ? "No webhook events yet" : `No ${filter} events found`}
            </p>
            {filter === "all" && (
              <p className="text-gray-500 text-sm mt-1">Waiting for Tonomo...</p>
            )}
          </div>
        ) : view === "dashboard" ? (
          <Dashboard parsedRecords={parsedRecords} today={today} thisWeek={thisWeek} stats={stats} />
        ) : view === "diagnostics" ? (
         <div className="p-6 space-y-6 bg-background min-h-screen" style={{ backgroundColor: "#0f1117" }}>
           <div>
             <h2 className="text-2xl font-bold text-white">Webhook Diagnostics</h2>
             <p className="text-muted-foreground mt-1" style={{ color: "#9ca3af" }}>
               Coverage metrics and signal health for today's bookings
             </p>
           </div>

           {/* Coverage Summary */}
           <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
             <div className="rounded-lg border p-4" style={{ backgroundColor: "#1a1d27", borderColor: "#2a2d3a" }}>
               <div className="text-xs mb-1" style={{ color: "#9ca3af" }}>Total Events</div>
               <div className="text-3xl font-bold text-white">{parsedRecords.length}</div>
             </div>
             <div className="rounded-lg border p-4" style={{ backgroundColor: "#1a1d27", borderColor: "#2a2d3a" }}>
               <div className="text-xs mb-1" style={{ color: "#9ca3af" }}>Today</div>
               <div className="text-3xl font-bold text-white">{stats.today}</div>
             </div>
             <div className="rounded-lg border p-4" style={{ backgroundColor: stats.coverage >= 90 ? '#dcfce7' : stats.coverage >= 50 ? '#fef9c3' : '#fee2e2', borderColor: "#2a2d3a" }}>
               <div className="text-xs mb-1" style={{ color: "#9ca3af" }}>Coverage</div>
               <div className="text-3xl font-bold">{stats.coverage}%</div>
               <p className="text-xs text-muted-foreground mt-1" style={{ color: "#9ca3af" }}>Full signal coverage today</p>
             </div>
             <div className="rounded-lg border p-4" style={{ backgroundColor: "#1a1d27", borderColor: "#2a2d3a" }}>
               <div className="text-xs mb-1" style={{ color: "#9ca3af" }}>Errors</div>
               <div className="text-3xl font-bold text-red-600">{stats.errors}</div>
             </div>
           </div>

           {/* Event Type Breakdown */}
           <div className="rounded-lg border p-4" style={{ backgroundColor: "#1a1d27", borderColor: "#2a2d3a" }}>
             <h3 className="text-white font-bold mb-3">Event Type Breakdown (Today)</h3>
             <div className="flex flex-wrap gap-2">
               {Object.entries(eventBreakdown).map(([action, count]) => {
                 const color = ACTION_COLORS[action] || ACTION_COLORS.unknown;
                 return (
                   <div key={action} className="px-3 py-1 rounded font-bold"
                     style={{ backgroundColor: `${color}33`, color }}>
                     {ACTION_LABELS[action] || action} · {count}
                   </div>
                 );
               })}
             </div>
           </div>

           {/* Signal Health */}
           <div className="rounded-lg border p-4" style={{ backgroundColor: "#1a1d27", borderColor: "#2a2d3a" }}>
             <h3 className="text-white font-bold mb-3">Signal Health (Today)</h3>
             <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
               {Object.entries(signalHealth).map(([name, data]) => (
                 <div key={name} className="space-y-2">
                   <div className="font-medium capitalize text-white">{name}</div>
                   <div className="text-sm" style={{ color: "#9ca3af" }}>
                     ✅ {data.true} · ❌ {data.false}
                   </div>
                   <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: "#2a2d3a" }}>
                     <div 
                       className="h-full rounded-full transition-all"
                       style={{ 
                         width: `${data.percent}%`,
                         backgroundColor: "#22c55e"
                       }}
                     />
                   </div>
                   <div className="text-xs" style={{ color: "#9ca3af" }}>{data.percent}%</div>
                 </div>
               ))}
             </div>
           </div>
         </div>
        ) : view === "stream" ? (
          <div className="space-y-2 max-w-6xl mx-auto">
            {filteredRecords.map(p => (
              <EventCard
                key={p.record.id}
                item={p}
                expanded={expandedId === p.record.id}
                onToggle={() => handleCardClick(p.record.id)}
                isNew={newIds.has(p.record.id)}
                activeTab={cardTabs[p.record.id] || "details"}
                onTabChange={(tab) => handleTabChange(p.record.id, tab)}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-2 max-w-6xl mx-auto">
            {groupedRecords.map(group => (
              <GroupCard
                key={group.orderId}
                group={group}
                expanded={expandedGroupId === group.orderId}
                onToggle={() => handleGroupClick(group.orderId)}
              />
            ))}
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
    </ErrorBoundary>
  );
}

function StatPill({ label, value }) {
  return (
    <div className="px-3 py-1 rounded-full" style={{ backgroundColor: "#2a2d3a" }}>
      <span className="text-xs" style={{ color: "#9ca3af" }}>{label} </span>
      <span className="text-sm font-bold text-white">{value}</span>
    </div>
  );
}

function EventCard({ item, expanded, onToggle, isNew, activeTab, onTabChange }) {
  const { record, parsed, receivedDate } = item;
  
  let bgColor = "#1a1d27";
  if (parsed.isFullyCancelled) bgColor = "#1f1515";
  else if (parsed.isOrderCancelled) bgColor = "#1c1515";
  else if (parsed.action === "booking_completed") bgColor = "#0d1f17";
  
  const boxShadow = isNew ? "0 0 14px #22c55e66" : "none";
  
  const isDelivered = parsed.action === "booking_completed";

  return (
    <div
      className="rounded-lg border cursor-pointer transition-all"
      style={{
        backgroundColor: bgColor,
        borderColor: "#2a2d3a",
        borderLeftWidth: "3px",
        borderLeftColor: ACTION_COLORS[parsed.action],
        marginBottom: "8px",
        boxShadow
      }}
      onClick={onToggle}
    >
      <div className="px-3.5 py-3">
        <div className="flex items-center gap-3 mb-1">
          <div 
            className="px-2 py-0.5 rounded text-xs"
            style={{ 
              backgroundColor: `${ACTION_COLORS[parsed.action]}26`,
              color: ACTION_COLORS[parsed.action]
            }}
          >
            {ACTION_LABELS[parsed.action]}
          </div>
          <span className="flex-1 text-white text-xs truncate" style={{ maxWidth: "400px" }}>
            {parsed?.address?.slice(0, 50) || "No address"}
          </span>
          {parsed.videoProject === true && (
            <Badge variant="secondary" className="text-xs">🎬 Video</Badge>
          )}
          {parsed.videoProject === false && (
            <Badge variant="secondary" className="text-xs">📷 Stills</Badge>
          )}
          <span className="text-xs" style={{ color: "#9ca3af" }}>{relativeTime(receivedDate)}</span>
          <span className="text-xs" style={{ color: "#71717a" }}>{toSydney(receivedDate)}</span>
        </div>
        
        <div 
          className="text-xs mb-1"
          style={{ 
            color: parsed.isFullyCancelled || parsed.isOrderCancelled ? "#f87171" :
                   parsed.action === "booking_completed" ? "#6ee7b7" :
                   parsed.action === "error" ? "#f87171" : "#cbd5e1"
          }}
        >
          {parsed.action === "error" && "⚠️ "}{parsed.summary}
        </div>

        <div className="flex items-center gap-3 text-xs" style={{ color: "#71717a" }}>
          {isDelivered ? (
            <>
              <span>✅ Delivered</span>
              {Array.isArray(parsed?.deliveredFiles) && parsed.deliveredFiles.length > 0 && (
                <span>· {parsed.deliveredFiles.length} file{parsed.deliveredFiles.length !== 1 ? "s" : ""}</span>
              )}
            </>
          ) : (
            <>
              <SignalDot emoji="📷" value={record.has_photographer} />
              <SignalDot emoji="🛠" value={record.has_services} />
              <SignalDot emoji="📍" value={record.has_address} />
              <SignalDot emoji="👤" value={record.has_agent} />
              <SignalDot emoji="🕐" value={record.has_appointment_time} />
            </>
          )}
        </div>
      </div>

      {expanded && (
        <div 
          className="border-t px-4 py-3"
          style={{ borderColor: "#2a2d3a" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex gap-4 mb-3">
            <button
              onClick={() => onTabChange("details")}
              className="pb-1 text-sm transition-colors"
              style={{
                color: activeTab === "details" ? "white" : "#9ca3af",
                borderBottom: activeTab === "details" ? "2px solid #3b82f6" : "2px solid transparent"
              }}
            >
              Details
            </button>
            <button
              onClick={() => onTabChange("brief")}
              className="pb-1 text-sm transition-colors"
              style={{
                color: activeTab === "brief" ? "white" : "#9ca3af",
                borderBottom: activeTab === "brief" ? "2px solid #3b82f6" : "2px solid transparent"
              }}
            >
              Order Brief
            </button>
            <button
              onClick={() => onTabChange("payload")}
              className="pb-1 text-sm transition-colors"
              style={{
                color: activeTab === "payload" ? "white" : "#9ca3af",
                borderBottom: activeTab === "payload" ? "2px solid #3b82f6" : "2px solid transparent"
              }}
            >
              Payload
            </button>
          </div>

          {activeTab === "brief" ? (
            <OrderBriefDark parsed={parsed} record={record} />
          ) : activeTab === "details" ? (
            <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-1.5 text-xs">
              <DetailItem label="Action">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full" style={{ backgroundColor: ACTION_COLORS[parsed.action] }} />
                  <span style={{ color: "#cbd5e1" }}>{ACTION_LABELS[parsed.action]}</span>
                </div>
              </DetailItem>
              <DetailItem label="Order ID">
                <div className="flex items-center gap-2">
                  <code className="font-mono text-xs" style={{ color: "#cbd5e1" }}>{parsed.orderId}</code>
                  <button onClick={() => navigator.clipboard.writeText(parsed.orderId)}>
                    <Copy className="h-3 w-3" style={{ color: "#9ca3af" }} />
                  </button>
                </div>
              </DetailItem>
              <DetailItem label="Order Name" value={parsed.orderName} />
              <DetailItem label="Photographer">
                {parsed.photographer ? (
                  <div>
                    <div style={{ color: "#cbd5e1" }}>{parsed.photographer.name}</div>
                    <div style={{ color: "#71717a" }}>{parsed.photographer.email}</div>
                  </div>
                ) : <span style={{ color: "#cbd5e1" }}>Unassigned</span>}
              </DetailItem>
              <DetailItem label="Agent">
                {parsed.agent ? (
                  <div>
                    <div style={{ color: "#cbd5e1" }}>{parsed.agent.name}</div>
                    <div style={{ color: "#71717a" }}>{parsed.agent.email}</div>
                  </div>
                ) : <span style={{ color: "#cbd5e1" }}>None</span>}
              </DetailItem>
              <DetailItem label="Address" value={parsed.address} />
              <DetailItem label="Booking Flow" value={parsed.bookingFlow || "—"} />
              <DetailItem label="Shoot Start" value={parsed.startTime ? toSydney(new Date(parsed.startTime)) : "Not scheduled"} />
              <DetailItem label="Duration" value={parsed.durationMinutes ? `${parsed.durationMinutes} min` : "—"} />
              <DetailItem label="Services" value={Array.isArray(parsed?.services) ? parsed.services.join(", ") : "None"} />
              <DetailItem label="Service Tiers">
                {Array.isArray(parsed?.tiers) && parsed.tiers.length > 0 ? (
                  <div className="space-y-0.5">
                    {parsed.tiers.map((t, i) => (
                      <div key={i} style={{ color: "#cbd5e1" }}>{t.name} → {t.selected || "None"}</div>
                    ))}
                  </div>
                ) : <span style={{ color: "#cbd5e1" }}>None</span>}
              </DetailItem>
              <DetailItem label="Package" value={parsed.package || "—"} />
              <DetailItem label="Invoice Amount" value={parsed.invoiceAmount ? `$${parsed.invoiceAmount}` : "—"} />
              <DetailItem label="Invoice Link">
                {parsed.invoiceLink ? (
                  <a href={parsed.invoiceLink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1" style={{ color: "#60a5fa" }}>
                    View invoice <ExternalLink className="h-3 w-3" />
                  </a>
                ) : <span style={{ color: "#cbd5e1" }}>—</span>}
              </DetailItem>
              <DetailItem label="Order Status">
                <span style={{ 
                  color: parsed.orderStatus === 'inProgress' ? '#60a5fa' :
                         parsed.orderStatus === 'cancelled' ? '#f87171' :
                         parsed.orderStatus === 'complete' ? '#6ee7b7' : '#cbd5e1'
                }}>
                  {parsed.orderStatus || "—"}
                </span>
              </DetailItem>
              <DetailItem label="Payment Status">
                <span style={{ 
                  color: parsed.paymentStatus === 'unpaid' ? '#fbbf24' :
                         parsed.paymentStatus === 'paid' ? '#6ee7b7' : '#cbd5e1'
                }}>
                  {parsed.paymentStatus || "—"}
                </span>
              </DetailItem>
              <DetailItem label="Video Project" value={parsed.videoProject === true ? "Yes" : parsed.videoProject === false ? "No" : "Unknown"} />
              <DetailItem label="Cancellation State">
                <span style={{ 
                  color: parsed.isFullyCancelled ? '#f87171' : parsed.isOrderCancelled ? '#fbbf24' : '#cbd5e1'
                }}>
                  {parsed.isFullyCancelled ? "Fully cancelled" : parsed.isOrderCancelled ? "Order cancelled" : "—"}
                </span>
              </DetailItem>
              <DetailItem label="Delivered At" value={parsed.deliveredAt ? toSydney(parsed.deliveredAt) : "—"} />
              <DetailItem label="Delivered Files">
                {Array.isArray(parsed?.deliveredFiles) && parsed.deliveredFiles.length > 0 ? (
                  <div className="space-y-1">
                    {parsed.deliveredFiles.map((file, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="font-bold" style={{ color: "#cbd5e1" }}>{file?.name || "Unnamed"}</span>
                        <Badge variant="outline" className="text-xs">{file?.type || "Unknown"}</Badge>
                        <a href={file?.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs" style={{ color: "#60a5fa" }}>
                          Download <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    ))}
                  </div>
                ) : <span style={{ color: "#cbd5e1" }}>—</span>}
              </DetailItem>
              <DetailItem label="CC Contacts" value={Array.isArray(parsed?.contacts) ? parsed.contacts.join(", ") : "—"} />
              <DetailItem label="Source IP" value={record.source_ip || "—"} />
            </div>
          ) : (
            <pre 
              className="font-mono overflow-auto"
              style={{
                backgroundColor: "#0a0c12",
                color: "#f8f8f2",
                fontSize: "12px",
                padding: "12px",
                borderRadius: "6px",
                maxHeight: "500px",
                whiteSpace: "pre",
                wordBreak: "normal"
              }}
            >
              {JSON.stringify(parsed.raw, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function SignalDot({ emoji, value }) {
  const color = value === true ? "#22c55e" : value === false ? "#ef4444" : "#6b7280";
  return (
    <div className="flex items-center gap-1">
      <span>{emoji}</span>
      <div className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
    </div>
  );
}

function DetailItem({ label, value, children }) {
  return (
    <>
      <div style={{ color: "#9ca3af" }} className="text-right">{label}</div>
      <div>{children || <span style={{ color: "#cbd5e1" }}>{value}</span>}</div>
    </>
  );
}

function OrderBriefDark({ parsed, record }) {
  const { raw } = parsed;
  if (!raw) return <div style={{ color: "#9ca3af" }}>No data available</div>;

  const agent = parsed.agent || {};
  const brokerage = raw.order?.brokerage || raw.brokerage || null;
  const rooms = raw.order?.rooms || raw.rooms || {};
  const totalHrs = Array.isArray(parsed?.tiers) ? parsed.tiers.reduce((sum, t) => sum + (t.hrs || 0), 0) : 0;
  const coupon = raw.order?.coupon || raw.coupon || null;
  const travels = raw.order?.travels || [];
  const members = raw.order?.members || [];
  const deliverableLink = raw.deliverable_link || raw.order?.deliverable_link || null;
  const deliverablePath = raw.deliverable_path || raw.order?.deliverable_path || null;
  const orderNo = raw.order?.orderNo || raw.orderNo || null;
  const invoiceNo = raw.order?.invoiceNo || raw.invoiceNo || null;
  const isFirstOrder = raw.isFirstOrder || false;

  const topWhen = parsed.startTime ? { start: parsed.startTime, end: parsed.endTime } : null;
  const orderWhen = (raw.order?.when?.start_time && raw.order.when.start_time !== raw.when?.start_time) ? 
    { start: raw.order.when.start_time * 1000, end: raw.order.when.end_time * 1000 } : null;

  return (
    <div className="space-y-4 text-sm">
      {/* Who booked */}
      <div>
        <h3 className="font-semibold mb-2 text-white">Who booked</h3>
        <div style={{ color: "#cbd5e1" }}>
          {agent.name || "Unknown agent"}
          {brokerage && ` from ${brokerage}`}
          {isFirstOrder && <Badge className="ml-2 text-xs" style={{ backgroundColor: "#fef3c7", color: "#92400e" }}>⭐ First order</Badge>}
        </div>
        {agent.email && (
          <div>
            <a href={`mailto:${agent.email}`} className="hover:underline" style={{ color: "#60a5fa" }}>{agent.email}</a>
          </div>
        )}
        {agent.phone && <div style={{ color: "#9ca3af" }}>{agent.phone}</div>}
        {Array.isArray(parsed?.contacts) && parsed.contacts.length > 0 && (
          <div style={{ color: "#9ca3af" }} className="mt-1">CC'd: {parsed.contacts.join(", ")}</div>
        )}
      </div>

      {/* The property */}
      <div>
        <h3 className="font-semibold mb-2 text-white">The property</h3>
        <div style={{ color: "#cbd5e1" }}>{parsed.address}</div>
        {(rooms.bedrooms > 0 || rooms.bathrooms > 0 || rooms.halfBaths > 0) && (
          <div style={{ color: "#9ca3af" }}>
            {rooms.bedrooms > 0 && `Bedrooms: ${rooms.bedrooms}`}
            {rooms.bedrooms > 0 && rooms.bathrooms > 0 && " · "}
            {rooms.bathrooms > 0 && `Bathrooms: ${rooms.bathrooms}`}
            {(rooms.bedrooms > 0 || rooms.bathrooms > 0) && rooms.halfBaths > 0 && " · "}
            {rooms.halfBaths > 0 && `Half baths: ${rooms.halfBaths}`}
          </div>
        )}
        {parsed.videoProject === true && <div style={{ color: "#cbd5e1" }}>📹 Video project</div>}
        {parsed.videoProject === false && <div style={{ color: "#cbd5e1" }}>📷 Stills project</div>}
      </div>

      {/* What was booked */}
      <div>
        <h3 className="font-semibold mb-2 text-white">What was booked</h3>
        {parsed.package && (
          <div className="font-bold mb-1 text-white">{parsed.package}</div>
        )}
        {Array.isArray(parsed?.tiers) && parsed.tiers.map((t, i) => (
          <div key={i} style={{ color: "#cbd5e1" }}>• {t.name} — {t.selected || "No tier"}{t.hrs > 0 ? ` — ${t.hrs} hrs` : ""}</div>
        ))}
        {Array.isArray(parsed?.services) && parsed.services.filter(s => !Array.isArray(parsed?.tiers) || !parsed.tiers.find(t => t.name === s)).map((s, i) => (
          <div key={i} style={{ color: "#cbd5e1" }}>• {s}</div>
        ))}
        <div className="mt-2 font-medium text-white">
          Total: {totalHrs} hrs on-site{parsed.invoiceAmount ? ` · Invoice: $${parsed.invoiceAmount}` : ""}
        </div>
        {coupon && <div style={{ color: "#9ca3af" }}>Coupon applied: {coupon}</div>}
        {parsed.bookingFlow && <div style={{ color: "#9ca3af" }}>Booking flow: {parsed.bookingFlow}</div>}
      </div>

      {/* Appointments */}
      <div>
        <h3 className="font-semibold mb-2 text-white">Appointment(s)</h3>
        {topWhen ? (
          <div>
            {orderWhen && <div className="text-xs mb-1" style={{ color: "#9ca3af" }}>This photographer's appointment:</div>}
            <div style={{ color: "#cbd5e1" }}>
              {new Date(topWhen.start).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", weekday: "long", month: "short", day: "numeric" })}
              {" at "}
              {new Date(topWhen.start).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit" })}
              {" – "}
              {new Date(topWhen.end).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit" })}
              {" "}({parsed.durationMinutes} min)
            </div>
            {orderWhen && (
              <div className="mt-2">
                <div className="text-xs mb-1" style={{ color: "#9ca3af" }}>Order window:</div>
                <div style={{ color: "#cbd5e1" }}>
                  {new Date(orderWhen.start).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", weekday: "long", month: "short", day: "numeric" })}
                  {" at "}
                  {new Date(orderWhen.start).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit" })}
                  {" – "}
                  {new Date(orderWhen.end).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: "#9ca3af" }}>No appointment scheduled</div>
        )}
        <div className="mt-2" style={{ color: "#cbd5e1" }}>
          Photographer: {parsed.photographer ? `${parsed.photographer.name} (${parsed.photographer.email})` : "Unassigned"}
        </div>
        {travels.length > 0 && (
          <div className="mt-2" style={{ color: "#cbd5e1" }}>
            {travels.map((t, i) => (
              <div key={i}>• {t.photographerId} — travel fee: ${t.travelFee}</div>
            ))}
          </div>
        )}
        {members.length > 0 && !members.includes("none") && (
          <div style={{ color: "#9ca3af" }}>
            Team members assigned: {members.filter(m => m !== "none").length}
          </div>
        )}
      </div>

      {/* Delivery */}
      <div>
        <h3 className="font-semibold mb-2 text-white">Delivery</h3>
        {parsed.deliveredAt ? (
          <div style={{ color: "#6ee7b7" }}>✅ Delivered {toSydney(parsed.deliveredAt)}</div>
        ) : null}
        {Array.isArray(parsed?.deliveredFiles) && parsed.deliveredFiles.length > 0 && (
          <div className="space-y-1 mt-1" style={{ color: "#cbd5e1" }}>
            {parsed.deliveredFiles.map((f, i) => (
              <div key={i}>
                • {f?.name} ({f?.type}) — <a href={f?.url} target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: "#60a5fa" }}>Download ↗</a>
              </div>
            ))}
          </div>
        )}
        {deliverableLink && (
          <div>
            <a href={deliverableLink} target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: "#60a5fa" }}>
              📁 Dropbox folder ↗
            </a>
          </div>
        )}
        {deliverablePath && (
          <div className="text-xs font-mono mt-1" style={{ color: "#71717a" }}>{deliverablePath}</div>
        )}
        {!parsed.deliveredAt && (!Array.isArray(parsed?.deliveredFiles) || parsed.deliveredFiles.length === 0) && !deliverableLink && (
          <div style={{ color: "#9ca3af" }}>Not yet delivered</div>
        )}
      </div>

      {/* Order state */}
      <div>
        <h3 className="font-semibold mb-2 text-white">Order state</h3>
        <div style={{ color: "#cbd5e1" }}>
          Status: <span style={{ 
            color: parsed.orderStatus === 'inProgress' ? '#60a5fa' :
                   parsed.orderStatus === 'cancelled' ? '#f87171' :
                   parsed.orderStatus === 'complete' ? '#6ee7b7' : '#9ca3af'
          }}>{parsed.orderStatus || "—"}</span>
          {" · "}
          Payment: <span style={{ 
            color: parsed.paymentStatus === 'unpaid' ? '#fbbf24' :
                   parsed.paymentStatus === 'paid' ? '#6ee7b7' : '#9ca3af'
          }}>{parsed.paymentStatus || "—"}</span>
        </div>
        {parsed.isFullyCancelled && (
          <div style={{ color: "#f87171" }} className="mt-1">🚫 This order is fully cancelled — all appointments and assignments removed</div>
        )}
        {parsed.isOrderCancelled && !parsed.isFullyCancelled && (
          <div style={{ color: "#fbbf24" }} className="mt-1">⚠️ This order has been cancelled</div>
        )}
        <div style={{ color: "#9ca3af" }} className="mt-1">
          {orderNo && `Order #: ${orderNo}`}
          {orderNo && invoiceNo && " · "}
          {invoiceNo && `Invoice #: ${invoiceNo}`}
        </div>
      </div>
    </div>
  );
}

function Dashboard({ parsedRecords, today, thisWeek, stats }) {
  const sydneyToday = new Date().toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" });
  
  // KPI calculations
  const shootsToday = parsedRecords.filter(p => {
    const isTodayEvent = p.receivedDate?.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" }) === sydneyToday;
    const isAppointment = ["scheduled", "rescheduled"].includes(p.parsed.action);
    const appointmentToday = p.parsed.startTime && 
      new Date(p.parsed.startTime).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" }) === sydneyToday;
    return isTodayEvent && isAppointment && appointmentToday;
  }).length;

  const newBookingsToday = new Set(
    today.filter(p => 
      p.parsed.action === "booking_created_or_changed" && 
      !p.parsed.isOrderCancelled
    ).map(p => p.parsed.orderId)
  ).size;

  const cancellationsToday = new Set(
    today.filter(p => p.parsed.isOrderCancelled).map(p => p.parsed.orderId)
  ).size;

  const deliveredToday = today.filter(p => p.parsed.action === "booking_completed").length;

  const revenueInMotion = Object.values(
    today.reduce((acc, p) => {
      if (p.parsed.invoiceAmount) {
        acc[p.parsed.orderId] = p.parsed.invoiceAmount;
      }
      return acc;
    }, {})
  ).reduce((sum, amt) => sum + amt, 0);

  // Today's appointments
  const appointments = parsedRecords.filter(p => {
    const isAppointment = ["scheduled", "rescheduled", "changed", "canceled"].includes(p.parsed.action);
    const appointmentToday = p.parsed.startTime && 
      new Date(p.parsed.startTime).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" }) === sydneyToday;
    return isAppointment && appointmentToday;
  });

  const uniqueAppts = Object.values(
    appointments.reduce((acc, p) => {
      const key = `${p.parsed.orderId}_${p.parsed.startTime}`;
      if (!acc[key] || p.receivedDate > acc[key].receivedDate) {
        acc[key] = p;
      }
      return acc;
    }, {})
  ).sort((a, b) => a.parsed.startTime - b.parsed.startTime);

  // Photographer workload
  const photographerWork = appointments.reduce((acc, p) => {
    const name = p?.parsed?.photographer?.name || "Unassigned";
    if (!acc[name]) acc[name] = { shoots: new Set(), services: new Set() };
    if (p?.parsed?.orderId) acc[name].shoots.add(p.parsed.orderId);
    if (Array.isArray(p?.parsed?.services)) {
      p.parsed.services.forEach(s => acc[name].services.add(s));
    }
    return acc;
  }, {});

  const photographerList = Object.entries(photographerWork)
    .map(([name, data]) => ({ name, shoots: data.shoots.size, services: Array.from(data.services) }))
    .sort((a, b) => {
      if (a.name === "Unassigned") return 1;
      if (b.name === "Unassigned") return -1;
      return b.shoots - a.shoots;
    });

  const maxShoots = Math.max(...photographerList.map(p => p.shoots), 1);

  // Week activity
  const sydneyNow = new Date(new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" }));
  const dayOfWeek = sydneyNow.getDay();
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const mondayStart = new Date(sydneyNow);
  mondayStart.setDate(sydneyNow.getDate() - diff);
  mondayStart.setHours(0, 0, 0, 0);

  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mondayStart);
    d.setDate(mondayStart.getDate() + i);
    return d.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" });
  });

  const weekActivity = weekDays.map(day => {
    const dayRecords = parsedRecords.filter(p => 
      p.receivedDate?.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" }) === day
    );
    const appointments = dayRecords.filter(p => ["scheduled", "rescheduled", "canceled"].includes(p.parsed.action)).length;
    const updates = dayRecords.filter(p => ["booking_created_or_changed", "booking_completed"].includes(p.parsed.action)).length;
    return { day, appointments, updates, total: appointments + updates };
  });

  const maxActivity = Math.max(...weekActivity.map(d => d.total), 1);

  // Significant events
  const significantEvents = parsedRecords.filter(p => {
    if (["scheduled", "rescheduled", "canceled", "booking_completed", "new_customer"].includes(p?.parsed?.action)) return true;
    if (p?.parsed?.action === "booking_created_or_changed" && (p.parsed.isOrderCancelled || (Array.isArray(p.parsed?.deliveredFiles) && p.parsed.deliveredFiles.length > 0))) return true;
    return false;
  }).slice(0, 20);

  // Cancellations
  const cancelledOrders = today.filter(p => p.parsed.isOrderCancelled)
    .reduce((acc, p) => {
      if (!acc[p.parsed.orderId] || p.receivedDate > acc[p.parsed.orderId].receivedDate) {
        acc[p.parsed.orderId] = p;
      }
      return acc;
    }, {});

  // Delivered
  const deliveredOrders = today.filter(p => p.parsed.action === "booking_completed");

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-6 gap-4">
        <KPICard 
          title="Shoots Today" 
          value={shootsToday} 
          subtitle="appointments on the calendar"
          borderColor={shootsToday > 0 ? "#22c55e" : "#ef4444"}
        />
        <KPICard title="New Bookings Today" value={newBookingsToday} subtitle="orders created or updated" />
        <KPICard 
          title="Cancellations Today" 
          value={cancellationsToday} 
          subtitle="orders cancelled"
          borderColor={cancellationsToday > 0 ? "#ef4444" : undefined}
          valueColor={cancellationsToday > 0 ? "#f87171" : undefined}
        />
        <KPICard 
          title="Delivered Today" 
          value={deliveredToday} 
          subtitle="orders delivered"
          valueColor="#10b981"
        />
        <KPICard 
          title="Revenue in Motion" 
          value={`$${revenueInMotion.toLocaleString()}`} 
          subtitle="invoice value active today"
        />
        <KPICard 
          title="Signal Coverage" 
          value={`${stats.coverage}%`} 
          subtitle="webhook data quality"
          borderColor={stats.coverage >= 90 ? "#22c55e" : stats.coverage >= 50 ? "#fbbf24" : "#ef4444"}
        />
      </div>

      {/* Today's Schedule */}
      <div>
        <h2 className="text-lg font-bold text-white mb-3">Today's Shoot Schedule</h2>
        {uniqueAppts.length === 0 ? (
          <div className="text-center py-8" style={{ color: "#9ca3af" }}>No shoots scheduled for today</div>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {uniqueAppts.map((p, i) => (
              <AppointmentCard key={i} item={p} />
            ))}
          </div>
        )}
      </div>

      {/* Two columns */}
      <div className="grid grid-cols-[60%_40%] gap-6">
        {/* Recent movements */}
        <div>
          <h2 className="text-lg font-bold text-white mb-3">Order Movements</h2>
          <div className="space-y-1">
            {significantEvents.map(p => (
              <div key={p.record.id} className="flex items-center gap-3 py-2 px-3 rounded hover:bg-[#1a1d27] cursor-pointer transition-colors">
                <div className="h-2 w-2 rounded-full flex-shrink-0" style={{ backgroundColor: ACTION_COLORS[p.parsed.action] }} />
                <div className="text-xs flex-shrink-0" style={{ color: "#9ca3af", width: "60px" }}>{relativeTime(p.receivedDate)}</div>
                <div className="flex-1 text-xs text-white truncate">{p.parsed.summary}</div>
                <div className="text-xs flex-shrink-0 truncate" style={{ color: "#71717a", width: "120px" }}>{p?.parsed?.address?.slice(0, 20) || "—"}</div>
                <div className="text-xs flex-shrink-0" style={{ color: "#71717a", width: "100px" }}>{p.parsed.photographer?.name || "—"}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Photographer workload */}
        <div>
          <h2 className="text-lg font-bold text-white mb-3">Today's Photographer Workload</h2>
          <div className="space-y-3">
            {photographerList.map((p, i) => (
              <div key={i}>
                <div className="font-bold text-white text-sm" style={p.name === "Unassigned" ? { color: "#9ca3af" } : {}}>{p.name}</div>
                <div className="text-xs" style={{ color: "#9ca3af" }}>
                  {p.shoots} shoot{p.shoots !== 1 ? "s" : ""}
                </div>
                <div className="text-xs mb-1" style={{ color: "#71717a" }}>{Array.isArray(p?.services) ? p.services.join(", ") : "No services"}</div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: "#2a2d3a" }}>
                  <div 
                    className="h-full rounded-full transition-all"
                    style={{ 
                      width: `${(p.shoots / maxShoots) * 100}%`,
                      backgroundColor: "#3b82f6"
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Week chart */}
      <div>
        <h2 className="text-lg font-bold text-white mb-3">This Week's Activity</h2>
        <div className="flex items-end justify-around gap-2 h-24">
          {weekActivity.map((d, i) => {
            const isToday = d.day === sydneyToday;
            const dayLabel = new Date(d.day).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", weekday: "short" });
            return (
              <div key={i} className="flex flex-col items-center gap-1 flex-1">
                <div className="text-xs text-white">{d.total}</div>
                <div 
                  className="w-full rounded transition-all cursor-pointer hover:opacity-80"
                  style={{ 
                    height: `${(d.total / maxActivity) * 80}px`,
                    backgroundColor: isToday ? "#3b82f6" : "#2a2d3a",
                    minHeight: d.total > 0 ? "4px" : "0"
                  }}
                  title={`${dayLabel}: ${d.appointments} appointments, ${d.updates} updates`}
                />
                <div className="text-xs" style={{ color: "#9ca3af" }}>{dayLabel}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Cancellations and Deliveries */}
      <div className="grid grid-cols-2 gap-6">
        <div 
          className="rounded-lg border p-4"
          style={{ backgroundColor: "#1a1d27", borderColor: "#2a2d3a" }}
        >
          <h2 className="text-lg font-bold text-white mb-3">Cancellation Breakdown (Today)</h2>
          {Object.keys(cancelledOrders).length === 0 ? (
            <div className="text-green-600">✅ No cancellations today</div>
          ) : (
            <div className="space-y-2">
              {Object.values(cancelledOrders).map(p => (
                <div key={p.record.id} className="text-sm">
                  <div className="text-white truncate">{p.parsed.orderName.slice(0, 40)}</div>
                  <div style={{ color: "#9ca3af" }}>{p.parsed.agent?.name || "Unknown agent"}</div>
                  <div className="flex items-center gap-2">
                    {p.parsed.invoiceAmount && <span className="text-white">${p.parsed.invoiceAmount}</span>}
                    <span style={{ color: "#71717a" }}>{relativeTime(p.receivedDate)}</span>
                    {p.parsed.isFullyCancelled && (
                      <Badge className="text-xs" style={{ backgroundColor: "#ef4444", color: "white" }}>Fully cancelled</Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div 
          className="rounded-lg border p-4"
          style={{ backgroundColor: "#1a1d27", borderColor: "#2a2d3a" }}
        >
          <h2 className="text-lg font-bold text-white mb-3">Delivered Today</h2>
          {deliveredOrders.length === 0 ? (
            <div style={{ color: "#9ca3af" }}>No deliveries today</div>
          ) : (
            <div className="space-y-2">
              {deliveredOrders.map(p => (
                <div key={p.record.id} className="text-sm">
                  <div className="text-white truncate">{p.parsed.orderName.slice(0, 40)}</div>
                  <div style={{ color: "#9ca3af" }}>{p.parsed.agent?.name || "Unknown agent"}</div>
                  <div className="flex items-center gap-2">
                    {p.parsed.invoiceAmount && <span className="text-green-600">${p.parsed.invoiceAmount}</span>}
                    <span style={{ color: "#71717a" }}>{Array.isArray(p?.parsed?.deliveredFiles) ? p.parsed.deliveredFiles.length : 0} files delivered</span>
                    <span style={{ color: "#71717a" }}>{relativeTime(p.receivedDate)}</span>
                    {p.parsed.raw?.deliverable_link && (
                      <a href={p.parsed.raw.deliverable_link} target="_blank" rel="noopener noreferrer" className="text-xs" style={{ color: "#60a5fa" }}>
                        ↗ View files
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KPICard({ title, value, subtitle, borderColor, valueColor }) {
  return (
    <div 
      className="rounded-lg border p-4"
      style={{ 
        backgroundColor: "#1a1d27", 
        borderColor: "#2a2d3a",
        borderLeftWidth: borderColor ? "3px" : "1px",
        borderLeftColor: borderColor || "#2a2d3a"
      }}
    >
      <div className="text-xs mb-1" style={{ color: "#9ca3af" }}>{title}</div>
      <div className="text-2xl font-bold mb-1" style={{ color: valueColor || "white" }}>{value}</div>
      <div className="text-xs" style={{ color: "#71717a" }}>{subtitle}</div>
    </div>
  );
}

function AppointmentCard({ item }) {
  const { parsed, receivedDate } = item;
  const start = new Date(parsed.startTime).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit" });
  const end = new Date(parsed.endTime).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit" });
  const isCancelled = parsed.isOrderCancelled;

  return (
    <div 
      className="rounded-lg border p-3 flex-shrink-0"
      style={{ 
        minWidth: "220px",
        backgroundColor: isCancelled ? "#1f1515" : "#1a1d27",
        borderColor: "#2a2d3a"
      }}
    >
      <div className="font-bold text-white mb-1" style={isCancelled ? { textDecoration: "line-through" } : {}}>
        {start} – {end}
      </div>
      <div className="text-xs truncate mb-1" style={{ color: "#9ca3af" }}>{parsed?.address?.slice(0, 35) || "No address"}</div>
      <div className="text-xs mb-1">
        <Badge variant="secondary" className="text-xs">{parsed?.photographer?.name || "Unassigned"}</Badge>
      </div>
      <div className="text-xs mb-2" style={{ color: "#71717a" }}>{Array.isArray(parsed?.services) ? parsed.services.join(", ").slice(0, 40) : "No services"}</div>
      {parsed.package && <Badge variant="outline" className="text-xs mb-2">{parsed.package}</Badge>}
      <div className="flex items-center gap-1 text-xs">
        <div 
          className="h-2 w-2 rounded-full"
          style={{ 
            backgroundColor: isCancelled ? "#ef4444" : 
                           parsed.action === "rescheduled" ? "#fbbf24" : "#22c55e"
          }}
        />
        <span style={{ color: "#9ca3af" }}>
          {isCancelled ? "Cancelled" : parsed.action === "rescheduled" ? "Rescheduled" : "Scheduled"}
        </span>
      </div>
    </div>
  );
}

function GroupCard({ group, expanded, onToggle }) {
  const { latest, count, borderColor, hasCompleted, hasCancelled } = group;
  const { parsed, receivedDate } = latest;

  return (
    <div
      className="rounded-lg border cursor-pointer"
      style={{
        backgroundColor: "#1a1d27",
        borderColor: "#2a2d3a",
        borderLeftWidth: "3px",
        borderLeftColor: borderColor,
        marginBottom: "6px"
      }}
      onClick={onToggle}
    >
      <div className="px-3.5 py-3">
        <div className="flex items-center gap-3">
          {expanded ? <ChevronDown className="h-4 w-4" style={{ color: "#9ca3af" }} /> : <ChevronRight className="h-4 w-4" style={{ color: "#9ca3af" }} />}
          <div className="flex-1">
            <div className="font-bold text-white truncate" style={{ maxWidth: "300px" }}>{parsed.orderName}</div>
            <div className="text-xs" style={{ color: "#9ca3af" }}>{parsed.address}</div>
          </div>
          <div className="text-xs" style={{ color: "#9ca3af" }}>{parsed.agent?.name || "—"}</div>
          <Badge className="text-xs" style={{ backgroundColor: "#2a2d3a", color: "#9ca3af" }}>{count} events</Badge>
          <div className="text-xs" style={{ color: "#9ca3af" }}>{relativeTime(receivedDate)}</div>
          {parsed.invoiceAmount && <div className="text-sm text-white">${parsed.invoiceAmount}</div>}
          {parsed.videoProject === true && <Badge className="text-xs" style={{ backgroundColor: "#a855f7", color: "white" }}>🎬</Badge>}
          {parsed.videoProject === false && <Badge className="text-xs" style={{ backgroundColor: "#3b82f6", color: "white" }}>📷</Badge>}
          {hasCompleted && <Badge className="text-xs" style={{ backgroundColor: "#10b981", color: "white" }}>DELIVERED ✅</Badge>}
          {hasCancelled && !hasCompleted && <Badge className="text-xs" style={{ backgroundColor: "#ef4444", color: "white" }}>CANCELLED</Badge>}
        </div>
      </div>

      {expanded && (
        <div 
          className="border-t px-4 py-3 space-y-2"
          style={{ borderColor: "#2a2d3a" }}
          onClick={(e) => e.stopPropagation()}
        >
          {group.records.map(p => {
            const signals = [
              p.record.has_photographer,
              p.record.has_services,
              p.record.has_address,
              p.record.has_agent,
              p.record.has_appointment_time
            ];
            return (
              <div key={p.record.id} className="flex items-center gap-3 text-xs pl-2">
                <div className="h-2 w-2 rounded-full flex-shrink-0" style={{ backgroundColor: ACTION_COLORS[p.parsed.action] }} />
                <div 
                  className="px-2 py-0.5 rounded flex-shrink-0"
                  style={{ 
                    backgroundColor: `${ACTION_COLORS[p.parsed.action]}26`,
                    color: ACTION_COLORS[p.parsed.action]
                  }}
                >
                  {ACTION_LABELS[p.parsed.action]}
                </div>
                <div className="flex-1" style={{ color: "#cbd5e1" }}>{p.parsed.photographer?.name || "Unassigned"}</div>
                <div style={{ color: "#71717a" }}>{toSydney(p.receivedDate)}</div>
                <div className="flex gap-1 flex-shrink-0">
                  {signals.map((s, i) => (
                    <div 
                      key={i} 
                      className="h-2 w-2 rounded-full" 
                      style={{ backgroundColor: s === true ? "#22c55e" : s === false ? "#ef4444" : "#6b7280" }} 
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}