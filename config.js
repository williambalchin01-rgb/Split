/* Syncing between phones. Both values come from your Supabase project,
   under Settings → API Keys.

   The publishable key belongs here in the open: it is not a password, and
   on its own it opens nothing, because split_pull and split_push are the
   only way to the data and both demand a ledger's join code. The *secret*
   key must never appear in this file — it bypasses those checks entirely,
   and everything in here is served to every browser that loads the app.

   Leave the strings empty to keep the app offline and entirely on device. */
window.SPLIT_SYNC = {
  url: 'https://hzbrbfsjbuzyxeakqplf.supabase.co',
  key: 'sb_publishable_tiO1wej_9r4rO1RvhySTCQ_InyqBsft',
};
