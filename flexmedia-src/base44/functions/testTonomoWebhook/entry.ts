import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

// Manual test to simulate a Tonomo webhook
// Usage: Call this function from the frontend or via API to test webhook processing

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (user.role !== 'master_admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    // Simulate a realistic Tonomo webhook payload
    const testPayload = {
      orderId: "TEST_" + Date.now(),
      orderName: "TEST - Manual Webhook Test",
      orderStatus: "scheduled",
      isValidatedForWebhook: true,
      client_full_name: "Test Client",
      email: "test@example.com",
      phone_number: "0400000000",
      invoice_amount: 500,
      paymentStatus: "unpaid",
      videoProject: false,
      property_address: {
        formatted_address: "123 Test St, Sydney NSW 2000, Australia",
        lat: -33.8688,
        lng: 151.2093,
        timezone: "Australia/Sydney"
      },
      package: {
        name: "Test Package",
        packageId: "TEST_PKG_123"
      },
      services: ["Photography", "Floor Plan"],
      service_custom_tiers: [
        {
          serviceName: "Photography",
          selected: {
            name: "Standard Photography",
            price: "300",
            hrs: 1
          }
        },
        {
          serviceName: "Floor Plan",
          selected: {
            name: "Basic Floor Plan",
            price: "200",
            hrs: 0.5
          }
        }
      ],
      listingAgents: [
        {
          uid: "TEST_AGENT_123",
          displayName: "Test Agent",
          email: "agent@test.com",
          phone: "+61400000000"
        }
      ],
      photographers: [
        {
          id: user.id,
          name: user.full_name,
          email: user.email
        }
      ],
      when: {
        start_time: Math.floor(Date.now() / 1000) + 86400, // Tomorrow
        end_time: Math.floor(Date.now() / 1000) + 90000,
        object: "timespan"
      },
      date: new Date(Date.now() + 86400000).toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric' 
      }),
      scheduled_time: "10:00 - 11:00",
      bookingFlow: {
        id: "TEST_FLOW_123",
        name: "Test Booking Flow",
        type: "property"
      },
      calendarEvent: "TEST_CAL_EVENT_123",
      deliverable_link: "",
      deliverable_path: ""
    };

    console.log("📤 Sending test webhook to receiveTonomoWebhook...");

    // Send to the webhook receiver
    const response = await fetch('https://flexstudios.app/api/functions/receiveTonomoWebhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TonomoWebhookTest/1.0',
      },
      body: JSON.stringify(testPayload),
    });

    const result = await response.json();

    console.log("📥 Webhook receiver response:", result);

    // Wait a moment for processing
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if webhook was logged
    const logs = await base44.entities.TonomoWebhookLog.filter(
      { event_type: 'booking_created_or_changed' },
      '-received_at',
      5
    );

    const ourLog = logs?.find(log => log.raw_payload?.includes(testPayload.orderId));

    // Check if it was queued
    const queue = await base44.entities.TonomoProcessingQueue.filter(
      { order_id: testPayload.orderId },
      '-created_at',
      1
    );

    return Response.json({
      success: true,
      test_order_id: testPayload.orderId,
      webhook_response: result,
      webhook_logged: !!ourLog,
      log_id: ourLog?.id || null,
      queued: queue?.length > 0,
      queue_status: queue?.[0]?.status || 'not_queued',
      queue_id: queue?.[0]?.id || null,
      message: queue?.length > 0 
        ? "✅ Test webhook received, logged, and queued successfully!" 
        : "⚠️ Webhook received but not queued - check logs"
    });

  } catch (err) {
    console.error("Test error:", err);
    return Response.json({ 
      success: false, 
      error: err.message,
      stack: err.stack 
    }, { status: 500 });
  }
});