import { getAdminClient, getUserFromReq, getUserClient, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction, serveWithAudit } from '../_shared/supabase.ts';

// Manual test to simulate a Tonomo webhook
// Usage: Call this function from the frontend or via API to test webhook processing

serveWithAudit('testTonomoWebhook', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const userClient = getUserClient(req);
    const userEntities = createEntities(userClient);
    const user = await getUserFromReq(req);

    if (!user) {
      return errorResponse('Unauthorized', 401);
    }
    if (user.role !== 'master_admin') {
      return errorResponse('Admin access required', 403);
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

    console.log("Sending test webhook to receiveTonomoWebhook...");

    // Send to the webhook receiver via cross-function call
    let result;
    try {
      result = await invokeFunction('receiveTonomoWebhook', testPayload);
    } catch (err: any) {
      result = { error: err.message };
    }

    console.log("Webhook receiver response:", result);

    // Wait a moment for processing
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if webhook was logged
    const logs = await userEntities.TonomoWebhookLog.filter(
      { event_type: 'booking_created_or_changed' },
      '-received_at',
      5
    );

    const ourLog = logs?.find((log: any) => log.raw_payload?.includes(testPayload.orderId));

    // Check if it was queued
    const queue = await userEntities.TonomoProcessingQueue.filter(
      { order_id: testPayload.orderId },
      '-created_at',
      1
    );

    return jsonResponse({
      success: true,
      test_order_id: testPayload.orderId,
      webhook_response: result,
      webhook_logged: !!ourLog,
      log_id: ourLog?.id || null,
      queued: queue?.length > 0,
      queue_status: queue?.[0]?.status || 'not_queued',
      queue_id: queue?.[0]?.id || null,
      message: queue?.length > 0
        ? "Test webhook received, logged, and queued successfully!"
        : "Webhook received but not queued - check logs"
    });

  } catch (err: any) {
    console.error("Test error:", err);
    return errorResponse(err.message);
  }
});
