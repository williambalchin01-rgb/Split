# Split

A small web app for tracking who paid for what on a shared trip, flat or night out, and
working out the fewest payments that square everyone up — the Splitwise idea, but saved to
your iPhone Home Screen with no account and no server.

## What it does

- **Groups** for a trip, a flat or a one-off, each with its own currency (GBP by default).
- **Expenses** — who paid, how much, when, what for.
- **Three ways to split**: equally, by exact amounts, or by shares (1:1:2 and so on).
  Odd pennies are handed out by largest remainder, so the parts always add up to the total.
- **Balances** per person, plus the *simplest way to settle*: a greedy match of the biggest
  debtor to the biggest creditor, which clears every debt in the fewest transfers.
- **Record a payment** when someone actually hands over the money.
- **Share summary** via the iOS share sheet, or copied to the clipboard.
- **Backup / restore** as a JSON file.

Money is stored in pence as whole numbers throughout, so nothing drifts by a penny.

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

In `localStorage` on the device, under the key `split.v1`. It is never uploaded anywhere.
That also means it is per-device and per-browser: clearing Safari's website data wipes it,
so take a backup from **••• → Export a backup** before doing anything drastic. Sharing a
group between phones is not supported — that needs a server.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Shell and the iOS meta tags |
| `app.js` | All the logic: storage, splitting maths, views, actions |
| `styles.css` | Dark and light themes, safe-area insets |
| `sw.js` | Service worker for offline use |
| `manifest.webmanifest` | Home Screen name, icons, standalone display |
| `icons/` | App icons (180 for iOS, 192 and 512 for the manifest) |

Bump `CACHE` in `sw.js` whenever you change `app.js`, `styles.css` or `index.html`, or
installed copies may keep serving the old version.
