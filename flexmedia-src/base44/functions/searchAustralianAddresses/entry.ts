import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchText } = await req.json();

    if (!searchText || searchText.trim().length < 1) {
      return Response.json({ predictions: [] });
    }

    const apiKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
    if (!apiKey) {
      console.error('GOOGLE_PLACES_API_KEY not configured');
      return Response.json({ error: 'API key not configured', predictions: [] });
    }

    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?` +
      `input=${encodeURIComponent(searchText)}&` +
      `components=country:au&` +
      `key=${apiKey}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'ZERO_RESULTS' || !data.predictions) {
      return Response.json({ predictions: [] });
    }

    if (data.status && data.status !== 'OK') {
      console.error(`Google Places API error: ${data.status}`, data.error_message);
      return Response.json({ 
        error: `Address search unavailable: ${data.error_message || data.status}`,
        predictions: [] 
      });
    }

    const predictions = data.predictions.map(p => ({
      placeId: p.place_id,
      mainText: p.structured_formatting?.main_text || p.description,
      description: p.description
    }));

    return Response.json({ predictions });
  } catch (error) {
    console.error('searchAustralianAddresses error:', error);
    return Response.json({ 
      error: `Error: ${error.message}`,
      predictions: [] 
    }, { status: 500 });
  }
});