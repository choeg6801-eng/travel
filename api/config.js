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
  });
};
module.exports.DEFAULT_URL = DEFAULT_URL;
module.exports.DEFAULT_KEY = DEFAULT_KEY;
