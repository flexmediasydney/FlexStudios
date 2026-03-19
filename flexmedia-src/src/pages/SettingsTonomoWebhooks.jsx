import { useState, useMemo, useEffect, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { RefreshCw, ChevronDown, ChevronRight, ExternalLink, Copy } from "lucide-react";
import { parsePayload, parseTS, toSydney, relativeTime, ACTION_COLORS, ACTION_LABELS } from "@/components/tonomo/tonomoUtils";
import { useCurrentUser } from "@/components/auth/PermissionGuard";

export default function SettingsTonomoWebhooks() {
  const { data: user } = useCurrentUser();
  const [expandedRow, setExpandedRow] = useState(null);
  const [activeTab, setActiveTab] = useState({});
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [limit, setLimit] = useState(50);

  useEffect(() => {
    if (user && user.role !== "master_admin" && user.role !== "employee") {
      window.location.href = "/";
    }
  }, [user]);

  const { data: logs = [], refetch } = useQuery({
    queryKey: ['tonomoLogs', limit],
    queryFn: async () => {
      const result = await base44.entities.TonomoWebhookLog.list('-received_at', limit);
      return result;
    },
    refetchInterval: 15000,
  });

  useEffect(() => {
    const interval = setInterval(() => {
      refetch();
      setLastRefresh(new Date());
    }, 15000);
    return () => clearInterval(interval);
  }, [refetch]);

  const parsed = useMemo(() => {
    return logs.map(log => ({
      ...log,
      parsed: parsePayload(log.raw_payload || "{}"),
      receivedDate: parseTS(log.received_at)
    }));
  }, [logs]);

  const today = useMemo(() => {
    const sydneyNow = new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
    const sydneyToday = new Date(sydneyNow).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" });
    return parsed.filter(l => {
      if (!l.receivedDate) return false;
      const logDate = l.receivedDate.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" });
      return logDate === sydneyToday;
    });
  }, [parsed]);

  const stats = useMemo(() => {
    const fullCoverage = today.filter(l =>
      l.has_photographer && l.has_services && l.has_address && l.has_agent && l.has_appointment_time
    ).length;
    const errors = parsed.filter(l => l.parse_error).length;
    const coverage = today.length > 0 ? Math.round((fullCoverage / today.length) * 100) : 0;
    
    let coverageBg = "#fee2e2";
    if (coverage >= 90) coverageBg = "#dcfce7";
    else if (coverage >= 50) coverageBg = "#fef9c3";
    
    return {
      total: parsed.length,
      today: today.length,
      coverage,
      coverageBg,
      errors
    };
  }, [parsed, today]);

  const eventBreakdown = useMemo(() => {
    const counts = {};
    today.forEach(l => {
      const action = l.parsed.action;
      counts[action] = (counts[action] || 0) + 1;
    });
    counts.errors = today.filter(l => l.parse_error).length;
    return counts;
  }, [today]);

  const signals = useMemo(() => {
    const calc = (field) => {
      const t = today.filter(l => l[field]).length;
      const f = today.length - t;
      return { true: t, false: f, percent: today.length > 0 ? Math.round((t / today.length) * 100) : 0 };
    };
    return {
      photographer: calc('has_photographer'),
      services: calc('has_services'),
      address: calc('has_address'),
      agent: calc('has_agent'),
      time: calc('has_appointment_time'),
    };
  }, [today]);

  const handleRefresh = () => {
    refetch();
    setLastRefresh(new Date());
  };

  const toggleRow = (id) => {
    setExpandedRow(expandedRow === id ? null : id);
    if (!activeTab[id]) {
      setActiveTab({ ...activeTab, [id]: "details" });
    }
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold">Tonomo Webhook Diagnostics</h1>
            <p className="text-muted-foreground mt-1">
              Health dashboard — coverage metrics, signal breakdown, log inspection
            </p>
          </div>
          <div className="text-right">
            <Button onClick={handleRefresh}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <p className="text-xs text-muted-foreground mt-2">
              Last refreshed: {relativeTime(lastRefresh)}
            </p>
          </div>
        </div>

        {/* Coverage Summary */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Events</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Today</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{stats.today}</div>
            </CardContent>
          </Card>
          <Card style={{ backgroundColor: stats.coverageBg }}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Coverage</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{stats.coverage}%</div>
              <p className="text-xs text-muted-foreground mt-1">Full signal coverage today</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Errors</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-red-600">{stats.errors}</div>
            </CardContent>
          </Card>
        </div>

        {/* Event Type Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle>Event Type Breakdown (Today)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {Object.entries(eventBreakdown).map(([action, count]) => {
                const color = ACTION_COLORS[action] || ACTION_COLORS.unknown;
                return (
                  <div
                    key={action}
                    className="px-3 py-1 rounded"
                    style={{ 
                      backgroundColor: `${color}33`, 
                      color: color,
                      fontWeight: 'bold'
                    }}
                  >
                    {ACTION_LABELS[action] || action} · {count}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Signal Health Grid */}
        <Card>
          <CardHeader>
            <CardTitle>Signal Health (Today)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
              {Object.entries(signals).map(([name, data]) => (
                <div key={name} className="space-y-2">
                  <div className="font-medium capitalize">{name}</div>
                  <div className="text-sm text-muted-foreground">
                    ✅ {data.true} · ❌ {data.false}
                  </div>
                  <Progress value={data.percent} className="[&>div]:bg-green-600" />
                  <div className="text-xs text-muted-foreground">{data.percent}%</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Recent Logs Table */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Logs ({parsed.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {parsed.length === 0 && (
              <div className="py-16 text-center text-muted-foreground">
                <p className="text-4xl mb-3">📭</p>
                <p className="font-medium">No webhook logs yet</p>
                <p className="text-sm mt-1">Logs will appear here when Tonomo sends webhooks</p>
              </div>
            )}
            <div className="space-y-1">
              {parsed.map(log => (
                <LogRow
                  key={log.id}
                  log={log}
                  expanded={expandedRow === log.id}
                  onToggle={() => toggleRow(log.id)}
                  activeTab={activeTab[log.id] || "details"}
                  onTabChange={(tab) => setActiveTab({ ...activeTab, [log.id]: tab })}
                />
              ))}
            </div>
            {parsed.length >= limit && (
              <Button
                variant="outline"
                className="w-full mt-4 hover:shadow-md transition-shadow"
                onClick={() => setLimit(limit + 50)}
                title="Load 50 more webhook logs"
              >
                Load 50 more
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function LogRow({ log, expanded, onToggle, activeTab, onTabChange }) {
  const { parsed, receivedDate } = log;
  const [copiedId, setCopiedId] = useState(null);
  const signals = [
    log.has_photographer,
    log.has_services,
    log.has_address,
    log.has_agent,
    log.has_appointment_time,
  ];

  const isDelivered = parsed.action === "booking_completed";

  return (
    <div className="border rounded-lg">
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-muted/50 transition-colors text-left"
      >
        {expanded ? <ChevronDown className="h-4 w-4 flex-shrink-0" /> : <ChevronRight className="h-4 w-4 flex-shrink-0" />}
        
        <div className="w-24 text-sm flex-shrink-0" title={toSydney(receivedDate)}>
          <div>{relativeTime(receivedDate)}</div>
          <div className="text-xs text-muted-foreground">{toSydney(receivedDate)}</div>
        </div>

        <Badge 
          style={{ backgroundColor: ACTION_COLORS[parsed.action], color: 'white' }}
          className="flex-shrink-0"
        >
          {ACTION_LABELS[parsed.action]}
        </Badge>

        <div className="flex-1 text-sm truncate min-w-0">{parsed.summary}</div>
        
        <div className="w-48 text-sm truncate text-muted-foreground flex-shrink-0">
          {parsed.address.slice(0, 45)}
        </div>
        
        <div className="w-32 text-sm text-muted-foreground flex-shrink-0">
          {parsed.photographer?.name || "—"}
        </div>

        <div className="flex gap-1 flex-shrink-0">
          {isDelivered ? (
            <span className="text-xs text-green-600">✅ Delivered</span>
          ) : (
            <>
              <span title="📷 Photographer">
                <div className={`h-2 w-2 rounded-full ${signals[0] ? 'bg-green-500' : signals[0] === false ? 'bg-red-500' : 'bg-gray-400'}`} />
              </span>
              <span title="🛠 Services">
                <div className={`h-2 w-2 rounded-full ${signals[1] ? 'bg-green-500' : signals[1] === false ? 'bg-red-500' : 'bg-gray-400'}`} />
              </span>
              <span title="📍 Address">
                <div className={`h-2 w-2 rounded-full ${signals[2] ? 'bg-green-500' : signals[2] === false ? 'bg-red-500' : 'bg-gray-400'}`} />
              </span>
              <span title="👤 Agent">
                <div className={`h-2 w-2 rounded-full ${signals[3] ? 'bg-green-500' : signals[3] === false ? 'bg-red-500' : 'bg-gray-400'}`} />
              </span>
              <span title="🕐 Time">
                <div className={`h-2 w-2 rounded-full ${signals[4] ? 'bg-green-500' : signals[4] === false ? 'bg-red-500' : 'bg-gray-400'}`} />
              </span>
            </>
          )}
        </div>

        <div className="w-24 text-right flex-shrink-0">
          {log.parse_error ? (
            <span className="text-xs text-red-600" title={log.parse_error} aria-label={`Parse error: ${log.parse_error}`}>
              ⚠ Parse error
            </span>
          ) : (
            <span className="text-xs text-green-600">✓ OK</span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t px-4 py-3">
          <Tabs value={activeTab} onValueChange={onTabChange}>
            <TabsList>
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="brief">Order Brief</TabsTrigger>
              <TabsTrigger value="payload">Payload</TabsTrigger>
            </TabsList>

            <TabsContent value="brief" className="mt-3">
              <OrderBrief parsed={parsed} record={log} />
            </TabsContent>

            <TabsContent value="details" className="mt-3">
              <div className="grid grid-cols-[200px_1fr] gap-x-6 gap-y-2 text-sm">
                <DetailRow label="Action">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 rounded-full" style={{ backgroundColor: ACTION_COLORS[parsed.action] }} />
                    {ACTION_LABELS[parsed.action]}
                  </div>
                </DetailRow>
                <DetailRow label="Order ID">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-xs">{parsed.orderId}</code>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(parsed.orderId);
                        setCopiedId(parsed.orderId);
                        setTimeout(() => setCopiedId(null), 2000);
                      }}
                      className="hover:text-primary transition-colors"
                      title="Copy to clipboard"
                      aria-label="Copy order ID"
                    >
                      {copiedId === parsed.orderId
                        ? <span className="text-green-600 text-xs">✓</span>
                        : <Copy className="h-3 w-3" />
                      }
                    </button>
                  </div>
                </DetailRow>
                <DetailRow label="Order Name" value={parsed.orderName} />
                <DetailRow label="Photographer" value={parsed.photographer ? `${parsed.photographer.name} (${parsed.photographer.email})` : "Unassigned"} />
                <DetailRow label="Agent" value={parsed.agent ? `${parsed.agent.name} (${parsed.agent.email})` : "None"} />
                <DetailRow label="Address" value={parsed.address} />
                <DetailRow label="Booking Flow" value={parsed.bookingFlow || "—"} />
                <DetailRow label="Shoot Start" value={parsed.startTime ? toSydney(new Date(parsed.startTime)) : "Not scheduled"} />
                <DetailRow label="Duration" value={parsed.durationMinutes ? `${parsed.durationMinutes} min` : "—"} />
                <DetailRow label="Services" value={parsed.services.join(", ") || "None"} />
                <DetailRow label="Service Tiers">
                  {parsed.tiers.length > 0 ? (
                    <div className="space-y-1">
                      {parsed.tiers.map((t, i) => (
                        <div key={i}>{t.name} → {t.selected || "None"}</div>
                      ))}
                    </div>
                  ) : "None"}
                </DetailRow>
                <DetailRow label="Package" value={parsed.package || "—"} />
                <DetailRow label="Invoice Amount" value={parsed.invoiceAmount ? `$${parsed.invoiceAmount}` : "—"} />
                <DetailRow label="Invoice Link">
                  {parsed.invoiceLink ? (
                    <a href={parsed.invoiceLink} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1">
                      View invoice <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : "—"}
                </DetailRow>
                <DetailRow label="Order Status">
                  <span style={{ 
                    color: parsed.orderStatus === 'inProgress' ? '#60a5fa' :
                           parsed.orderStatus === 'cancelled' ? '#f87171' :
                           parsed.orderStatus === 'complete' ? '#6ee7b7' : '#9ca3af'
                  }}>
                    {parsed.orderStatus || "—"}
                  </span>
                </DetailRow>
                <DetailRow label="Payment Status">
                  <span style={{ 
                    color: parsed.paymentStatus === 'unpaid' ? '#fbbf24' :
                           parsed.paymentStatus === 'paid' ? '#6ee7b7' : '#9ca3af'
                  }}>
                    {parsed.paymentStatus || "—"}
                  </span>
                </DetailRow>
                <DetailRow label="Video Project" value={parsed.videoProject === true ? "Yes" : parsed.videoProject === false ? "No" : "Unknown"} />
                <DetailRow label="Cancellation">
                  <span style={{ 
                    color: parsed.isFullyCancelled ? '#f87171' : parsed.isOrderCancelled ? '#fbbf24' : '#9ca3af'
                  }}>
                    {parsed.isFullyCancelled ? "Fully cancelled" : parsed.isOrderCancelled ? "Order cancelled" : "—"}
                  </span>
                </DetailRow>
                <DetailRow label="Delivered At" value={parsed.deliveredAt ? toSydney(parsed.deliveredAt) : "—"} />
                <DetailRow label="Delivered Files">
                  {parsed.deliveredFiles.length > 0 ? (
                    <div className="space-y-1">
                      {parsed.deliveredFiles.map((file, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="font-bold">{file.name}</span>
                          <Badge variant="outline">{file.type}</Badge>
                          <a href={file.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1 text-xs">
                            Download <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      ))}
                    </div>
                  ) : "—"}
                </DetailRow>
                <DetailRow label="CC Contacts" value={parsed.contacts.join(", ") || "—"} />
                <DetailRow label="Source IP" value={log.source_ip || "—"} />
              </div>
            </TabsContent>

            <TabsContent value="payload" className="mt-3">
              <pre className="bg-[#0f1117] text-[#f8f8f2] p-3 rounded-md overflow-auto max-h-96 text-xs font-mono">
                {log.raw_payload}
              </pre>
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, children }) {
  return (
    <>
      <div className="text-muted-foreground text-right">{label}</div>
      <div>{children || value}</div>
    </>
  );
}

function OrderBrief({ parsed, record }) {
  const { raw } = parsed;
  if (!raw) return <div className="text-muted-foreground">No data available</div>;

  const agent = parsed.agent || {};
  const brokerage = raw.order?.brokerage || raw.brokerage || null;
  const rooms = raw.order?.rooms || raw.rooms || {};
  const totalHrs = parsed.tiers.reduce((sum, t) => sum + (t.hrs || 0), 0);
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
        <h3 className="font-semibold mb-2">Who booked</h3>
        <div>
          {agent.name || "Unknown agent"}
          {brokerage && ` from ${brokerage}`}
          {isFirstOrder && <Badge className="ml-2 text-xs bg-amber-100 text-amber-800">⭐ First order</Badge>}
        </div>
        {agent.email && (
          <div>
            <a href={`mailto:${agent.email}`} className="text-blue-600 hover:underline">{agent.email}</a>
          </div>
        )}
        {agent.phone && <div className="text-muted-foreground">{agent.phone}</div>}
        {parsed.contacts.length > 0 && (
          <div className="text-muted-foreground mt-1">CC'd: {parsed.contacts.join(", ")}</div>
        )}
      </div>

      {/* The property */}
      <div>
        <h3 className="font-semibold mb-2">The property</h3>
        <div>{parsed.address}</div>
        {(rooms.bedrooms > 0 || rooms.bathrooms > 0 || rooms.halfBaths > 0) && (
          <div className="text-muted-foreground">
            {rooms.bedrooms > 0 && `Bedrooms: ${rooms.bedrooms}`}
            {rooms.bedrooms > 0 && rooms.bathrooms > 0 && " · "}
            {rooms.bathrooms > 0 && `Bathrooms: ${rooms.bathrooms}`}
            {(rooms.bedrooms > 0 || rooms.bathrooms > 0) && rooms.halfBaths > 0 && " · "}
            {rooms.halfBaths > 0 && `Half baths: ${rooms.halfBaths}`}
          </div>
        )}
        {parsed.videoProject === true && <div>📹 Video project</div>}
        {parsed.videoProject === false && <div>📷 Stills project</div>}
      </div>

      {/* What was booked */}
      <div>
        <h3 className="font-semibold mb-2">What was booked</h3>
        {parsed.package && (
          <div className="font-bold mb-1">{parsed.package}</div>
        )}
        {parsed.tiers.map((t, i) => (
          <div key={i}>• {t.name} — {t.selected || "No tier"}{t.hrs > 0 ? ` — ${t.hrs} hrs` : ""}</div>
        ))}
        {parsed.services.filter(s => !parsed.tiers.find(t => t.name === s)).map((s, i) => (
          <div key={i}>• {s}</div>
        ))}
        <div className="mt-2 font-medium">
          Total: {totalHrs} hrs on-site{parsed.invoiceAmount ? ` · Invoice: $${parsed.invoiceAmount}` : ""}
        </div>
        {coupon && <div className="text-muted-foreground">Coupon applied: {coupon}</div>}
        {parsed.bookingFlow && <div className="text-muted-foreground">Booking flow: {parsed.bookingFlow}</div>}
      </div>

      {/* Appointments */}
      <div>
        <h3 className="font-semibold mb-2">Appointment(s)</h3>
        {topWhen ? (
          <div>
            {orderWhen && <div className="text-xs text-muted-foreground mb-1">This photographer's appointment:</div>}
            <div>
              {new Date(topWhen.start).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", weekday: "long", month: "short", day: "numeric" })}
              {" at "}
              {new Date(topWhen.start).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit" })}
              {" – "}
              {new Date(topWhen.end).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit" })}
              {" "}({parsed.durationMinutes} min)
            </div>
            {orderWhen && (
              <div className="mt-2">
                <div className="text-xs text-muted-foreground mb-1">Order window:</div>
                <div>
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
          <div className="text-muted-foreground">No appointment scheduled</div>
        )}
        <div className="mt-2">
          Photographer: {parsed.photographer ? `${parsed.photographer.name} (${parsed.photographer.email})` : "Unassigned"}
        </div>
        {travels.length > 0 && (
          <div className="mt-2">
            {travels.map((t, i) => (
              <div key={i}>• {t.photographerId} — travel fee: ${t.travelFee}</div>
            ))}
          </div>
        )}
        {members.length > 0 && !members.includes("none") && (
          <div className="text-muted-foreground">
            Team members assigned: {members.filter(m => m !== "none").length}
          </div>
        )}
      </div>

      {/* Delivery */}
      <div>
        <h3 className="font-semibold mb-2">Delivery</h3>
        {parsed.deliveredAt ? (
          <div className="text-green-600">✅ Delivered {toSydney(parsed.deliveredAt)}</div>
        ) : null}
        {parsed.deliveredFiles.length > 0 && (
          <div className="space-y-1 mt-1">
            {parsed.deliveredFiles.map((f, i) => (
              <div key={i}>
                • {f.name} ({f.type}) — <a href={f.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Download ↗</a>
              </div>
            ))}
          </div>
        )}
        {deliverableLink && (
          <div>
            <a href={deliverableLink} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              📁 Dropbox folder ↗
            </a>
          </div>
        )}
        {deliverablePath && (
          <div className="text-xs text-muted-foreground font-mono mt-1">{deliverablePath}</div>
        )}
        {!parsed.deliveredAt && parsed.deliveredFiles.length === 0 && !deliverableLink && (
          <div className="text-muted-foreground">Not yet delivered</div>
        )}
      </div>

      {/* Order state */}
      <div>
        <h3 className="font-semibold mb-2">Order state</h3>
        <div>
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
          <div className="text-red-600 mt-1">🚫 This order is fully cancelled — all appointments and assignments removed</div>
        )}
        {parsed.isOrderCancelled && !parsed.isFullyCancelled && (
          <div className="text-amber-600 mt-1">⚠️ This order has been cancelled</div>
        )}
        <div className="text-muted-foreground mt-1">
          {orderNo && `Order #: ${orderNo}`}
          {orderNo && invoiceNo && " · "}
          {invoiceNo && `Invoice #: ${invoiceNo}`}
        </div>
      </div>
    </div>
  );
}