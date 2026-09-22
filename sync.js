/* Syncing between phones, over Supabase.

   Every change is a record stamped with when it happened and which device
   made it. Pushing sends the records this phone has touched; pulling asks
   for everything the server has seen since last time, in the server's own
   order, and folds it in. Later timestamp wins; a tie is broken by device
   id so both phones settle on the same answer without negotiating.

   A ledger is shared by handing someone its join code. The code is the
   only credential: anyone holding it can read and write that ledger and
   nothing else, which is the same bargain as a shareable document link.
   Nothing else on your phone is uploaded — private tabs stay private. */

(() => {
'use strict';

const cfg = window.SPLIT_SYNC || {};
const store = window.SplitStore;

/* `anonKey` was the old name for this. A service worker can serve a
   config.js from before the rename long after the app itself updates, and
   reading only the new name would turn syncing off without saying so. */
const apiKey = () => cfg.key || cfg.anonKey || '';
const configured = () => Boolean(cfg.url && apiKey());

const PULL_EVERY = 8000;   // while the app is open and in front
const PUSH_DELAY = 900;    // let a burst of edits settle first

const state = {
  status: configured() ? 'idle' : 'off',
  lastSync: 0,
  error: '',
};

/* Ambiguous characters are left out so a code can be read down the phone. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function makeCode() {
  const bytes = new Uint8Array(12);
  (window.crypto || window.msCrypto).getRandomValues(bytes);
  const chars = [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

const tidyCode = code => String(code || '')
  .toUpperCase().replace(/[^A-Z0-9]/g, '')
  .replace(/(.{4})(.{4})(.{4}).*/, '$1-$2-$3');

async function rpc(fn, body) {
  const res = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKey(),
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${fn} failed (${res.status}) ${detail.slice(0, 200)}`);
  }
  return res.json();
}

/* ------------------------------------------------------------ one ledger */

async function pushLedger(ledger) {
  const sync = store.syncOf(ledger.id);
  if (!sync) return 0;
  const records = store.recordsFor(ledger, sync.pushedSeq || 0);
  if (!records.length) return 0;

  await rpc('split_push', {
    p_code: sync.code,
    p_device: recordDevice(records),
    p_records: records,
  });

  /* Only move the mark once the server has actually taken them, or a failed
     push would look like a done one and those edits would never be sent. */
  const highest = records.reduce((a, r) => Math.max(a, r.localSeq || 0), sync.pushedSeq || 0);
  store.setSync(ledger.id, { pushedSeq: highest });
  return records.length;
}

const recordDevice = records => records[0]?.device || '';

async function pullLedger(ledgerId, code, since) {
  const rows = await rpc('split_pull', { p_code: code, p_since: since || 0 });
  if (!Array.isArray(rows) || !rows.length) return { changed: 0, seq: since || 0 };

  const records = rows.map(r => ({
    kind: r.kind, id: r.id, updatedAt: Number(r.updated_at),
    device: r.device || '', payload: r.payload,
  }));
  const changed = store.applyRecords(ledgerId, records);
  const seq = rows.reduce((a, r) => Math.max(a, Number(r.seq)), since || 0);
  return { changed, seq };
}

/* ---------------------------------------------------------------- driving */

let running = false;
let pending = false;

async function syncNow() {
  if (!configured()) return;
  if (running) { pending = true; return; }
  running = true;
  state.status = 'syncing';

  let changed = 0;
  try {
    for (const ledger of store.sharedLedgers()) {
      const sync = store.syncOf(ledger.id);
      await pushLedger(ledger);
      const result = await pullLedger(ledger.id, sync.code, sync.since || 0);
      changed += result.changed;
      store.setSync(ledger.id, { since: result.seq, at: Date.now() });
    }
    state.status = 'idle';
    state.error = '';
    state.lastSync = Date.now();
  } catch (err) {
    state.status = 'error';
    state.error = String(err.message || err);
    console.warn('Sync failed', err);
  }

  writeThrough();
  if (changed) store.render();

  running = false;
  if (pending) { pending = false; setTimeout(syncNow, 50); }
}

const writeThrough = () => store.saveQuiet();

let pushTimer;
function localChanged() {
  if (!configured() || !store.sharedLedgers().length) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncNow, PUSH_DELAY);
}

let ticker;
function startTicking() {
  clearInterval(ticker);
  if (!configured()) return;
  ticker = setInterval(() => {
    if (document.visibilityState === 'visible' && store.sharedLedgers().length) syncNow();
  }, PULL_EVERY);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncNow();
});
window.addEventListener('online', syncNow);

/* ------------------------------------------------------------------- api */

window.SplitSync = {
  configured,
  state,
  localChanged,
  syncNow,
  makeCode,
  tidyCode,

  /* Start sharing a ledger this phone already has. */
  async share(ledgerId) {
    const ledger = store.ledgerById(ledgerId);
    if (!ledger) throw new Error('No such ledger');
    if (!configured()) throw new Error('Syncing is not set up yet');

    const existing = store.syncOf(ledgerId);
    const code = existing?.code || makeCode();
    store.setSync(ledgerId, { code, since: existing?.since || 0, pushedSeq: 0 });
    try {
      await pushLedger(ledger);
      const result = await pullLedger(ledgerId, code, 0);
      store.setSync(ledgerId, { since: result.seq, at: Date.now() });
      writeThrough();
      return code;
    } catch (err) {
      store.clearSync(ledgerId);
      writeThrough();
      throw err;
    }
  },

  /* Pull a ledger someone else shared. Returns its id, or null if the
     code matches nothing. */
  async join(rawCode) {
    if (!configured()) throw new Error('Syncing is not set up yet');
    const code = tidyCode(rawCode);
    if (code.length !== 14) throw new Error('That code does not look right');

    const rows = await rpc('split_pull', { p_code: code, p_since: 0 });
    if (!Array.isArray(rows) || !rows.length) return null;

    const ledgerRow = rows.find(r => r.kind === 'ledger');
    if (!ledgerRow) return null;
    const ledgerId = ledgerRow.id;

    const records = rows.map(r => ({
      kind: r.kind, id: r.id, updatedAt: Number(r.updated_at),
      device: r.device || '', payload: r.payload,
    }));
    store.applyRecords(ledgerId, records);
    const seq = rows.reduce((a, r) => Math.max(a, Number(r.seq)), 0);
    /* Everything just pulled came from elsewhere and carries no local
       counter, so there is nothing of ours to push back. */
    store.setSync(ledgerId, { code, since: seq, pushedSeq: 0, at: Date.now() });
    writeThrough();
    return ledgerId;
  },

  /* Stop syncing on this phone. The ledger and its history stay put, and
     the copy on the server is left alone for whoever else is in it. */
  stop(ledgerId) {
    store.clearSync(ledgerId);
    writeThrough();
  },
};

startTicking();
if (configured()) setTimeout(syncNow, 400);
})();
