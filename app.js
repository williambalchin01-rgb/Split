/* Split — shared expenses, in groups or one to one. No build step, no backend. */
(() => {
'use strict';

/* ---------------------------------------------------------------- storage */
/* A "ledger" is either a group or a one-to-one tab with a single person;
   both work the same way underneath, they are just presented differently.
   People live in one registry so the same Sam can appear in several ledgers
   and the totals with him can be added up across all of them. */

const KEY = 'split';
const LEGACY_KEY = 'split.v1';

const CURRENCIES = [
  { code: 'GBP', symbol: '£' }, { code: 'EUR', symbol: '€' },
  { code: 'USD', symbol: '$' }, { code: 'AUD', symbol: 'A$' },
  { code: 'CAD', symbol: 'C$' }, { code: 'CHF', symbol: 'CHF ' },
  { code: 'JPY', symbol: '¥' }, { code: 'SEK', symbol: 'kr ' },
];
const CATEGORIES = ['General', 'Food & drink', 'Groceries', 'Travel', 'Accommodation', 'Tickets', 'Shopping', 'Utilities'];

const blank = () => ({ version: 2, me: null, people: [], ledgers: [] });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

let db = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.ledgers)) return parsed;
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const migrated = migrate(JSON.parse(legacy));
      localStorage.setItem(KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch (err) {
    console.warn('Could not read saved data', err);
  }
  return blank();
}

/* v1 kept its people inside each group. Pull them into one registry,
   treating the same name in two groups as the same person. */
function migrate(old) {
  if (!old || !Array.isArray(old.groups)) return blank();
  const out = blank();
  const byName = new Map();
  const ensure = name => {
    const key = String(name || 'Someone').trim().toLowerCase();
    if (byName.has(key)) return byName.get(key);
    const person = { id: uid(), name: String(name || 'Someone').trim() };
    out.people.push(person);
    byName.set(key, person.id);
    return person.id;
  };

  old.groups.forEach(g => {
    const map = {};
    (g.members || []).forEach(m => { map[m.id] = ensure(m.name); });
    if (g.meId && map[g.meId] && !out.me) out.me = map[g.meId];
    const remap = obj => Object.fromEntries(
      Object.entries(obj || {}).map(([k, v]) => [map[k] || k, v]));
    out.ledgers.push({
      id: g.id, kind: 'group', name: g.name, currency: g.currency,
      members: (g.members || []).map(m => map[m.id]),
      expenses: (g.expenses || []).map(e => ({
        ...e, paidBy: map[e.paidBy] || e.paidBy,
        participants: (e.participants || []).map(p => map[p] || p),
        weights: remap(e.weights),
      })),
      settlements: (g.settlements || []).map(s => ({
        ...s, from: map[s.from] || s.from, to: map[s.to] || s.to,
      })),
      created: g.created,
    });
  });
  if (!out.me && out.people.length) out.me = out.people[0].id;
  return out;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch (err) {
    toast('Could not save — storage is full or blocked');
  }
}

/* ------------------------------------------------------------------ money */
/* Everything is stored in minor units (pence) so the sums always balance. */

function parseAmount(text) {
  if (typeof text !== 'string') text = String(text ?? '');
  const cleaned = text.replace(/[^0-9.,-]/g, '').replace(/,/g, '.');
  if (!cleaned || cleaned === '.' || cleaned === '-') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function symbolFor(code) {
  const found = CURRENCIES.find(c => c.code === code);
  return found ? found.symbol : (code ? code + ' ' : '£');
}

function money(pence, code) {
  const sign = pence < 0 ? '-' : '';
  const abs = Math.abs(pence);
  return sign + symbolFor(code) + (abs / 100).toFixed(2);
}

/* Split `total` into parts in proportion to the weights, handing the
   leftover pence to the largest remainders first. */
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map(w => (total * w) / sum);
  const floors = exact.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) floors[order[k].i]++;
  for (let k = 0; left < 0 && k < order.length; k++, left++) floors[order[k].i]--;
  return floors;
}

/* Who owes what for one expense: { personId: pence }. */
function sharesOf(expense, ledger) {
  const ids = (expense.participants || []).filter(id => ledger.members.includes(id));
  const out = {};
  if (!ids.length) return out;

  if (expense.mode === 'exact') {
    ids.forEach(id => { out[id] = Math.round(expense.weights?.[id] || 0); });
    return out;
  }
  const weights = expense.mode === 'shares'
    ? ids.map(id => Math.max(0, Number(expense.weights?.[id] ?? 1)))
    : ids.map(() => 1);
  const parts = allocate(expense.amount, weights.some(w => w > 0) ? weights : ids.map(() => 1));
  ids.forEach((id, i) => { out[id] = parts[i]; });
  return out;
}

/* Net position per person in one ledger: positive = they are owed. */
function balances(ledger) {
  const net = {};
  ledger.members.forEach(id => { net[id] = 0; });

  ledger.expenses.forEach(e => {
    if (net[e.paidBy] === undefined) return;
    net[e.paidBy] += e.amount;
    Object.entries(sharesOf(e, ledger)).forEach(([id, amt]) => {
      if (net[id] !== undefined) net[id] -= amt;
    });
  });

  (ledger.settlements || []).forEach(s => {
    if (net[s.from] !== undefined) net[s.from] += s.amount;
    if (net[s.to] !== undefined) net[s.to] -= s.amount;
  });

  return net;
}

/* What b owes a in one ledger. Each expense creates a debt from every
   participant to whoever paid, so this is exact even in a big group —
   and summing it over everyone gives back that person's balance. */
function pairNet(ledger, a, b) {
  let n = 0;
  ledger.expenses.forEach(e => {
    if (e.paidBy !== a && e.paidBy !== b) return;
    const shares = sharesOf(e, ledger);
    if (e.paidBy === a) n += shares[b] || 0;
    else n -= shares[a] || 0;
  });
  (ledger.settlements || []).forEach(s => {
    if (s.from === b && s.to === a) n -= s.amount;
    else if (s.from === a && s.to === b) n += s.amount;
  });
  return n;
}

/* Fewest transfers that clear the board: biggest debtor pays biggest creditor. */
function settleUp(ledger) {
  const net = balances(ledger);
  const creditors = [], debtors = [];
  Object.entries(net).forEach(([id, amt]) => {
    if (amt > 0) creditors.push({ id, amt });
    else if (amt < 0) debtors.push({ id, amt: -amt });
  });
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);

  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    if (pay > 0) transfers.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt === 0) i++;
    if (creditors[j].amt === 0) j++;
  }
  return transfers;
}

/* Totals per currency, since a euro debt cannot be netted off a pound one. */
function addTo(totals, currency, amount) {
  totals[currency] = (totals[currency] || 0) + amount;
  return totals;
}

function totalsText(totals, { owed, owe, level } = {}) {
  const parts = Object.entries(totals).filter(([, amt]) => amt !== 0);
  if (!parts.length) return level || 'all settled up';
  return parts.map(([cur, amt]) =>
    `${amt > 0 ? (owed || 'owed') : (owe || 'owe')} ${money(Math.abs(amt), cur)}`).join(' · ');
}

/* Label above, figure below, so a long phrase cannot squeeze the row. */
function totalsCell(totals, { owed, owe, level }) {
  const parts = Object.entries(totals).filter(([, amt]) => amt !== 0);
  if (!parts.length) return { label: '', value: level };
  if (parts.length === 1) {
    const [currency, amt] = parts[0];
    return { label: amt > 0 ? owed : owe, value: money(Math.abs(amt), currency) };
  }
  return {
    label: '',
    value: parts.map(([c, a]) => `${a > 0 ? owed : owe} ${money(Math.abs(a), c)}`).join(' · '),
  };
}

const totalsSign = totals => {
  const values = Object.values(totals).filter(v => v !== 0);
  if (!values.length) return 0;
  return values.every(v => v > 0) ? 1 : values.every(v => v < 0) ? -1 : 2;
};

/* ------------------------------------------------------------------ model */
const ledgerById = id => db.ledgers.find(l => l.id === id);
const personById = id => db.people.find(p => p.id === id);
const nameOf = id => (id === db.me ? 'You' : (personById(id)?.name || 'Someone'));
const realName = id => personById(id)?.name || 'Someone';
const otherIn = ledger => ledger.members.find(id => id !== db.me) || ledger.members[0];

const directLedgers = () => db.ledgers.filter(l => l.kind === 'direct');
const groupLedgers = () => db.ledgers.filter(l => l.kind !== 'direct');

function ledgerTitle(ledger) {
  return ledger.kind === 'direct' ? realName(otherIn(ledger)) : ledger.name;
}

/* Find an existing person by name, or make a new one. */
function ensurePerson(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const found = db.people.find(p => p.name.toLowerCase() === clean.toLowerCase());
  if (found) return found.id;
  const person = { id: uid(), name: clean };
  db.people.push(person);
  return person.id;
}

function ensureMe(name) {
  if (db.me && personById(db.me)) {
    if (name) personById(db.me).name = String(name).trim() || personById(db.me).name;
    return db.me;
  }
  db.me = ensurePerson(name || 'Me');
  return db.me;
}

/* Everything owed between me and one person, across every shared ledger. */
function overallWith(personId) {
  const totals = {};
  db.ledgers.forEach(l => {
    if (!l.members.includes(personId) || !l.members.includes(db.me)) return;
    const amt = pairNet(l, db.me, personId);
    if (amt) addTo(totals, l.currency, amt);
  });
  return totals;
}

/* My position across the lot. */
function overallMine() {
  const totals = {};
  db.ledgers.forEach(l => {
    if (!l.members.includes(db.me)) return;
    const amt = balances(l)[db.me] || 0;
    if (amt) addTo(totals, l.currency, amt);
  });
  return totals;
}

/* ------------------------------------------------------------------ utils */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
}

function colourFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 62%)`;
}

const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

const avatar = id =>
  `<span class="avatar" style="background:${colourFor(id)}">${esc(initials(realName(id)))}</span>`;

const badge = (label, colour) =>
  `<span class="avatar" style="background:${colour}">${esc(label)}</span>`;

/* ----------------------------------------------------------------- router */
function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [section, id, tab] = hash.split('/');
  return { section: section || 'home', id, tab };
}

const go = path => { location.hash = path; };
/* Swapping tabs should not stack up history entries, or Back walks
   through every tab you looked at instead of leaving the ledger. */
const goSameStep = path => location.replace(`${location.pathname}${location.search}#${path}`);
window.addEventListener('hashchange', render);

/* ----------------------------------------------------------------- render */
function render() {
  const { section, id, tab } = route();
  const app = document.getElementById('app');

  if (section === 'l' && ledgerById(id)) app.innerHTML = ledgerView(ledgerById(id), tab || 'expenses');
  else if (section === 'settings') app.innerHTML = settingsView();
  else app.innerHTML = homeView();

  window.scrollTo(0, 0);
}

function homeView() {
  const people = directLedgers();
  const groups = groupLedgers();
  const mine = overallMine();
  const sign = totalsSign(mine);
  const cls = sign === 1 ? 'pos' : sign === -1 ? 'neg' : sign === 2 ? '' : 'zero';

  const summary = (people.length || groups.length) ? `
    <div class="card summary">
      <span class="meta">Across everything</span>
      <strong class="${cls}">${esc(totalsText(mine, {
        owed: 'You are owed', owe: 'You owe', level: 'You are all settled up',
      }))}</strong>
    </div>` : '';

  const personRows = people.map(l => {
    const other = otherIn(l);
    /* The figure covers everything owed between the two of you, groups
       included, so the subtitle has to say when it is not just this tab. */
    const totals = overallWith(other);
    const s = totalsSign(totals);
    const alsoIn = db.ledgers.filter(x =>
      x.id !== l.id && x.members.includes(other) && x.members.includes(db.me)).length;
    return row({
      action: 'open-ledger', id: l.id,
      icon: avatar(other),
      title: realName(other),
      meta: alsoIn
        ? `This tab and ${alsoIn} shared group${alsoIn === 1 ? '' : 's'}`
        : `Just the two of you · ${l.expenses.length} ${l.expenses.length === 1 ? 'entry' : 'entries'}`,
      ...totalsCell(totals, { owed: 'owes you', owe: 'you owe', level: 'settled up' }),
      cls: s === 1 ? 'pos' : s === -1 ? 'neg' : s === 2 ? '' : 'zero',
    });
  }).join('');

  const groupRows = groups.map(l => {
    const amt = balances(l)[db.me] || 0;
    return row({
      action: 'open-ledger', id: l.id,
      icon: badge(initials(l.name), colourFor(l.id)),
      title: l.name,
      meta: `${l.members.length} people · ${money(l.expenses.reduce((a, e) => a + e.amount, 0), l.currency)} spent`,
      label: amt > 0 ? 'you are owed' : amt < 0 ? 'you owe' : '',
      value: amt === 0 ? 'settled up' : money(Math.abs(amt), l.currency),
      cls: amt > 0 ? 'pos' : amt < 0 ? 'neg' : 'zero',
    });
  }).join('');

  const body = (people.length || groups.length) ? `
    ${summary}
    ${people.length ? `<p class="section-title">People</p><div class="card">${personRows}</div>` : ''}
    ${groups.length ? `<p class="section-title">Groups</p><div class="card">${groupRows}</div>` : ''}`
    : emptyHome();

  return `
    <header class="topbar">
      <h1>Split<span class="sub">who paid for what</span></h1>
      <button class="icon-btn" data-action="settings">•••</button>
    </header>
    <main>
      ${body}
      ${installNote()}
    </main>
    <button class="fab" data-action="new-chooser">+ Add</button>`;
}

function row({ action, id, extra = '', icon, title, meta, label, value, cls }) {
  return `
    <button class="row" data-action="${action}" data-id="${id}" ${extra}>
      ${icon}
      <span class="grow">
        <span class="title">${esc(title)}</span>
        <span class="meta">${esc(meta)}</span>
      </span>
      ${amountCell(label, value, cls)}
      <span class="chev">›</span>
    </button>`;
}

const amountCell = (label, value, cls) => `
  <span class="amount ${cls || ''}">
    ${label ? `<span class="amount-label">${esc(label)}</span>` : ''}
    <span class="amount-value">${esc(value)}</span>
  </span>`;

function emptyHome() {
  return `
    <div class="empty">
      <div class="big">🧾</div>
      <p><strong>Nothing on the books</strong></p>
      <p>Add one person to keep a running tab between the two of you, or make a group for a trip, a flat or a night out.</p>
    </div>`;
}

function installNote() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (standalone) return '';
  return `<p class="install-note">Add to your Home Screen: tap <strong>Share</strong> in Safari, then <strong>Add to Home Screen</strong>. It then opens full screen and works offline.</p>`;
}

/* ------------------------------------------------------------ ledger view */
function ledgerView(l, tab) {
  const direct = l.kind === 'direct';
  const sub = direct
    ? `Just you and ${esc(realName(otherIn(l)))}`
    : l.members.map(id => esc(nameOf(id))).join(', ');

  return `
    <header class="topbar">
      <button class="icon-btn plain" data-action="back">‹ Back</button>
      <h1>${esc(ledgerTitle(l))}<span class="sub">${sub}</span></h1>
      <button class="icon-btn" data-action="ledger-settings" data-id="${l.id}">•••</button>
    </header>
    <main>
      <div class="tabs" role="tablist">
        <button role="tab" aria-selected="${tab !== 'balances'}" data-action="tab" data-tab="expenses">Expenses</button>
        <button role="tab" aria-selected="${tab === 'balances'}" data-action="tab" data-tab="balances">${direct ? 'Who owes who' : 'Balances'}</button>
      </div>
      ${tab === 'balances' ? balancesTab(l) : expensesTab(l)}
    </main>
    <button class="fab" data-action="add-expense" data-id="${l.id}">+ Expense</button>`;
}

function expensesTab(l) {
  const items = [
    ...l.expenses.map(e => ({ kind: 'expense', date: e.date, data: e })),
    ...(l.settlements || []).map(s => ({ kind: 'settlement', date: s.date, data: s })),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.data.id > a.data.id ? 1 : -1));

  if (!items.length) {
    return `<div class="empty">
      <div class="big">💸</div>
      <p><strong>Nothing logged yet</strong></p>
      <p>Add the first expense and Split works out who owes whom.</p>
    </div>`;
  }

  const total = l.expenses.reduce((a, e) => a + e.amount, 0);
  const rows = items.map(item => {
    if (item.kind === 'settlement') {
      const s = item.data;
      return `
        <button class="row" data-action="edit-settlement" data-id="${l.id}" data-sid="${s.id}">
          ${badge('✓', 'var(--bg-elev-2)')}
          <span class="grow">
            <span class="title">${esc(nameOf(s.from))} paid ${esc(nameOf(s.to))}</span>
            <span class="meta">Settlement · ${esc(formatDate(s.date))}</span>
          </span>
          ${amountCell('', money(s.amount, l.currency), '')}
          <span class="chev">›</span>
        </button>`;
    }
    const e = item.data;
    const share = sharesOf(e, l)[db.me] || 0;
    const mine = (e.paidBy === db.me ? e.amount : 0) - share;
    return `
      <button class="row" data-action="edit-expense" data-id="${l.id}" data-eid="${e.id}">
        ${avatar(e.paidBy)}
        <span class="grow">
          <span class="title">${esc(e.description || 'Expense')}</span>
          <span class="meta">${esc(nameOf(e.paidBy))} paid ${money(e.amount, l.currency)} · ${esc(formatDate(e.date))}</span>
        </span>
        ${amountCell(
          mine > 0 ? 'you lent' : mine < 0 ? 'you owe' : '',
          mine === 0 ? 'not involved' : money(Math.abs(mine), l.currency),
          mine > 0 ? 'pos' : mine < 0 ? 'neg' : 'zero')}
        <span class="chev">›</span>
      </button>`;
  }).join('');

  return `
    <p class="section-title">${money(total, l.currency)} spent in total</p>
    <div class="card">${rows}</div>`;
}

function balancesTab(l) {
  const net = balances(l);
  const rows = l.members.map(id => {
    const amt = net[id] || 0;
    const me = id === db.me;
    const phrase = amt > 0 ? (me ? 'You are owed' : `${realName(id)} is owed`)
      : amt < 0 ? (me ? 'You owe' : `${realName(id)} owes`)
      : (me ? 'You are settled up' : `${realName(id)} is settled up`);
    return `
      <div class="bal">
        ${avatar(id)}
        <span class="grow"><span class="title">${esc(phrase)}</span></span>
        <span class="amount ${amt > 0 ? 'pos' : amt < 0 ? 'neg' : 'zero'}">${amt === 0 ? '—' : money(Math.abs(amt), l.currency)}</span>
      </div>`;
  }).join('');

  const transfers = settleUp(l);
  const settleCard = transfers.length ? `
    <p class="section-title">Simplest way to settle</p>
    <div class="card">
      ${transfers.map(t => `
        <div class="settle-row">
          <span class="txt"><strong>${esc(nameOf(t.from))}</strong> <span class="arrow">→</span> <strong>${esc(nameOf(t.to))}</strong></span>
          <span class="amount">${money(t.amount, l.currency)}</span>
          <button class="btn small" data-action="record-payment" data-id="${l.id}"
            data-from="${t.from}" data-to="${t.to}" data-amount="${t.amount}">Settle</button>
        </div>`).join('')}
    </div>
    <p class="hint">${transfers.length} payment${transfers.length === 1 ? '' : 's'} clears every debt here.</p>`
    : `<p class="section-title">Settle up</p>
       <div class="card"><div class="hint">Everyone is square. Nothing to pay.</div></div>`;

  return `
    <p class="section-title">${l.kind === 'direct' ? 'Between you' : 'Balances'}</p>
    <div class="card">${rows}</div>
    ${settleCard}
    ${elsewhereCard(l)}
    <div class="btn-stack">
      <button class="btn secondary" data-action="record-payment" data-id="${l.id}">Record a payment</button>
      <button class="btn secondary" data-action="share-summary" data-id="${l.id}">Share summary</button>
    </div>`;
}

/* On a one-to-one tab, show what the same person owes you elsewhere. */
function elsewhereCard(l) {
  if (l.kind !== 'direct') return '';
  const other = otherIn(l);
  const shared = db.ledgers.filter(x =>
    x.id !== l.id && x.members.includes(other) && x.members.includes(db.me));
  if (!shared.length) return '';

  const rows = shared.map(x => {
    const amt = pairNet(x, db.me, other);
    return `
      <button class="row" data-action="open-ledger" data-id="${x.id}">
        ${badge(initials(ledgerTitle(x)), colourFor(x.id))}
        <span class="grow">
          <span class="title">${esc(ledgerTitle(x))}</span>
          <span class="meta">${esc(x.kind === 'direct' ? 'One to one' : 'Group')}</span>
        </span>
        ${amountCell(
          amt > 0 ? 'owes you' : amt < 0 ? 'you owe' : '',
          amt === 0 ? 'settled up' : money(Math.abs(amt), x.currency),
          amt > 0 ? 'pos' : amt < 0 ? 'neg' : 'zero')}
        <span class="chev">›</span>
      </button>`;
  }).join('');

  const totals = overallWith(other);
  return `
    <p class="section-title">${esc(realName(other))} elsewhere</p>
    <div class="card">${rows}</div>
    <p class="hint">Counting everything, ${esc(realName(other))} ${esc(totalsText(totals, {
      owed: 'owes you', owe: 'is owed by you', level: 'is settled up with you',
    }))}. Debts in different groups are kept apart until someone actually pays.</p>`;
}

function settingsView() {
  const entries = db.ledgers.reduce((a, l) => a + l.expenses.length, 0);
  const myName = db.me ? realName(db.me) : '';
  return `
    <header class="topbar">
      <button class="icon-btn plain" data-action="back">‹ Back</button>
      <h1>Settings</h1>
    </header>
    <main>
      ${db.me ? `<div class="card">
        <div class="field">
          <label for="my-name">Your name</label>
          <input id="my-name" value="${esc(myName)}" autocomplete="off">
        </div>
        <div class="field"><button class="btn small" data-action="save-my-name">Save name</button></div>
      </div>` : ''}
      <div class="card"><div class="hint">${directLedgers().length} ${directLedgers().length === 1 ? 'person' : 'people'}, ${groupLedgers().length} group${groupLedgers().length === 1 ? '' : 's'} and ${entries} expense${entries === 1 ? '' : 's'}, stored on this device only. Nothing is uploaded anywhere.</div></div>
      <div class="btn-stack">
        <button class="btn secondary" data-action="export">Export a backup</button>
        <button class="btn secondary" data-action="import">Restore from a backup</button>
        <button class="btn danger" data-action="wipe">Delete everything</button>
      </div>
      ${installNote()}
    </main>`;
}

/* ------------------------------------------------------------------ sheet */
function openSheet(html) {
  const sheet = document.getElementById('sheet');
  sheet.querySelector('.sheet-panel').innerHTML = `<div class="grabber"></div>${html}`;
  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  const first = sheet.querySelector('[data-autofocus="yes"]');
  if (first) setTimeout(() => first.focus(), 120);
}

function closeSheet() {
  const sheet = document.getElementById('sheet');
  sheet.hidden = true;
  sheet.querySelector('.sheet-panel').innerHTML = '';
  document.body.style.overflow = '';
}

const sheetHead = title =>
  `<div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close>Close</button></div>`;

const currencyOptions = selected => CURRENCIES.map(c =>
  `<option value="${c.code}" ${c.code === selected ? 'selected' : ''}>${c.code} (${c.symbol.trim()})</option>`).join('');

/* Shown once, the first time anything is created. */
const myNameField = () => db.me ? '' : `
  <div class="field">
    <label for="my-name-new">Your name</label>
    <input id="my-name-new" placeholder="Your name" autocomplete="off">
  </div>`;

const peopleDatalist = () => `
  <datalist id="known-people">
    ${db.people.filter(p => p.id !== db.me).map(p => `<option value="${esc(p.name)}"></option>`).join('')}
  </datalist>`;

function chooserSheet() {
  openSheet(`
    ${sheetHead('Add')}
    <div class="btn-stack" style="margin-top:4px">
      <button class="btn" data-action="new-person">One person</button>
      <button class="btn secondary" data-action="new-group">A group</button>
    </div>
    <p class="hint">A person is a running tab between the two of you. A group is for three or more sharing the same trip, flat or night out.</p>`);
}

/* ------------------------------------------------------------- person form */
function personSheet() {
  openSheet(`
    ${sheetHead('Split with one person')}
    <div class="card">
      ${myNameField()}
      <div class="field">
        <label for="p-name">Their name</label>
        <input id="p-name" data-autofocus="yes" list="known-people" placeholder="Sam" autocomplete="off">
      </div>
      <div class="field">
        <label for="p-cur">Currency</label>
        <select id="p-cur">${currencyOptions('GBP')}</select>
      </div>
    </div>
    ${peopleDatalist()}
    <div class="btn-stack">
      <button class="btn" data-action="save-person">Start the tab</button>
    </div>
    <p class="hint">Type a name you have used before and it will be treated as the same person, so their total adds up across your groups too.</p>`);
}

function savePerson() {
  const theirName = document.getElementById('p-name').value.trim();
  if (!theirName) return toast('Give them a name');

  const myName = document.getElementById('my-name-new')?.value.trim();
  if (!db.me && !myName) return toast('Add your own name too');
  const me = ensureMe(myName);

  const them = ensurePerson(theirName);
  if (them === me) return toast('That is you — use a different name');

  const existing = directLedgers().find(l => l.members.includes(them));
  if (existing) { closeSheet(); go(`/l/${existing.id}`); return toast('You already have a tab with them'); }

  const ledger = {
    id: uid(), kind: 'direct', name: '',
    currency: document.getElementById('p-cur').value,
    members: [me, them], expenses: [], settlements: [], created: todayISO(),
  };
  db.ledgers.unshift(ledger);
  save();
  closeSheet();
  go(`/l/${ledger.id}`);
  render();
}

/* ------------------------------------------------------------- group form */
function groupSheet(existing) {
  const l = existing || { name: '', currency: 'GBP', members: [] };
  const others = l.members.filter(id => id !== db.me);
  const fields = others.length ? others : [null, null];

  openSheet(`
    ${sheetHead(existing ? 'Group settings' : 'New group')}
    <div class="card">
      ${myNameField()}
      <div class="field">
        <label for="g-name">Group name</label>
        <input id="g-name" ${db.me ? 'data-autofocus="yes"' : ''} placeholder="Lisbon trip" value="${esc(l.name)}" autocomplete="off">
      </div>
      <div class="field">
        <label for="g-cur">Currency</label>
        <select id="g-cur">${currencyOptions(l.currency)}</select>
      </div>
    </div>

    <p class="section-title">Who else is in it</p>
    <div class="card" id="member-list">
      ${fields.map(id => memberField(id)).join('')}
    </div>
    ${peopleDatalist()}
    <div class="btn-stack">
      <button class="btn secondary" data-action="add-member-field">+ Add another person</button>
      <button class="btn" data-action="save-group" data-id="${existing ? existing.id : ''}">${existing ? 'Save changes' : 'Create group'}</button>
      ${existing ? `<button class="btn danger" data-action="delete-ledger" data-id="${existing.id}">Delete group</button>` : ''}
    </div>
    <p class="hint">You are in it automatically. Clear a name to drop that person — anyone already on an expense stays. Renaming someone renames them everywhere.</p>`);
}

function memberField(personId) {
  return `
    <div class="field member-field" data-pid="${personId || ''}">
      <label>Name</label>
      <input class="member-name" list="known-people" placeholder="Name" value="${esc(personId ? realName(personId) : '')}" autocomplete="off">
    </div>`;
}

function saveGroup(id) {
  const name = document.getElementById('g-name').value.trim();
  if (!name) return toast('Give the group a name');

  const myName = document.getElementById('my-name-new')?.value.trim();
  if (!db.me && !myName) return toast('Add your own name too');
  const me = ensureMe(myName);

  const currency = document.getElementById('g-cur').value;
  const typed = [...document.querySelectorAll('.member-field')].map(f => ({
    pid: f.dataset.pid,
    name: f.querySelector('.member-name').value.trim(),
  })).filter(m => m.name);

  const members = [me];
  typed.forEach(m => {
    /* An existing member keeps their identity, so renaming here renames
       them everywhere rather than creating a stranger with a new name. */
    let pid = m.pid && personById(m.pid) ? m.pid : ensurePerson(m.name);
    if (m.pid && personById(m.pid)) personById(m.pid).name = m.name;
    if (pid && !members.includes(pid)) members.push(pid);
  });

  if (members.length < 3) return toast('A group needs at least two other people — use One person otherwise');

  if (id) {
    const l = ledgerById(id);
    const used = new Set();
    l.expenses.forEach(e => { used.add(e.paidBy); (e.participants || []).forEach(p => used.add(p)); });
    (l.settlements || []).forEach(s => { used.add(s.from); used.add(s.to); });
    const stuck = l.members.filter(pid => !members.includes(pid) && used.has(pid));
    l.members = [...members, ...stuck];
    l.name = name;
    l.currency = currency;
    if (stuck.length) toast(`${stuck.map(realName).join(', ')} kept — still on an expense`);
  } else {
    db.ledgers.unshift({
      id: uid(), kind: 'group', name, currency, members,
      expenses: [], settlements: [], created: todayISO(),
    });
  }
  save();
  closeSheet();
  render();
}

/* ----------------------------------------------------------- expense form */
function expenseSheet(l, existing) {
  const e = existing || {
    id: '', description: '', amount: 0, paidBy: db.me,
    mode: 'equal', participants: [...l.members], weights: {},
    date: todayISO(), category: 'General',
  };

  openSheet(`
    ${sheetHead(existing ? 'Edit expense' : 'New expense')}
    <div class="card">
      <div class="field">
        <label for="e-desc">What was it for?</label>
        <input id="e-desc" data-autofocus="yes" placeholder="Dinner at Ramiro" value="${esc(e.description)}" autocomplete="off">
      </div>
      <div class="field">
        <label for="e-amount">Amount</label>
        <div class="inline">
          <span class="prefix">${esc(symbolFor(l.currency).trim())}</span>
          <input id="e-amount" class="amount-input" inputmode="decimal" placeholder="0.00"
            value="${e.amount ? (e.amount / 100).toFixed(2) : ''}">
        </div>
      </div>
      <div class="field">
        <label for="e-paid">Paid by</label>
        <select id="e-paid">
          ${l.members.map(id => `<option value="${id}" ${id === e.paidBy ? 'selected' : ''}>${esc(nameOf(id))}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="e-date">Date</label>
        <input id="e-date" type="date" value="${esc(e.date)}">
      </div>
      <div class="field">
        <label for="e-cat">Category</label>
        <select id="e-cat">
          ${CATEGORIES.map(c => `<option ${c === e.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
      </div>
    </div>

    <p class="section-title">Split between</p>
    <div class="card">
      <div class="field">
        <div class="chips" id="e-people">
          ${l.members.map(id => `
            <button type="button" class="chip" data-action="toggle-person" data-mid="${id}"
              aria-pressed="${e.participants.includes(id)}">${esc(nameOf(id))}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label for="e-mode">How</label>
        <select id="e-mode">
          <option value="equal" ${e.mode === 'equal' ? 'selected' : ''}>Equally</option>
          <option value="exact" ${e.mode === 'exact' ? 'selected' : ''}>Exact amounts</option>
          <option value="shares" ${e.mode === 'shares' ? 'selected' : ''}>By shares</option>
        </select>
      </div>
      <div id="e-split"></div>
    </div>

    <div class="btn-stack">
      <button class="btn" data-action="save-expense" data-id="${l.id}" data-eid="${e.id}">${existing ? 'Save changes' : 'Add expense'}</button>
      ${existing ? `<button class="btn danger" data-action="delete-expense" data-id="${l.id}" data-eid="${e.id}">Delete expense</button>` : ''}
    </div>`);

  const panel = document.querySelector('.sheet-panel');
  panel.dataset.weights = JSON.stringify(e.weights || {});
  renderSplit(l);
  panel.querySelector('#e-mode').addEventListener('change', () => renderSplit(l));
  panel.querySelector('#e-amount').addEventListener('input', () => {
    renderSplit(l, panel.querySelector('#e-mode').value !== 'equal');
  });
}

const selectedPeople = () =>
  [...document.querySelectorAll('#e-people .chip[aria-pressed="true"]')].map(c => c.dataset.mid);

function currentWeights() {
  try { return JSON.parse(document.querySelector('.sheet-panel').dataset.weights || '{}'); }
  catch { return {}; }
}

const stashWeights = w => {
  document.querySelector('.sheet-panel').dataset.weights = JSON.stringify(w);
};

/* Re-draw the per-person split rows for the chosen mode. */
function renderSplit(l, keepInputs) {
  const host = document.getElementById('e-split');
  if (!host) return;
  const mode = document.getElementById('e-mode').value;
  const ids = selectedPeople();
  const total = parseAmount(document.getElementById('e-amount').value) || 0;

  if (!keepInputs) {
    const live = {};
    document.querySelectorAll('.split-input').forEach(inp => { live[inp.dataset.mid] = inp.value; });
    const weights = currentWeights();
    Object.entries(live).forEach(([id, v]) => {
      const n = mode === 'exact' ? parseAmount(v) : Number(v);
      if (v !== '' && Number.isFinite(n)) weights[id] = n;
    });
    stashWeights(weights);
  }

  if (!ids.length) {
    host.innerHTML = `<div class="hint bad">Pick at least one person to split between.</div>`;
    return;
  }

  if (mode === 'equal') {
    const preview = sharesOf({ amount: total, mode: 'equal', participants: ids, weights: {} }, l);
    host.innerHTML = ids.map(id => `
      <div class="split-line">
        <span class="grow">${esc(nameOf(id))}</span>
        <span class="amount">${money(preview[id] || 0, l.currency)}</span>
      </div>`).join('') +
      `<div class="hint">${money(total, l.currency)} split ${ids.length} ${ids.length === 1 ? 'way' : 'ways'}. Odd pennies go to the first people in the list.</div>`;
    return;
  }

  const weights = currentWeights();
  if (mode === 'exact') {
    const entered = ids.reduce((a, id) => a + (Number(weights[id]) || 0), 0);
    const diff = total - entered;
    host.innerHTML = ids.map(id => `
      <div class="split-line">
        <span class="grow">${esc(nameOf(id))}</span>
        <input class="split-input" data-mid="${id}" inputmode="decimal" placeholder="0.00"
          value="${weights[id] ? (weights[id] / 100).toFixed(2) : ''}">
      </div>`).join('') +
      `<div class="hint ${diff === 0 ? '' : 'bad'}">${diff === 0
        ? 'Exactly right.'
        : `${money(Math.abs(diff), l.currency)} ${diff > 0 ? 'left to assign' : 'over the total'}.`}</div>`;
  } else {
    const ws = ids.map(id => Math.max(0, Number(weights[id] ?? 1)));
    const preview = allocate(total, ws.some(w => w > 0) ? ws : ids.map(() => 1));
    host.innerHTML = ids.map((id, i) => `
      <div class="split-line">
        <span class="grow">${esc(nameOf(id))}<span class="meta">${money(preview[i], l.currency)}</span></span>
        <input class="split-input" data-mid="${id}" inputmode="numeric" placeholder="1"
          value="${weights[id] ?? 1}">
      </div>`).join('') +
      `<div class="hint">Shares can be anything — 1 and 2 means the second person pays twice as much.</div>`;
  }

  host.querySelectorAll('.split-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const w = currentWeights();
      const n = mode === 'exact' ? parseAmount(inp.value) : Number(inp.value);
      w[inp.dataset.mid] = Number.isFinite(n) ? n : 0;
      stashWeights(w);
      refreshSplitHint(l, mode, ids, w);
    });
  });
}

/* Cheap update of just the footer line so typing never loses focus. */
function refreshSplitHint(l, mode, ids, weights) {
  const host = document.getElementById('e-split');
  const hint = host.querySelector('.hint');
  const total = parseAmount(document.getElementById('e-amount').value) || 0;
  if (mode === 'exact') {
    const entered = ids.reduce((a, id) => a + (Number(weights[id]) || 0), 0);
    const diff = total - entered;
    hint.className = 'hint' + (diff === 0 ? '' : ' bad');
    hint.textContent = diff === 0 ? 'Exactly right.'
      : `${money(Math.abs(diff), l.currency)} ${diff > 0 ? 'left to assign' : 'over the total'}.`;
  } else {
    const ws = ids.map(id => Math.max(0, Number(weights[id] ?? 1)));
    const preview = allocate(total, ws.some(w => w > 0) ? ws : ids.map(() => 1));
    host.querySelectorAll('.split-line').forEach((line, i) => {
      const meta = line.querySelector('.meta');
      if (meta) meta.textContent = money(preview[i], l.currency);
    });
  }
}

function saveExpense(lid, eid) {
  const l = ledgerById(lid);
  const description = document.getElementById('e-desc').value.trim();
  const amount = parseAmount(document.getElementById('e-amount').value);
  const paidBy = document.getElementById('e-paid').value;
  const date = document.getElementById('e-date').value || todayISO();
  const category = document.getElementById('e-cat').value;
  const mode = document.getElementById('e-mode').value;
  const participants = selectedPeople();

  if (!amount || amount <= 0) return toast('Enter an amount above zero');
  if (!participants.length) return toast('Pick who it is split between');

  const weights = {};
  if (mode !== 'equal') {
    const stored = currentWeights();
    participants.forEach(id => { weights[id] = Number(stored[id] ?? (mode === 'shares' ? 1 : 0)) || 0; });
    if (mode === 'exact') {
      const sum = participants.reduce((a, id) => a + weights[id], 0);
      if (sum !== amount) return toast('The exact amounts must add up to the total');
    }
    if (mode === 'shares' && participants.every(id => weights[id] <= 0)) {
      return toast('Give at least one person a share');
    }
  }

  const record = {
    id: eid || uid(),
    description: description || 'Expense',
    amount, paidBy, date, category, mode, participants, weights,
  };

  if (eid) {
    const i = l.expenses.findIndex(x => x.id === eid);
    if (i >= 0) l.expenses[i] = record; else l.expenses.push(record);
  } else {
    l.expenses.push(record);
  }
  save();
  closeSheet();
  render();
  toast(eid ? 'Expense updated' : 'Expense added');
}

/* -------------------------------------------------------- settlement form */
function paymentSheet(l, preset, existing) {
  const s = existing || preset || {
    from: db.me, to: l.members.find(id => id !== db.me), amount: 0, date: todayISO(),
  };
  const opts = who => l.members.map(id =>
    `<option value="${id}" ${id === who ? 'selected' : ''}>${esc(nameOf(id))}</option>`).join('');

  openSheet(`
    ${sheetHead(existing ? 'Edit payment' : 'Record a payment')}
    <div class="card">
      <div class="field">
        <label for="s-from">Who paid</label>
        <select id="s-from">${opts(s.from)}</select>
      </div>
      <div class="field">
        <label for="s-to">Who received it</label>
        <select id="s-to">${opts(s.to)}</select>
      </div>
      <div class="field">
        <label for="s-amount">Amount</label>
        <div class="inline">
          <span class="prefix">${esc(symbolFor(l.currency).trim())}</span>
          <input id="s-amount" class="amount-input" inputmode="decimal" placeholder="0.00"
            value="${s.amount ? (s.amount / 100).toFixed(2) : ''}">
        </div>
      </div>
      <div class="field">
        <label for="s-date">Date</label>
        <input id="s-date" type="date" value="${esc(s.date || todayISO())}">
      </div>
    </div>
    <div class="btn-stack">
      <button class="btn" data-action="save-payment" data-id="${l.id}" data-sid="${existing ? existing.id : ''}">Save payment</button>
      ${existing ? `<button class="btn danger" data-action="delete-payment" data-id="${l.id}" data-sid="${existing.id}">Delete payment</button>` : ''}
    </div>`);
}

function savePayment(lid, sid) {
  const l = ledgerById(lid);
  const from = document.getElementById('s-from').value;
  const to = document.getElementById('s-to').value;
  const amount = parseAmount(document.getElementById('s-amount').value);
  const date = document.getElementById('s-date').value || todayISO();

  if (from === to) return toast('Pick two different people');
  if (!amount || amount <= 0) return toast('Enter an amount above zero');

  l.settlements = l.settlements || [];
  const record = { id: sid || uid(), from, to, amount, date };
  if (sid) {
    const i = l.settlements.findIndex(x => x.id === sid);
    if (i >= 0) l.settlements[i] = record; else l.settlements.push(record);
  } else {
    l.settlements.push(record);
  }
  save();
  closeSheet();
  render();
  toast('Payment recorded');
}

/* ------------------------------------------------------------ share / i-o */
function summaryText(l) {
  const net = balances(l);
  const lines = [
    `${ledgerTitle(l)} — ${money(l.expenses.reduce((a, e) => a + e.amount, 0), l.currency)} spent`, '',
  ];
  l.members.forEach(id => {
    const amt = net[id] || 0;
    lines.push(amt > 0 ? `${realName(id)} is owed ${money(amt, l.currency)}`
      : amt < 0 ? `${realName(id)} owes ${money(-amt, l.currency)}`
      : `${realName(id)} is settled up`);
  });
  const transfers = settleUp(l);
  if (transfers.length) {
    lines.push('', 'To settle up:');
    transfers.forEach(t => lines.push(`${realName(t.from)} → ${realName(t.to)}: ${money(t.amount, l.currency)}`));
  }
  return lines.join('\n');
}

async function shareSummary(l) {
  const text = summaryText(l);
  try {
    if (navigator.share) { await navigator.share({ title: ledgerTitle(l), text }); return; }
    await navigator.clipboard.writeText(text);
    toast('Summary copied');
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    toast('Could not share the summary');
  }
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `split-backup-${todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function importBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const next = Array.isArray(parsed?.ledgers) ? parsed
        : Array.isArray(parsed?.groups) ? migrate(parsed) : null;
      if (!next) throw new Error('bad file');
      if (!confirm('Replace everything on this device with the backup?')) return;
      db = next;
      save();
      go('/');
      render();
      toast('Backup restored');
    } catch {
      toast('That file is not a Split backup');
    }
  };
  input.click();
}

/* ---------------------------------------------------------------- actions */
document.addEventListener('click', ev => {
  if (ev.target.closest('[data-close]')) { closeSheet(); return; }

  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const { action, id, eid, sid, tab } = el.dataset;
  const l = id ? ledgerById(id) : null;

  switch (action) {
    case 'back': go('/'); break;
    case 'settings': go('/settings'); break;
    case 'new-chooser': chooserSheet(); break;
    case 'new-person': personSheet(); break;
    case 'new-group': groupSheet(null); break;
    case 'save-person': savePerson(); break;
    case 'open-ledger': go(`/l/${id}`); break;
    case 'tab': goSameStep(`/l/${route().id}/${tab}`); break;

    case 'ledger-settings':
      if (l.kind === 'direct') directSheet(l); else groupSheet(l);
      break;
    case 'add-member-field': {
      document.getElementById('member-list').insertAdjacentHTML('beforeend', memberField(null));
      const fields = document.querySelectorAll('.member-field .member-name');
      fields[fields.length - 1].focus();
      break;
    }
    case 'save-group': saveGroup(id || ''); break;
    case 'save-direct': saveDirect(id); break;
    case 'delete-ledger':
      if (confirm('Delete this and everything in it?')) {
        db.ledgers = db.ledgers.filter(x => x.id !== id);
        save(); closeSheet(); go('/'); render();
      }
      break;

    case 'add-expense': expenseSheet(l, null); break;
    case 'edit-expense': expenseSheet(l, l.expenses.find(x => x.id === eid)); break;
    case 'save-expense': saveExpense(id, eid); break;
    case 'delete-expense':
      if (confirm('Delete this expense?')) {
        l.expenses = l.expenses.filter(x => x.id !== eid);
        save(); closeSheet(); render();
      }
      break;
    case 'toggle-person': {
      el.setAttribute('aria-pressed', String(el.getAttribute('aria-pressed') !== 'true'));
      renderSplit(ledgerById(route().id));
      break;
    }

    case 'record-payment':
      paymentSheet(l, el.dataset.from
        ? { from: el.dataset.from, to: el.dataset.to, amount: Number(el.dataset.amount), date: todayISO() }
        : null);
      break;
    case 'edit-settlement': paymentSheet(l, null, (l.settlements || []).find(x => x.id === sid)); break;
    case 'save-payment': savePayment(id, sid); break;
    case 'delete-payment':
      if (confirm('Delete this payment?')) {
        l.settlements = (l.settlements || []).filter(x => x.id !== sid);
        save(); closeSheet(); render();
      }
      break;

    case 'share-summary': shareSummary(l); break;
    case 'export': exportBackup(); break;
    case 'import': importBackup(); break;
    case 'save-my-name': {
      const value = document.getElementById('my-name').value.trim();
      if (!value) return toast('Your name cannot be blank');
      personById(db.me).name = value;
      save(); render(); toast('Name saved');
      break;
    }
    case 'wipe':
      if (confirm('Delete everything on this device? This cannot be undone.')) {
        db = blank();
        localStorage.removeItem(LEGACY_KEY);
        save(); go('/'); render(); toast('Everything deleted');
      }
      break;
  }
});

/* One-to-one settings: rename the person, change the currency, delete. */
function directSheet(l) {
  const other = otherIn(l);
  openSheet(`
    ${sheetHead('Tab settings')}
    <div class="card">
      <div class="field">
        <label for="d-name">Their name</label>
        <input id="d-name" data-autofocus="yes" value="${esc(realName(other))}" autocomplete="off">
      </div>
      <div class="field">
        <label for="d-cur">Currency</label>
        <select id="d-cur">${currencyOptions(l.currency)}</select>
      </div>
    </div>
    <div class="btn-stack">
      <button class="btn" data-action="save-direct" data-id="${l.id}">Save changes</button>
      <button class="btn danger" data-action="delete-ledger" data-id="${l.id}">Delete this tab</button>
    </div>
    <p class="hint">Renaming them here renames them in your groups too.</p>`);
}

function saveDirect(id) {
  const l = ledgerById(id);
  const name = document.getElementById('d-name').value.trim();
  if (!name) return toast('Give them a name');
  personById(otherIn(l)).name = name;
  l.currency = document.getElementById('d-cur').value;
  save();
  closeSheet();
  render();
}

/* ------------------------------------------------------------------- boot */
render();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
})();
