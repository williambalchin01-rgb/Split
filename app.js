/* Split — a home-screen expense splitter. No build step, no backend. */
(() => {
'use strict';

/* ---------------------------------------------------------------- storage */
const KEY = 'split.v1';
const CURRENCIES = [
  { code: 'GBP', symbol: '£' }, { code: 'EUR', symbol: '€' },
  { code: 'USD', symbol: '$' }, { code: 'AUD', symbol: 'A$' },
  { code: 'CAD', symbol: 'C$' }, { code: 'CHF', symbol: 'CHF ' },
  { code: 'JPY', symbol: '¥' }, { code: 'SEK', symbol: 'kr ' },
];
const CATEGORIES = ['General', 'Food & drink', 'Groceries', 'Travel', 'Accommodation', 'Tickets', 'Shopping', 'Utilities'];

const blank = () => ({ version: 1, groups: [] });

let db = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.groups)) return blank();
    return parsed;
  } catch (err) {
    console.warn('Could not read saved data', err);
    return blank();
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch (err) {
    toast('Could not save — storage is full or blocked');
  }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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

/* Split `total` into `weights.length` parts in proportion to the weights,
   handing the leftover pence to the largest remainders first. */
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

/* Who owes what for one expense: { memberId: pence }. */
function sharesOf(expense, group) {
  const ids = (expense.participants || []).filter(id => group.members.some(m => m.id === id));
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

/* Net position per member: positive = they are owed, negative = they owe. */
function balances(group) {
  const net = {};
  group.members.forEach(m => { net[m.id] = 0; });

  group.expenses.forEach(e => {
    if (net[e.paidBy] === undefined) return;
    net[e.paidBy] += e.amount;
    const shares = sharesOf(e, group);
    Object.entries(shares).forEach(([id, amt]) => {
      if (net[id] !== undefined) net[id] -= amt;
    });
  });

  (group.settlements || []).forEach(s => {
    if (net[s.from] !== undefined) net[s.from] += s.amount;
    if (net[s.to] !== undefined) net[s.to] -= s.amount;
  });

  return net;
}

/* Fewest transfers that clear the board: biggest debtor pays biggest creditor. */
function settleUp(group) {
  const net = balances(group);
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

/* ------------------------------------------------------------------ utils */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const group = id => db.groups.find(g => g.id === id);
const memberOf = (g, id) => g.members.find(m => m.id === id);

function nameOf(g, id) {
  const m = memberOf(g, id);
  if (!m) return 'Someone';
  return m.id === g.meId ? 'You' : m.name;
}

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

const avatar = (g, id) =>
  `<span class="avatar" style="background:${colourFor(id)}">${esc(initials(memberOf(g, id)?.name || '?'))}</span>`;

/* ----------------------------------------------------------------- router */
function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [section, id, tab] = hash.split('/');
  return { section: section || 'groups', id, tab };
}

const go = path => { location.hash = path; };

window.addEventListener('hashchange', render);

/* ----------------------------------------------------------------- render */
function render() {
  const { section, id, tab } = route();
  const app = document.getElementById('app');

  if (section === 'g' && group(id)) app.innerHTML = groupView(group(id), tab || 'expenses');
  else if (section === 'settings') app.innerHTML = settingsView();
  else app.innerHTML = groupsView();

  window.scrollTo(0, 0);
}

function groupsView() {
  const rows = db.groups.map(g => {
    const net = balances(g);
    const mine = g.meId ? (net[g.meId] || 0) : 0;
    let note = 'All settled up';
    let cls = 'zero';
    if (mine > 0) { note = `you are owed ${money(mine, g.currency)}`; cls = 'pos'; }
    else if (mine < 0) { note = `you owe ${money(-mine, g.currency)}`; cls = 'neg'; }
    const total = g.expenses.reduce((a, e) => a + e.amount, 0);
    return `
      <button class="row" data-action="open-group" data-id="${g.id}">
        <span class="avatar" style="background:${colourFor(g.id)}">${esc(initials(g.name))}</span>
        <span class="grow">
          <span class="title">${esc(g.name)}</span>
          <span class="meta">${g.members.length} ${g.members.length === 1 ? 'person' : 'people'} · ${money(total, g.currency)} spent</span>
        </span>
        <span class="amount ${cls}">${esc(note)}</span>
        <span class="chev">›</span>
      </button>`;
  }).join('');

  return `
    <header class="topbar">
      <h1>Split<span class="sub">who paid for what</span></h1>
      <button class="icon-btn" data-action="settings">•••</button>
    </header>
    <main>
      ${db.groups.length ? `<div class="card">${rows}</div>` : emptyGroups()}
      ${installNote()}
    </main>
    <button class="fab" data-action="new-group">+ New group</button>`;
}

function emptyGroups() {
  return `
    <div class="empty">
      <div class="big">🧾</div>
      <p><strong>No groups yet</strong></p>
      <p>Make one for a trip, a flat or a night out, add who is in it, then log what everyone pays.</p>
    </div>`;
}

function installNote() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (standalone) return '';
  return `<p class="install-note">Add to your Home Screen: tap <strong>Share</strong> in Safari, then <strong>Add to Home Screen</strong>. It then opens full screen and works offline.</p>`;
}

function groupView(g, tab) {
  const body = tab === 'balances' ? balancesTab(g) : expensesTab(g);
  return `
    <header class="topbar">
      <button class="icon-btn plain" data-action="back">‹ Groups</button>
      <h1>${esc(g.name)}<span class="sub">${g.members.map(m => esc(m.id === g.meId ? 'You' : m.name)).join(', ')}</span></h1>
      <button class="icon-btn" data-action="group-settings" data-id="${g.id}">•••</button>
    </header>
    <main>
      <div class="tabs" role="tablist">
        <button role="tab" aria-selected="${tab !== 'balances'}" data-action="tab" data-tab="expenses">Expenses</button>
        <button role="tab" aria-selected="${tab === 'balances'}" data-action="tab" data-tab="balances">Balances</button>
      </div>
      ${body}
    </main>
    <button class="fab" data-action="add-expense" data-id="${g.id}">+ Expense</button>`;
}

function expensesTab(g) {
  const items = [
    ...g.expenses.map(e => ({ kind: 'expense', date: e.date, data: e })),
    ...(g.settlements || []).map(s => ({ kind: 'settlement', date: s.date, data: s })),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.data.id > a.data.id ? 1 : -1));

  if (!items.length) {
    return `<div class="empty">
      <div class="big">💸</div>
      <p><strong>Nothing logged yet</strong></p>
      <p>Add the first expense and Split works out who owes whom.</p>
    </div>`;
  }

  const total = g.expenses.reduce((a, e) => a + e.amount, 0);
  const rows = items.map(item => {
    if (item.kind === 'settlement') {
      const s = item.data;
      return `
        <button class="row" data-action="edit-settlement" data-id="${g.id}" data-sid="${s.id}">
          <span class="avatar" style="background:var(--bg-elev-2);color:var(--text)">✓</span>
          <span class="grow">
            <span class="title">${esc(nameOf(g, s.from))} paid ${esc(nameOf(g, s.to))}</span>
            <span class="meta">Settlement · ${esc(formatDate(s.date))}</span>
          </span>
          <span class="amount">${money(s.amount, g.currency)}</span>
          <span class="chev">›</span>
        </button>`;
    }
    const e = item.data;
    const share = sharesOf(e, g)[g.meId] || 0;
    const mine = (e.paidBy === g.meId ? e.amount : 0) - share;
    const note = mine > 0 ? `you lent ${money(mine, g.currency)}`
      : mine < 0 ? `you owe ${money(-mine, g.currency)}`
      : 'not involved';
    const cls = mine > 0 ? 'pos' : mine < 0 ? 'neg' : 'zero';
    return `
      <button class="row" data-action="edit-expense" data-id="${g.id}" data-eid="${e.id}">
        ${avatar(g, e.paidBy)}
        <span class="grow">
          <span class="title">${esc(e.description || 'Expense')}</span>
          <span class="meta">${esc(nameOf(g, e.paidBy))} paid ${money(e.amount, g.currency)} · ${esc(formatDate(e.date))}</span>
        </span>
        <span class="amount ${cls}">${esc(note)}</span>
        <span class="chev">›</span>
      </button>`;
  }).join('');

  return `
    <p class="section-title">${money(total, g.currency)} spent in total</p>
    <div class="card">${rows}</div>`;
}

function balancesTab(g) {
  const net = balances(g);
  const rows = g.members.map(m => {
    const amt = net[m.id] || 0;
    const cls = amt > 0 ? 'pos' : amt < 0 ? 'neg' : 'zero';
    const me = m.id === g.meId;
    const phrase = amt > 0 ? (me ? 'You are owed' : `${m.name} is owed`)
      : amt < 0 ? (me ? 'You owe' : `${m.name} owes`)
      : (me ? 'You are settled up' : `${m.name} is settled up`);
    return `
      <div class="bal">
        ${avatar(g, m.id)}
        <span class="grow"><span class="title">${esc(phrase)}</span></span>
        <span class="amount ${cls}">${amt === 0 ? '—' : money(Math.abs(amt), g.currency)}</span>
      </div>`;
  }).join('');

  const transfers = settleUp(g);
  const settleCard = transfers.length ? `
    <p class="section-title">Simplest way to settle</p>
    <div class="card">
      ${transfers.map(t => `
        <div class="settle-row">
          <span class="txt"><strong>${esc(nameOf(g, t.from))}</strong> <span class="arrow">→</span> <strong>${esc(nameOf(g, t.to))}</strong></span>
          <span class="amount">${money(t.amount, g.currency)}</span>
          <button class="btn small" data-action="record-payment" data-id="${g.id}"
            data-from="${t.from}" data-to="${t.to}" data-amount="${t.amount}">Settle</button>
        </div>`).join('')}
    </div>
    <p class="hint">${transfers.length} payment${transfers.length === 1 ? '' : 's'} clears every debt in the group.</p>`
    : `<p class="section-title">Settle up</p>
       <div class="card"><div class="hint">Everyone is square. Nothing to pay.</div></div>`;

  return `
    <p class="section-title">Balances</p>
    <div class="card">${rows}</div>
    ${settleCard}
    <div class="btn-stack">
      <button class="btn secondary" data-action="record-payment" data-id="${g.id}">Record a payment</button>
      <button class="btn secondary" data-action="share-summary" data-id="${g.id}">Share summary</button>
    </div>`;
}

function settingsView() {
  const groups = db.groups.length;
  const expenses = db.groups.reduce((a, g) => a + g.expenses.length, 0);
  return `
    <header class="topbar">
      <button class="icon-btn plain" data-action="back">‹ Groups</button>
      <h1>Settings</h1>
    </header>
    <main>
      <div class="card"><div class="hint">${groups} group${groups === 1 ? '' : 's'}, ${expenses} expense${expenses === 1 ? '' : 's'} stored on this device only. Nothing is uploaded anywhere.</div></div>
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
  const first = sheet.querySelector('input:not([type=hidden]), select');
  if (first && first.dataset.autofocus === 'yes') setTimeout(() => first.focus(), 120);
}

function closeSheet() {
  const sheet = document.getElementById('sheet');
  sheet.hidden = true;
  sheet.querySelector('.sheet-panel').innerHTML = '';
  document.body.style.overflow = '';
}

const sheetHead = title =>
  `<div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close>Close</button></div>`;

/* ------------------------------------------------------------- group form */
function groupSheet(existing) {
  const g = existing || { name: '', currency: 'GBP', members: [] };
  const members = g.members.length ? g.members : [{ id: uid(), name: '' }];

  openSheet(`
    ${sheetHead(existing ? 'Group settings' : 'New group')}
    <div class="card">
      <div class="field">
        <label for="g-name">Group name</label>
        <input id="g-name" data-autofocus="yes" placeholder="Lisbon trip" value="${esc(g.name)}" autocomplete="off">
      </div>
      <div class="field">
        <label for="g-cur">Currency</label>
        <select id="g-cur">
          ${CURRENCIES.map(c => `<option value="${c.code}" ${c.code === g.currency ? 'selected' : ''}>${c.code} (${c.symbol.trim()})</option>`).join('')}
        </select>
      </div>
    </div>

    <p class="section-title">People</p>
    <div class="card" id="member-list">
      ${members.map(m => memberField(m, g.meId)).join('')}
    </div>
    <div class="btn-stack">
      <button class="btn secondary" data-action="add-member-field">+ Add another person</button>
      <button class="btn" data-action="save-group" data-id="${existing ? existing.id : ''}">${existing ? 'Save changes' : 'Create group'}</button>
      ${existing ? `<button class="btn danger" data-action="delete-group" data-id="${existing.id}">Delete group</button>` : ''}
    </div>
    <p class="hint">The first person is you. Clear a name to remove that person — anyone already tied to an expense stays put.</p>`);
}

function memberField(m, meId) {
  return `
    <div class="field member-field" data-mid="${m.id}">
      <label>${m.id === meId ? 'You' : 'Name'}</label>
      <input class="member-name" placeholder="Name" value="${esc(m.name)}" autocomplete="off">
    </div>`;
}

function saveGroup(id) {
  const name = document.getElementById('g-name').value.trim();
  const currency = document.getElementById('g-cur').value;
  const fields = [...document.querySelectorAll('.member-field')];
  const members = fields
    .map(f => ({ id: f.dataset.mid, name: f.querySelector('.member-name').value.trim() }))
    .filter(m => m.name);

  if (!name) return toast('Give the group a name');
  if (members.length < 2) return toast('Add at least two people');

  if (id) {
    const g = group(id);
    const kept = new Set(members.map(m => m.id));
    const used = new Set();
    g.expenses.forEach(e => { used.add(e.paidBy); (e.participants || []).forEach(p => used.add(p)); });
    (g.settlements || []).forEach(s => { used.add(s.from); used.add(s.to); });
    const stuck = g.members.filter(m => !kept.has(m.id) && used.has(m.id));
    g.members = [...members, ...stuck];
    g.name = name;
    g.currency = currency;
    if (!g.members.some(m => m.id === g.meId)) g.meId = g.members[0].id;
    if (stuck.length) toast(`${stuck.map(m => m.name).join(', ')} kept — still on an expense`);
  } else {
    db.groups.unshift({
      id: uid(), name, currency, meId: members[0].id,
      members, expenses: [], settlements: [], created: todayISO(),
    });
  }
  save();
  closeSheet();
  render();
}

/* ----------------------------------------------------------- expense form */
function expenseSheet(g, existing) {
  const e = existing || {
    id: '', description: '', amount: 0, paidBy: g.meId || g.members[0].id,
    mode: 'equal', participants: g.members.map(m => m.id), weights: {},
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
          <span class="prefix">${esc(symbolFor(g.currency).trim())}</span>
          <input id="e-amount" class="amount-input" inputmode="decimal" placeholder="0.00"
            value="${e.amount ? (e.amount / 100).toFixed(2) : ''}">
        </div>
      </div>
      <div class="field">
        <label for="e-paid">Paid by</label>
        <select id="e-paid">
          ${g.members.map(m => `<option value="${m.id}" ${m.id === e.paidBy ? 'selected' : ''}>${esc(nameOf(g, m.id))}</option>`).join('')}
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
          ${g.members.map(m => `
            <button type="button" class="chip" data-action="toggle-person" data-mid="${m.id}"
              aria-pressed="${e.participants.includes(m.id)}">${esc(nameOf(g, m.id))}</button>`).join('')}
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
      <button class="btn" data-action="save-expense" data-id="${g.id}" data-eid="${e.id}">${existing ? 'Save changes' : 'Add expense'}</button>
      ${existing ? `<button class="btn danger" data-action="delete-expense" data-id="${g.id}" data-eid="${e.id}">Delete expense</button>` : ''}
    </div>`);

  const panel = document.querySelector('.sheet-panel');
  panel.dataset.weights = JSON.stringify(e.weights || {});
  renderSplit(g);
  panel.querySelector('#e-mode').addEventListener('change', () => renderSplit(g));
  panel.querySelector('#e-amount').addEventListener('input', () => {
    if (panel.querySelector('#e-mode').value !== 'equal') renderSplit(g, true);
    else renderSplit(g);
  });
}

function selectedPeople() {
  return [...document.querySelectorAll('#e-people .chip[aria-pressed="true"]')].map(c => c.dataset.mid);
}

function currentWeights() {
  try { return JSON.parse(document.querySelector('.sheet-panel').dataset.weights || '{}'); }
  catch { return {}; }
}

function stashWeights(w) {
  document.querySelector('.sheet-panel').dataset.weights = JSON.stringify(w);
}

/* Re-draw the per-person split rows for the chosen mode. */
function renderSplit(g, keepInputs) {
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
    const preview = sharesOf({ amount: total, mode: 'equal', participants: ids, weights: {} }, g);
    host.innerHTML = ids.map(id => `
      <div class="split-line">
        <span class="grow">${esc(nameOf(g, id))}</span>
        <span class="amount">${money(preview[id] || 0, g.currency)}</span>
      </div>`).join('') +
      `<div class="hint">${money(total, g.currency)} split ${ids.length} ways. Odd pennies go to the first people in the list.</div>`;
    return;
  }

  const weights = currentWeights();
  if (mode === 'exact') {
    const entered = ids.reduce((a, id) => a + (Number(weights[id]) || 0), 0);
    const diff = total - entered;
    host.innerHTML = ids.map(id => `
      <div class="split-line">
        <span class="grow">${esc(nameOf(g, id))}</span>
        <input class="split-input" data-mid="${id}" inputmode="decimal" placeholder="0.00"
          value="${weights[id] ? (weights[id] / 100).toFixed(2) : ''}">
      </div>`).join('') +
      `<div class="hint ${diff === 0 ? '' : 'bad'}">${diff === 0
        ? 'Exactly right.'
        : `${money(Math.abs(diff), g.currency)} ${diff > 0 ? 'left to assign' : 'over the total'}.`}</div>`;
  } else {
    const ws = ids.map(id => Math.max(0, Number(weights[id] ?? 1)));
    const preview = allocate(total, ws.some(w => w > 0) ? ws : ids.map(() => 1));
    host.innerHTML = ids.map((id, i) => `
      <div class="split-line">
        <span class="grow">${esc(nameOf(g, id))}<span class="meta">${money(preview[i], g.currency)}</span></span>
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
      refreshSplitHint(g, mode, ids, w);
    });
  });
}

/* Cheap update of just the footer line so typing never loses focus. */
function refreshSplitHint(g, mode, ids, weights) {
  const host = document.getElementById('e-split');
  const hint = host.querySelector('.hint');
  const total = parseAmount(document.getElementById('e-amount').value) || 0;
  if (mode === 'exact') {
    const entered = ids.reduce((a, id) => a + (Number(weights[id]) || 0), 0);
    const diff = total - entered;
    hint.className = 'hint' + (diff === 0 ? '' : ' bad');
    hint.textContent = diff === 0 ? 'Exactly right.'
      : `${money(Math.abs(diff), g.currency)} ${diff > 0 ? 'left to assign' : 'over the total'}.`;
  } else {
    const ws = ids.map(id => Math.max(0, Number(weights[id] ?? 1)));
    const preview = allocate(total, ws.some(w => w > 0) ? ws : ids.map(() => 1));
    host.querySelectorAll('.split-line').forEach((line, i) => {
      const meta = line.querySelector('.meta');
      if (meta) meta.textContent = money(preview[i], g.currency);
    });
  }
}

function saveExpense(gid, eid) {
  const g = group(gid);
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
    const i = g.expenses.findIndex(x => x.id === eid);
    if (i >= 0) g.expenses[i] = record; else g.expenses.push(record);
  } else {
    g.expenses.push(record);
  }
  save();
  closeSheet();
  render();
  toast(eid ? 'Expense updated' : 'Expense added');
}

/* -------------------------------------------------------- settlement form */
function paymentSheet(g, preset, existing) {
  const s = existing || preset || { from: g.meId, to: g.members.find(m => m.id !== g.meId)?.id, amount: 0, date: todayISO() };
  const opts = who => g.members.map(m =>
    `<option value="${m.id}" ${m.id === who ? 'selected' : ''}>${esc(nameOf(g, m.id))}</option>`).join('');

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
          <span class="prefix">${esc(symbolFor(g.currency).trim())}</span>
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
      <button class="btn" data-action="save-payment" data-id="${g.id}" data-sid="${existing ? existing.id : ''}">Save payment</button>
      ${existing ? `<button class="btn danger" data-action="delete-payment" data-id="${g.id}" data-sid="${existing.id}">Delete payment</button>` : ''}
    </div>`);
}

function savePayment(gid, sid) {
  const g = group(gid);
  const from = document.getElementById('s-from').value;
  const to = document.getElementById('s-to').value;
  const amount = parseAmount(document.getElementById('s-amount').value);
  const date = document.getElementById('s-date').value || todayISO();

  if (from === to) return toast('Pick two different people');
  if (!amount || amount <= 0) return toast('Enter an amount above zero');

  g.settlements = g.settlements || [];
  const record = { id: sid || uid(), from, to, amount, date };
  if (sid) {
    const i = g.settlements.findIndex(x => x.id === sid);
    if (i >= 0) g.settlements[i] = record; else g.settlements.push(record);
  } else {
    g.settlements.push(record);
  }
  save();
  closeSheet();
  render();
  toast('Payment recorded');
}

/* ------------------------------------------------------------ share / i-o */
function summaryText(g) {
  const net = balances(g);
  const lines = [`${g.name} — ${money(g.expenses.reduce((a, e) => a + e.amount, 0), g.currency)} spent`, ''];
  g.members.forEach(m => {
    const amt = net[m.id] || 0;
    lines.push(amt > 0 ? `${m.name} is owed ${money(amt, g.currency)}`
      : amt < 0 ? `${m.name} owes ${money(-amt, g.currency)}`
      : `${m.name} is settled up`);
  });
  const transfers = settleUp(g);
  if (transfers.length) {
    lines.push('', 'To settle up:');
    transfers.forEach(t => {
      const from = memberOf(g, t.from)?.name || '?';
      const to = memberOf(g, t.to)?.name || '?';
      lines.push(`${from} → ${to}: ${money(t.amount, g.currency)}`);
    });
  }
  return lines.join('\n');
}

async function shareSummary(g) {
  const text = summaryText(g);
  try {
    if (navigator.share) { await navigator.share({ title: g.name, text }); return; }
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
      if (!parsed || !Array.isArray(parsed.groups)) throw new Error('bad file');
      if (!confirm('Replace everything on this device with the backup?')) return;
      db = parsed;
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
  const closer = ev.target.closest('[data-close]');
  if (closer) { closeSheet(); return; }

  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const { action, id, eid, sid, mid, tab } = el.dataset;
  const g = id ? group(id) : null;

  switch (action) {
    case 'back': history.length > 1 ? history.back() : go('/'); break;
    case 'settings': go('/settings'); break;
    case 'new-group': groupSheet(null); break;
    case 'open-group': go(`/g/${id}`); break;
    case 'tab': go(`/g/${route().id}/${tab}`); break;
    case 'group-settings': groupSheet(g); break;

    case 'add-member-field': {
      document.getElementById('member-list')
        .insertAdjacentHTML('beforeend', memberField({ id: uid(), name: '' }, null));
      const fields = document.querySelectorAll('.member-field .member-name');
      fields[fields.length - 1].focus();
      break;
    }
    case 'save-group': saveGroup(id || ''); break;
    case 'delete-group':
      if (confirm('Delete this group and everything in it?')) {
        db.groups = db.groups.filter(x => x.id !== id);
        save(); closeSheet(); go('/'); render();
      }
      break;

    case 'add-expense': expenseSheet(g, null); break;
    case 'edit-expense': expenseSheet(g, g.expenses.find(x => x.id === eid)); break;
    case 'save-expense': saveExpense(id, eid); break;
    case 'delete-expense':
      if (confirm('Delete this expense?')) {
        g.expenses = g.expenses.filter(x => x.id !== eid);
        save(); closeSheet(); render();
      }
      break;
    case 'toggle-person': {
      const on = el.getAttribute('aria-pressed') === 'true';
      el.setAttribute('aria-pressed', String(!on));
      renderSplit(group(route().id));
      break;
    }

    case 'record-payment':
      paymentSheet(g, el.dataset.from
        ? { from: el.dataset.from, to: el.dataset.to, amount: Number(el.dataset.amount), date: todayISO() }
        : null);
      break;
    case 'edit-settlement': paymentSheet(g, null, (g.settlements || []).find(x => x.id === sid)); break;
    case 'save-payment': savePayment(id, sid); break;
    case 'delete-payment':
      if (confirm('Delete this payment?')) {
        g.settlements = (g.settlements || []).filter(x => x.id !== sid);
        save(); closeSheet(); render();
      }
      break;

    case 'share-summary': shareSummary(g); break;
    case 'export': exportBackup(); break;
    case 'import': importBackup(); break;
    case 'wipe':
      if (confirm('Delete every group and expense on this device? This cannot be undone.')) {
        db = blank(); save(); go('/'); render(); toast('Everything deleted');
      }
      break;
  }
});

/* ------------------------------------------------------------------- boot */
render();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
})();
