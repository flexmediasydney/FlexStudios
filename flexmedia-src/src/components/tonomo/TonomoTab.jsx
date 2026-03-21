import { useState, useMemo, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, ExternalLink, Zap, AlertCircle, XCircle, Clock, ArrowRight } from "lucide-react";
import { toSydney, parseTS, relativeTime, ACTION_COLORS } from "@/components/tonomo/tonomoUtils";
import { useEntityList } from "@/components/hooks/useEntityData";
import { validateProjectReadiness } from "@/components/lib/validateProjectReadiness";

export default function TonomoTab({ project }) {
  const [subTab, setSubTab] = useState(project.status === 'pending_review' ? 'review' : 'brief');
  const queryClient = useQueryClient();

  const { data: allProducts = [] } = useEntityList("Product");
  const { data: allPackages = [] } = useEntityList("Package");
  const [approvalErrors, setApprovalErrors] = useState([]);
  const [approvalWarnings, setApprovalWarnings] = useState([]);

  // Sync subTab when project.status changes from outside (e.g. approved via Dashboard).
  // If the Review Panel tab is active but project is no longer pending_review,
  // the TabsTrigger is removed from the DOM — Radix renders a blank tab area.
  // Switching to 'brief' prevents that.
  useEffect(() => {
    if (project.status !== 'pending_review' && subTab === 'review') {
      setSubTab('brief');
    }
  }, [project.status]);

  const { data: auditLogs = [] } = useQuery({
    queryKey: ['tonomoAudit', project.tonomo_order_id],
    queryFn: async () => {
      if (!project.tonomo_order_id) return [];
      const all = await api.entities.TonomoAuditLog.list('-processed_at', 100);
      return all.filter(log => log.tonomo_order_id === project.tonomo_order_id);
    },
    enabled: !!project.tonomo_order_id
  });

  const { data: rawPayload } = useQuery({
    queryKey: ['tonomoRawPayload', project.tonomo_order_id],
    queryFn: async () => {
      if (!project.tonomo_order_id) return null;
      const logs = await api.entities.TonomoWebhookLog.list('-received_at', 200);
      const match = logs.find(log => {
        try {
          const p = JSON.parse(log.raw_payload || '{}');
          return p.orderId === project.tonomo_order_id || p.order?.orderId === project.tonomo_order_id;
        } catch { return false; }
      });
      return match?.raw_payload || null;
    },
    enabled: !!project.tonomo_order_id
  });

  // Booking timeline: recent queue items for this order
  const { data: bookingTimeline = [] } = useQuery({
    queryKey: ['tonomoBookingTimeline', project.tonomo_order_id],
    queryFn: async () => {
      if (!project.tonomo_order_id) return [];
      const allQueue = await api.entities.TonomoProcessingQueue.list('-created_date', 200);
      return allQueue
        .filter(q => q.order_id === project.tonomo_order_id)
        .sort((a, b) => {
          const da = parseTS(a.created_at);
          const db = parseTS(b.created_at);
          return (db?.getTime() || 0) - (da?.getTime() || 0);
        });
    },
    enabled: !!project.tonomo_order_id,
    refetchInterval: 15000,
  });

  const handleApprove = async () => {
    const reviewType = project.pending_review_type || 'new_booking';

    // Validate readiness before approving (skip for cancellations)
    if (reviewType !== 'cancellation') {
      const { valid, errors, warnings } = validateProjectReadiness(
        project, allProducts, allPackages
      );
      setApprovalWarnings(warnings);
      if (!valid) {
        setApprovalErrors(errors);
        return; // Block approval
      }
      setApprovalErrors([]);
    }

    let newStatus;
    switch (reviewType) {
      case 'cancellation':
        // Confirming a cancellation → move to cancelled
        newStatus = 'cancelled';
        break;
      case 'restoration':
      case 'reopened_after_delivery':
        // Approving a restored/reopened booking → re-enter workflow
        newStatus = project.shoot_date ? 'scheduled' : 'to_be_scheduled';
        break;
      case 'additional_appointment':
        // New appointment added → return to previous active stage
        newStatus = project.pre_revision_stage || (project.shoot_date ? 'scheduled' : 'to_be_scheduled');
        break;
      default:
        // new_booking, rescheduled, service_change, staff_change
        newStatus = project.shoot_date ? 'scheduled' : 'to_be_scheduled';
    }

    await api.entities.Project.update(project.id, {
      status: newStatus,
      pending_review_reason: null,
      pending_review_type: null,
      urgent_review: false,
      auto_approved: false,
    });

    // Apply role defaults and trigger task generation.
    // This runs AFTER the status update so tasks are created for an active project.
    // Fire-and-forget — don't block the UI on this.
    if (newStatus !== 'cancelled') {
      api.functions.invoke('applyProjectRoleDefaults', {
        project_id: project.id,
      }).catch(err => {
        console.warn('applyProjectRoleDefaults failed (non-fatal):', err?.message);
      });

      // Trigger stage-change engine so notifications, activity log, and
      // deadline recalc all fire — same as manual stage changes in ProjectDetails
      api.functions.invoke('trackProjectStageChange', {
        projectId: project.id,
        old_data: { status: project.status },   // project.status is the OLD status here
        actor_id: null,
        actor_name: 'Booking Approval',
      }).catch(() => {});
    }

    queryClient.invalidateQueries({ queryKey: ['pendingReviewProjects'] });
    queryClient.invalidateQueries({ queryKey: ['tonomoQueueStats'] });
    setSubTab('brief');
  };

  return (
    <div>
      <Tabs value={subTab} onValueChange={setSubTab}>
        <TabsList>
          {project.status === 'pending_review' && <TabsTrigger value="review">Review Panel</TabsTrigger>}
          <TabsTrigger value="brief">Order Brief</TabsTrigger>
          <TabsTrigger value="timeline">
            Timeline
            {bookingTimeline.length > 0 && (
              <span className="ml-1.5 text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full font-bold">{bookingTimeline.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="audit">Audit Trail</TabsTrigger>
          <TabsTrigger value="payload">Raw Payload</TabsTrigger>
        </TabsList>

        {project.status === 'pending_review' && (
          <TabsContent value="review" className="mt-4">
            {/* Review type context */}
            <ReviewBanner reviewType={project.pending_review_type} />

            {approvalErrors.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-1.5">
                <p className="text-sm font-medium text-red-700 flex items-center gap-1.5">
                  <XCircle className="h-4 w-4 flex-shrink-0" />
                  Cannot approve — fix these issues first:
                </p>
                {approvalErrors.map((err, i) => (
                  <p key={i} className="text-xs text-red-600 pl-5">• {err}</p>
                ))}
              </div>
            )}
            {approvalWarnings.length > 0 && approvalErrors.length === 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
                <p className="text-sm font-medium text-amber-700 flex items-center gap-1.5">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  Heads up:
                </p>
                {approvalWarnings.map((w, i) => (
                  <p key={i} className="text-xs text-amber-600 pl-5">• {w}</p>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={handleApprove}
                className={project.pending_review_type === 'cancellation' ? 'bg-red-600 hover:bg-red-700' : ''}
              >
                <CheckCircle className="h-4 w-4 mr-2" />
                {project.pending_review_type === 'cancellation' ? 'Confirm Cancellation' :
                 project.pending_review_type === 'restoration' || project.pending_review_type === 'reopened_after_delivery' ? 'Restore & Reactivate →' :
                 'Approve →'}
              </Button>
              <Button variant="outline">
                <AlertCircle className="h-4 w-4 mr-2" />
                Flag Issue
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">What Tonomo Sent</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <DetailRow label="Order ID" value={project.tonomo_order_id} />
                  <DetailRow label="Event ID" value={project.tonomo_event_id} />
                  <DetailRow label="Package" value={project.tonomo_package || "—"} />
                  <DetailRow label="Services" value={(() => {
                    try { return JSON.parse(project.tonomo_raw_services || '[]').join(', ') || "—"; } catch { return "—"; }
                  })()} />
                  <DetailRow label="Video Project" value={project.tonomo_video_project === true ? "Yes" : project.tonomo_video_project === false ? "No" : "—"} />
                  <DetailRow label="Invoice Amount" value={project.tonomo_invoice_amount ? `$${project.tonomo_invoice_amount}` : "—"} />
                  <DetailRow label="Payment Status" value={project.tonomo_payment_status || "—"} />
                  <DetailRow label="Booking Flow" value={project.tonomo_booking_flow || "—"} />
                  {project.is_first_order && (
                    <DetailRow
                      label="First order"
                      value={
                        <span className="inline-flex items-center gap-1 text-xs font-medium
                                       px-2 py-0.5 rounded-full bg-amber-100 text-amber-700
                                       border border-amber-200">
                          ⭐ First order from this agent
                        </span>
                      }
                    />
                  )}
                  {project.tonomo_brokerage_code && (
                    <DetailRow label="Brokerage code" value={project.tonomo_brokerage_code} />
                  )}
                  </CardContent>
                  </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">What FlexStudios Stored</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <DetailRow label="Title" value={project.title} />
                  <DetailRow label="Address" value={project.property_address} />
                  <DetailRow label="Status" value={project.status} />
                  <DetailRow label="Agent" value={project.agent_id ? "Linked" : "Not linked"} />
                  <DetailRow label="Photographer" value={project.project_owner_id ? "Assigned" : "Not assigned"} />
                  <DetailRow label="Confidence" value={project.mapping_confidence || "—"} />
                  <DetailRow label="Gaps" value={(() => {
                    try { return JSON.parse(project.mapping_gaps || '[]').join(', ') || "None"; } catch { return "—"; }
                  })()} />
                </CardContent>
              </Card>
            </div>
            <AutoProductsCard project={project} />
          </TabsContent>
        )}

        <TabsContent value="brief" className="mt-4">
          <TonomoOrderBrief project={project} />
        </TabsContent>

        <TabsContent value="timeline" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Booking Timeline
              </CardTitle>
            </CardHeader>
            <CardContent>
              {bookingTimeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No processing events for this order</p>
              ) : (
                <div className="relative">
                  {/* Vertical line */}
                  <div className="absolute left-[11px] top-2 bottom-2 w-px bg-border" />
                  <div className="space-y-3">
                    {bookingTimeline.map((item, idx) => {
                      const statusConfig = {
                        completed: { dot: 'bg-green-500', bg: 'bg-green-50', text: 'text-green-700', label: 'Completed' },
                        failed: { dot: 'bg-red-500', bg: 'bg-red-50', text: 'text-red-700', label: 'Failed' },
                        dead_letter: { dot: 'bg-amber-500', bg: 'bg-amber-50', text: 'text-amber-700', label: 'Dead Letter' },
                        processing: { dot: 'bg-blue-500', bg: 'bg-blue-50', text: 'text-blue-700', label: 'Processing' },
                        pending: { dot: 'bg-slate-400', bg: 'bg-slate-50', text: 'text-slate-600', label: 'Pending' },
                        superseded: { dot: 'bg-gray-400', bg: 'bg-gray-50', text: 'text-gray-500', label: 'Superseded' },
                      };
                      const cfg = statusConfig[item.status] || statusConfig.pending;
                      const actionLabels = {
                        scheduled: 'Booking received',
                        rescheduled: 'Rescheduled',
                        changed: 'Details changed',
                        canceled: 'Cancelled',
                        booking_created_or_changed: 'Order updated',
                        booking_completed: 'Delivered',
                        new_customer: 'New customer',
                      };
                      return (
                        <div key={item.id} className="relative flex gap-3 pl-0">
                          {/* Timeline dot */}
                          <div className={`relative z-10 mt-1.5 h-[9px] w-[9px] rounded-full flex-shrink-0 ring-2 ring-background ${cfg.dot} ${item.status === 'processing' ? 'animate-pulse' : ''}`} style={{ marginLeft: '7px' }} />
                          {/* Content */}
                          <div className={`flex-1 rounded-lg border p-2.5 ${idx === 0 ? cfg.bg : 'bg-background'}`}>
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${cfg.bg} ${cfg.text}`}>
                                  {cfg.label}
                                </span>
                                <span className="text-sm font-medium">{actionLabels[item.action] || item.action}</span>
                              </div>
                              <span className="text-[11px] text-muted-foreground flex-shrink-0">
                                {item.processed_at ? relativeTime(parseTS(item.processed_at)) :
                                 item.created_at ? relativeTime(parseTS(item.created_at)) : '--'}
                              </span>
                            </div>
                            {(item.result_summary || item.error_message) && (
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                {item.result_summary || item.error_message}
                              </p>
                            )}
                            {item.retry_count > 0 && (
                              <p className="text-[10px] text-amber-600 mt-1">Attempt {item.retry_count + 1}</p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <div className="space-y-2">
            {auditLogs.map(log => (
              <Card key={log.id}>
                <CardContent className="pt-4">
                  <div className="flex items-start gap-3">
                    <Badge>{log.operation}</Badge>
                    <div className="flex-1">
                      <p className="text-sm font-medium">{log.entity_type} {log.operation}</p>
                      <p className="text-xs text-muted-foreground">{log.notes}</p>
                      <p className="text-xs text-muted-foreground mt-1">{parseTS(log.processed_at) ? toSydney(parseTS(log.processed_at)) : "—"}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
            {auditLogs.length === 0 && (
              <p className="text-muted-foreground text-center py-8">No audit trail available</p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="payload" className="mt-4">
          <pre className="bg-[#0f1117] text-[#f8f8f2] p-4 rounded-lg overflow-auto max-h-[600px] text-xs font-mono">
            {rawPayload || "No raw payload available"}
          </pre>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}:</span> <span className="font-medium">{value}</span>
    </div>
  );
}

function ReviewBanner({ reviewType }) {
  const config = {
    cancellation: { bg: 'bg-red-50 border-red-200', text: 'text-red-800', msg: '⚠️ Cancellation — Approving will mark this project as CANCELLED' },
    restoration: { bg: 'bg-amber-50 border-amber-200', text: 'text-amber-800', msg: '🔄 Restoration — Approving will re-enter this project into the active workflow' },
    reopened_after_delivery: { bg: 'bg-amber-50 border-amber-200', text: 'text-amber-800', msg: '🔄 Reopened after delivery — Approving will move back to Scheduled' },
    additional_appointment: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-800', msg: '📅 Additional appointment added — Approving will return to previous stage' },
  };
  const cfg = config[reviewType] || { bg: 'bg-muted border', text: 'text-muted-foreground', msg: '✅ New booking — Approving will move to Scheduled' };
  return (
    <div className={`mb-3 p-3 rounded-lg text-sm border ${cfg.bg} ${cfg.text}`}>
      <p className="font-medium">{cfg.msg}</p>
    </div>
  );
}

function TonomoOrderBrief({ project }) {
  const services = useMemo(() => {
    try { return JSON.parse(project.tonomo_raw_services || '[]'); } catch { return []; }
  }, [project.tonomo_raw_services]);

  const tiers = useMemo(() => {
    try { 
      const parsed = JSON.parse(project.tonomo_service_tiers || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }, [project.tonomo_service_tiers]);

  const photographers = useMemo(() => {
    try { 
      const parsed = JSON.parse(project.tonomo_photographer_ids || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }, [project.tonomo_photographer_ids]);

  const deliveredFiles = useMemo(() => {
    try { 
      const parsed = JSON.parse(project.tonomo_delivered_files || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }, [project.tonomo_delivered_files]);

  const totalHrs = tiers.reduce((sum, t) => sum + (Number(t?.hrs) || 0), 0);

  return (
    <Card>
      <CardContent className="pt-6 space-y-4 text-sm">
        <div>
          <h3 className="font-semibold mb-2">The property</h3>
          <p>{project.property_address}</p>
          {project.tonomo_video_project === true && <p>📹 Video project</p>}
          {project.tonomo_video_project === false && <p>📷 Stills project</p>}
        </div>

        <div>
          <h3 className="font-semibold mb-2">What was booked</h3>
          {project.tonomo_package && <p className="font-bold">{project.tonomo_package}</p>}
          {tiers.map((t, i) => (
            <p key={i}>• {t?.name || 'Service'} — {t?.selected || "No tier"}{(Number(t?.hrs) || 0) > 0 ? ` — ${t.hrs} hrs` : ""}</p>
          ))}
          {services.filter(s => !tiers.find(t => t?.name === s)).map((s, i) => (
            <p key={i}>• {s}</p>
          ))}
          <p className="font-medium mt-2">
            Total: {totalHrs} hrs on-site{project.tonomo_invoice_amount ? ` · Invoice: $${project.tonomo_invoice_amount}` : ""}
          </p>
          {project.tonomo_booking_flow && <p className="text-muted-foreground">Booking flow: {project.tonomo_booking_flow}</p>}
        </div>

        <div>
          <h3 className="font-semibold mb-2">Appointment</h3>
          {project.shoot_date ? (
            <p>{new Date(project.shoot_date + 'T00:00:00').toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", weekday: "long", month: "short", day: "numeric" })}</p>
          ) : (
            <p className="text-muted-foreground">No appointment scheduled</p>
          )}
          <p className="mt-1">
            Photographer: {photographers?.[0]?.name ? `${photographers[0].name}${photographers[0].email ? ` (${photographers[0].email})` : ''}` : "Unassigned"}
          </p>
        </div>

        <div>
          <h3 className="font-semibold mb-2">Delivery</h3>
          {project.tonomo_delivered_at ? (
            <p className="text-green-600">✅ Delivered {toSydney(parseTS(project.tonomo_delivered_at))}</p>
          ) : null}
          {deliveredFiles.length > 0 && (
            <div className="space-y-1 mt-1">
              {deliveredFiles.map((f, i) => (
                <p key={i}>
                  • {f?.name || 'File'} {f?.type ? `(${f.type})` : ''} — {f?.url ? <a href={f.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Download ↗</a> : 'No link'}
                </p>
              ))}
            </div>
          )}
          {project.tonomo_deliverable_link && (
            <p>
              <a href={project.tonomo_deliverable_link} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                📁 Dropbox folder ↗
              </a>
            </p>
          )}
          {!project.tonomo_delivered_at && deliveredFiles.length === 0 && !project.tonomo_deliverable_link && (
            <p className="text-muted-foreground">Not yet delivered</p>
          )}
        </div>

        <div>
          <h3 className="font-semibold mb-2">Order state</h3>
          <p>Status: {project.tonomo_order_status || "—"} · Payment: {project.tonomo_payment_status || "—"}</p>
          {project.tonomo_invoice_link && (
            <p>
              <a href={project.tonomo_invoice_link} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1">
                View invoice <ExternalLink className="h-3 w-3" />
              </a>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AutoProductsCard({ project }) {
  const autoApplied = project.products_auto_applied === true;
  const needsRecalc = project.products_needs_recalc === true;
  
  const mappingGaps = useMemo(() => {
    try {
      const parsed = JSON.parse(project.products_mapping_gaps || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }, [project.products_mapping_gaps]);

  const products = project.products || [];
  const packages = project.packages || [];

  if (!autoApplied && mappingGaps.length === 0) return null;

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Zap className="h-4 w-4" />
          Auto Product Mapping
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {autoApplied && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <p className="text-green-700 font-semibold">✅ Products auto-applied from confirmed mappings</p>
            <div className="mt-2 space-y-1">
              {products.map((p, i) => (
                <p key={i} className="text-xs">• {p.product_name} × {p.quantity}</p>
              ))}
              {packages.map((pkg, i) => (
                <p key={i} className="text-xs">• {pkg.package_name} (package)</p>
              ))}
            </div>
            {needsRecalc && (
              <p className="text-xs text-green-600 mt-2">💰 Pricing recalculation needed</p>
            )}
          </div>
        )}
        
        {mappingGaps.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <p className="text-amber-700 font-semibold">⚠️ Unmapped services (products NOT applied)</p>
            <div className="mt-2 space-y-1">
              {mappingGaps.map((serviceName, i) => (
                <p key={i} className="text-xs text-amber-600">• {serviceName}</p>
              ))}
            </div>
            <p className="text-xs text-amber-600 mt-2">→ Confirm mappings in Bookings Engine → Mappings</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}