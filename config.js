/* Fill these in to turn on syncing between phones, then reload.
   Both values come from your Supabase project: Settings → API.
   The anon key is meant to be public — it is not a password, and on its
   own it opens nothing. What guards a ledger is its join code, which is
   never stored here. Leave the strings empty to keep the app offline
   and entirely on this device. */
window.SPLIT_SYNC = {
  url: '',      // e.g. 'https://abcdefghijkl.supabase.co'
  anonKey: '',  // the long "anon public" key
};
