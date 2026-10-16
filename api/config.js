// Public settings the page needs to talk to Supabase.
// The publishable key is safe to expose: every table and the photo bucket
// are locked by row-level security to the signed-in user's own rows.
const DEFAULT_URL = 'https://tiworidlvfsdruztccbw.supabase.co';
const DEFAULT_KEY = 'sb_publishable_7SFKKbi3fGjGUA7Bh_6ClQ_gE3C4CfG';

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || DEFAULT_URL,
    supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY || DEFAULT_KEY,
    place: process.env.KAKAO_REST_API_KEY ? 'kakao' : 'osm',
    placeGoogle: !!process.env.GOOGLE_PLACES_API_KEY,
    tour: !!process.env.TOURAPI_KEY,
    tm: !!process.env.TICKETMASTER_API_KEY,
    ai: process.env.GEMINI_API_KEY && ((process.env.AI_PROVIDER || '').toLowerCase() !== 'claude' || !process.env.ANTHROPIC_API_KEY) ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'claude' : 'none',
  });
};
module.exports.DEFAULT_URL = DEFAULT_URL;
module.exports.DEFAULT_KEY = DEFAULT_KEY;
