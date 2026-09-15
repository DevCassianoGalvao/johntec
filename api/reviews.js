// Vercel serverless function — returns this business's live Google rating
// and up to 5 reviews via the Google Places API.
//
// Setup (one-time, in the Vercel dashboard for this project):
//   1. Google Cloud Console > create/select a project > enable "Places API".
//   2. Create an API key (Credentials > Create Credentials > API key).
//      Restrict it to "Places API" under API restrictions (no HTTP referrer
//      restriction — this call runs server-side, not from the browser).
//   3. Vercel > this project > Settings > Environment Variables:
//      add GOOGLE_PLACES_API_KEY = <the key>. Redeploy.
//
// Until the key is set, this returns { live: false } and the page falls
// back to its static placeholder reviews — nothing breaks.
const BUSINESS_QUERY =
  'John Tec - Assistência Técnica em Smartphones, Travessa João Pessoa 613, Itaituba PA';

// Places API is billed per call — cache the resolved place_id for the life
// of the lambda instance, and the full response for CACHE_TTL_MS on top of
// that (both in-memory and via the Cache-Control header below).
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
let cache = { data: null, expiresAt: 0 };
let cachedPlaceId = null;

async function resolvePlaceId(apiKey) {
  if (cachedPlaceId) return cachedPlaceId;
  const url = new URL('https://maps.googleapis.com/maps/api/place/findplacefromtext/json');
  url.searchParams.set('input', BUSINESS_QUERY);
  url.searchParams.set('inputtype', 'textquery');
  url.searchParams.set('fields', 'place_id');
  url.searchParams.set('key', apiKey);
  const r = await fetch(url);
  const j = await r.json();
  const id = j.candidates && j.candidates[0] && j.candidates[0].place_id;
  if (!id) throw new Error('place not found: ' + (j.status || 'unknown'));
  cachedPlaceId = id;
  return id;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');

  const now = Date.now();
  if (cache.data && cache.expiresAt > now) {
    res.status(200).json(cache.data);
    return;
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    res.status(200).json({ live: false, error: 'GOOGLE_PLACES_API_KEY not set' });
    return;
  }

  try {
    const placeId = process.env.GOOGLE_PLACE_ID || (await resolvePlaceId(apiKey));
    const detailsUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    detailsUrl.searchParams.set('place_id', placeId);
    detailsUrl.searchParams.set('fields', 'rating,user_ratings_total,reviews');
    detailsUrl.searchParams.set('language', 'pt-BR');
    detailsUrl.searchParams.set('key', apiKey);
    const r = await fetch(detailsUrl);
    const j = await r.json();
    if (j.status !== 'OK') throw new Error('places details: ' + j.status);

    const result = j.result || {};
    const reviews = (result.reviews || []).slice(0, 5).map((rv) => ({
      name: rv.author_name || 'Cliente Google',
      photo: rv.profile_photo_url || '',
      rating: rv.rating || 5,
      text: rv.text || '',
    }));

    const data = {
      live: true,
      rating: result.rating ?? null,
      total: result.user_ratings_total ?? null,
      reviews,
    };
    cache = { data, expiresAt: now + CACHE_TTL_MS };
    res.status(200).json(data);
  } catch (err) {
    res.status(200).json({ live: false, error: String((err && err.message) || err) });
  }
};
