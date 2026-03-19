import { getAdminClient, getUserFromReq, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    const admin = getAdminClient();
    const user = await getUserFromReq(req);

    if (!user) {
      return errorResponse('Unauthorized', 401);
    }

    const { searchText } = await req.json();

    if (!searchText || searchText.trim().length < 1) {
      return jsonResponse({ predictions: [] });
    }

    const apiKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
    if (!apiKey) {
      console.error('GOOGLE_PLACES_API_KEY not configured');
      return jsonResponse({ error: 'API key not configured', predictions: [] });
    }

    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?` +
      `input=${encodeURIComponent(searchText)}&` +
      `components=country:au&` +
      `key=${apiKey}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'ZERO_RESULTS' || !data.predictions) {
      return jsonResponse({ predictions: [] });
    }

    if (data.status && data.status !== 'OK') {
      console.error(`Google Places API error: ${data.status}`, data.error_message);
      return jsonResponse({
        error: `Address search unavailable: ${data.error_message || data.status}`,
        predictions: [],
      });
    }

    const predictions = data.predictions.map((p: any) => ({
      placeId: p.place_id,
      mainText: p.structured_formatting?.main_text || p.description,
      description: p.description,
    }));

    return jsonResponse({ predictions });
  } catch (error: any) {
    console.error('searchAustralianAddresses error:', error);
    return jsonResponse({
      error: `Error: ${error.message}`,
      predictions: [],
    }, 500);
  }
});
