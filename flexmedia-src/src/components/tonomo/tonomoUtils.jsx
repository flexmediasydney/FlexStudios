// Shared Tonomo webhook parsing utilities

export const ACTION_COLORS = {
  scheduled: "#22c55e",
  rescheduled: "#3b82f6",
  canceled: "#ef4444",
  changed: "#f59e0b",
  booking_created_or_changed: "#a855f7",
  booking_completed: "#10b981",
  new_customer: "#06b6d4",
  error: "#6b7280",
  unknown: "#6b7280"
};

export const ACTION_LABELS = {
  scheduled: "Scheduled",
  rescheduled: "Rescheduled",
  canceled: "Canceled",
  changed: "Changed",
  booking_created_or_changed: "Order Update",
  booking_completed: "Delivered",
  new_customer: "New Customer",
  error: "Error",
  unknown: "Unknown"
};

const SYDNEY_TZ = "Australia/Sydney";

export function parseTS(str) {
  if (!str) return null;
  const s = typeof str === "string" && !str.endsWith("Z") ? str + "Z" : str;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function toSydney(date) {
  if (!date) return "";
  return date.toLocaleString("en-AU", { 
    timeZone: SYDNEY_TZ, 
    hour: "2-digit", 
    minute: "2-digit", 
    day: "2-digit", 
    month: "short" 
  });
}

export function relativeTime(date) {
  if (!date) return "";
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return toSydney(date);
}

export function parsePayload(raw) {
  try {
    const p = JSON.parse(raw);

    // Action detection
    let action = null;
    if (p.action) {
      action = p.action;
    } else if (p.bookingFlow && p.user) {
      action = "new_customer";
    } else if (p.orderStatus === "complete" && p.shouldNotifyOrderCompletion === true) {
      action = "booking_completed";
    } else if (p.isValidatedForWebhook || p.orderStatus) {
      action = "booking_created_or_changed";
    } else {
      action = "unknown";
    }

    const isOrderCancelled =
      action === "canceled" ||
      (action === "changed" && p.order?.orderStatus === "cancelled") ||
      ((action === "booking_created_or_changed") && p.orderStatus === "cancelled");

    const isFullyCancelled =
      isOrderCancelled &&
      (p.order?.calendarEvent === null || p.calendarEvent === null) &&
      ((p.order?.travels?.length ?? 1) === 0 || (p.travels?.length ?? 1) === 0);

    const address =
      p.address?.formatted_address ||
      p.location ||
      p.order?.property_address?.formatted_address ||
      p.property_address?.formatted_address ||
      "No address";

    // IDs
    const orderId = p.orderId || p.order?.orderId || p.id || "unknown";
    const orderName =
      p.order?.orderName || p.orderName ||
      p.order?.order_name || p.order_name || "Unknown order";

    // People
    const photographer = p.photographers?.[0] || null;
    const agent = p.order?.listingAgents?.[0] || p.listingAgents?.[0] || null;

    const servicesA = p.order?.services_a_la_cart || p.services_a_la_cart || [];
    const servicesB = p.order?.services || p.services || [];
    const services = [...new Set([...servicesA, ...servicesB])].filter(Boolean);

    const tiers = (p.order?.service_custom_tiers || p.service_custom_tiers || [])
      .map(t => ({
        name: t.serviceName,
        selected: t.selected?.name || null,
        hrs: t.selected?.hrs ?? 0
      }));

    const package_ = p.order?.package?.name || p.package?.name || null;
    const bookingFlow = p.order?.bookingFlow?.name || p.bookingFlow?.name || null;

    const startTime = (p.when && p.when.start_time) ? p.when.start_time * 1000 : null;
    const endTime = (p.when && p.when.end_time) ? p.when.end_time * 1000 : null;
    const durationMinutes = (startTime && endTime)
      ? Math.round((endTime - startTime) / 60000) : null;

    const invoiceAmount = p.order?.invoice_amount ?? p.invoice_amount ?? null;
    const invoiceLink = p.invoice_link || p.order?.invoice_link || null;
    const paymentStatus = p.order?.paymentStatus || p.paymentStatus || null;
    const orderStatus = p.order?.orderStatus || p.orderStatus || null;
    const videoProject = p.order?.videoProject ?? p.videoProject ?? null;

    const deliveredFiles = p.deliverablesLinks || p.order?.deliverablesLinks || [];
    const deliveredAt = p.deliveredDate ? new Date(p.deliveredDate) : null;
    const shouldNotifyOrderCompletion = p.shouldNotifyOrderCompletion ?? false;
    let summary = "";
    if (isFullyCancelled) {
      summary = `Booking fully cancelled — ${orderName}`;
    } else if (isOrderCancelled && action === "changed") {
      summary = `Booking cancelled — ${orderName}`;
    } else if (action === "scheduled") {
      summary = `New shoot scheduled — ${orderName} — ${photographer?.name ?? "Unassigned"}`;
    } else if (action === "rescheduled") {
      summary = `Shoot rescheduled — ${orderName} — ${photographer?.name ?? "Unassigned"}`;
    } else if (action === "canceled") {
      summary = `Appointment cancelled — ${orderName}`;
    } else if (action === "changed") {
      summary = `Photographer reassigned — ${orderName} — ${photographer?.name ?? "Unassigned"}`;
    } else if (action === "booking_created_or_changed" && isOrderCancelled) {
      summary = `Order cancelled — ${orderName}`;
    } else if (action === "booking_created_or_changed" && deliveredFiles.length > 0 && orderStatus !== "complete") {
      summary = `Files uploaded — ${orderName} — ${deliveredFiles.length} file${deliveredFiles.length !== 1 ? "s" : ""} — awaiting completion`;
    } else if (action === "booking_created_or_changed") {
      summary = `Order updated — ${orderName}${invoiceAmount ? ` — $${invoiceAmount}` : ""}`;
    } else if (action === "booking_completed") {
      summary = `Order delivered — ${orderName} — ${deliveredFiles.length} file${deliveredFiles.length !== 1 ? "s" : ""}${invoiceAmount ? ` — $${invoiceAmount}` : ""}`;
    } else if (action === "new_customer") {
      summary = `New customer — ${p.user?.name ?? ""} — ${p.user?.email ?? ""}`;
    } else {
      summary = `Event — ${orderName}`;
    }

    return {
      ok: true,
      action, isOrderCancelled, isFullyCancelled,
      address, orderId, orderName,
      photographer, agent,
      services, tiers, package: package_, bookingFlow,
      startTime, endTime, durationMinutes,
      invoiceAmount, invoiceLink, paymentStatus, orderStatus, videoProject,
      deliveredFiles, deliveredAt,
      shouldNotifyOrderCompletion,
      summary, raw: p
    };

  } catch (e) {
    return {
      ok: false,
      error: e.message,
      action: "error",
      summary: `Error: ${e.message}`,
      address: "—", orderId: "—", orderName: "—",
      photographer: null, agent: null,
      services: [], tiers: [], package: null, bookingFlow: null,
      startTime: null, endTime: null, durationMinutes: null,
      invoiceAmount: null, invoiceLink: null, paymentStatus: null,
      orderStatus: null, videoProject: null,
      deliveredFiles: [], deliveredAt: null,
      shouldNotifyOrderCompletion: false,
      isOrderCancelled: false, isFullyCancelled: false, raw: null
    };
  }
}