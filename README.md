# Split

A small web app for tracking who paid for what on a shared trip, flat or night out, and
working out the fewest payments that square everyone up — the Splitwise idea, but saved to
your iPhone Home Screen with no account and no server.

## What it does

- **One to one** — a running tab with a single person, for the constant
  back-and-forth that does not deserve a group.
- **Groups** for a trip, a flat or a one-off, each with its own currency (GBP by default).
- **One list of people** shared by both, so the Sam on your one-to-one tab is the same
  Sam in the Lisbon group, and what he owes you adds up across the lot.
- **Expenses** — who paid, how much, when, what for.
- **Three ways to split**: equally, by exact amounts, or by shares (1:1:2 and so on).
  Odd pennies are handed out by largest remainder, so the parts always add up to the total.
- **Balances** per person, plus the *simplest way to settle*: a greedy match of the biggest
  debtor to the biggest creditor, which clears every debt in the fewest transfers.
- **Record a payment** when someone actually hands over the money.
- **Share summary** via the iOS share sheet, or copied to the clipboard.
- **Backup / restore** as a JSON file.

Money is stored in pence as whole numbers throughout, so nothing drifts by a penny.

### A note on the two kinds of total

Every expense creates a debt from each participant to whoever paid, so *what Sam owes you*
is exact even inside a big group. That pairwise figure is what the **People** rows show,
added up across every ledger you share.

A person's **balance** inside a group is a different number: it is what they owe *everyone*
there. In a group where Ada owes you £200 and Sam £20, her balance reads £220 while your
one-to-one total with her reads £200. Both are right; they answer different questions. The
*simplest way to settle* may also route a payment to someone other than the person owed,
which is the point of it — fewer transfers, same result.

## Sharing with other people

Off by default: with no configuration the app never talks to anything, and every
figure lives on the phone that typed it. Turning sharing on is a deliberate step.

Two phones cannot reach each other directly, so live sync needs something in the
middle. This uses Supabase, on its free tier.

1. Make a project at [supabase.com](https://supabase.com) (free tier is ample).
2. Open **SQL Editor → New query**, paste in all of [`supabase.sql`](supabase.sql), run it.
3. Open **Settings → API** and copy the **Project URL** and the **anon public** key.
4. Put both into [`config.js`](config.js) and redeploy. Bump `CACHE` in `sw.js` so
   installed copies pick the change up.

Then, in the app: open a group or tab, tap **•••**, **Share with them…**, and
**Create a join code**. Send the link or read the code out. On the other phone,
**+ Add → Join with a code**, then pick which of the names is them.

After that both sides push their changes as they make them and check for the
other's every few seconds while the app is open, and on returning to it. Edits
made with no signal queue up and go out when it comes back.

### What sharing actually costs you

- **The code is the whole lock.** Anyone holding it can read and edit that ledger.
  There are no accounts, so there is nobody to revoke — treat it like a door key.
  It opens that one ledger and nothing else.
- **Only shared ledgers leave the phone.** A group you have not shared, and every
  one-to-one tab you keep to yourself, stay local.
- **Names travel with a shared ledger**, because the other phone has to show them.
- **The anon key in `config.js` is public by design.** It is not a password; on
  its own it opens nothing, because the two functions in `supabase.sql` are the
  only way to the data and both demand a join code.

### How a disagreement is settled

Each record carries the time it was edited and the phone that edited it. The later
edit wins; if two land on the same millisecond, the higher device id wins, so both
phones reach the same answer without consulting each other. Deletes are kept as
markers rather than gaps, or a delete on one phone would look like a missing record
on the other and come straight back.

Two consequences worth knowing. A phone whose clock is badly wrong will win
arguments it should lose — that is the price of letting every copy judge a conflict
using the same number. And if two people edit *the same expense* at once, one of the
two edits is discarded rather than merged; separate expenses never collide.

## Installing on an iPhone

1. Host the folder over HTTPS (any static host — GitHub Pages, Netlify, Cloudflare Pages).
2. Open the URL in **Safari** (not Chrome — only Safari can add to the Home Screen).
3. Tap **Share** → **Add to Home Screen**.

It then launches full screen with no browser chrome, and the service worker keeps it
working with no signal.

### Hosting on GitHub Pages

In the repo: **Settings → Pages → Source: Deploy from a branch**, pick the branch and the
`/ (root)` folder. The app is then at `https://<user>.github.io/Split/`. Note this makes
the files public — the data itself never leaves the phone either way.

## Running it locally

Any static server will do, since there is no build step:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Where the data lives

In `localStorage` on the device, under the key `split` (data written by the first version,
under `split.v1`, is migrated automatically the first time it is opened). With sharing on,
shared ledgers also live in your own Supabase project. It is never uploaded anywhere.
That also means it is per-device and per-browser: clearing Safari's website data wipes it,
so take a backup from **••• → Export a backup** before doing anything drastic. A shared ledger
survives on the server, so another phone in the group can hand it back; anything you
never shared exists only where you typed it.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Shell and the iOS meta tags |
| `app.js` | All the logic: storage, splitting maths, views, actions |
| `styles.css` | Dark and light themes, safe-area insets |
| `sync.js` | Talking to Supabase: push, pull, merge, retry |
| `config.js` | Your Supabase URL and anon key (empty = offline only) |
| `supabase.sql` | The server side: one table and the two functions that guard it |
| `sw.js` | Service worker for offline use |
| `manifest.webmanifest` | Home Screen name, icons, standalone display |
| `icons/` | App icons (180 for iOS, 192 and 512 for the manifest) |

Bump `CACHE` in `sw.js` whenever you change `app.js`, `styles.css` or `index.html`, or
installed copies may keep serving the old version.
