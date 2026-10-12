# Torn userscripts: how we work

This repo publishes **Bazaar Plus**, a Torn userscript. The owner (SarcasticGeekJr) plays Torn on a phone with **Torn PDA** and shares scripts with friends. These notes apply to Bazaar Plus and to any new Torn script.

## Working with the owner
- Explain in plain, simple words. They aren't a developer. Prefer short bullets grouped under headings.
- **Propose first, build after approval.** For new features or wording, write out what will change (with example text) and wait for "approve".
- Give anything they'll share with friends as copy-paste text in a code block.
- Before claiming something works, test it (see Testing). Say what was and wasn't tested on the real site.
- Stay within Torn's scripting rules: read and display data, and fill a field only when the user taps a button. Never buy, sell, list, confirm or click game actions automatically. One click = at most one action.

## Releasing an update (auto-update is set up)
Install link (what users paste into Torn PDA → Userscripts → + → Remote load/update → Configure):
`https://raw.githubusercontent.com/SarcasticGeekJr/torn-bazaar-plus/main/bazaar-plus.user.js`

To release:
1. Edit `bazaar-plus.user.js`.
2. **Bump the version in two places:** the `// @version` header line and `const VERSION = "x.y.z"` near the top. Torn PDA only offers an update when the header version is higher.
3. Run `node --check bazaar-plus.user.js` and the browser tests.
4. Commit and push straight to **`main`** in this repo. Main is the release branch, and the install link points at it.
5. Check it's live: `curl -s <install link> | grep -m1 @version` (GitHub's raw cache can take up to about 5 minutes).
6. Keep a backup copy in the private repo `SarcasticGeekJr/Mobile` under `bazaar-plus/` (same file and README).
7. Update `README.md` when features change.

The header must keep `@updateURL` and `@downloadURL` pointing at the install link.

How users receive updates:
- **Torn PDA** checks when the app starts. They can also go to Settings → Userscripts and tap the ⟳ (refresh) button. A bar says "1 script update available"; they tap **REVIEW**, tick the script and confirm. It asks before updating; nothing installs silently.
- Torn PDA **stops updating** a script that was pasted (no remote URL) or edited on the phone. The fix is to delete it and reinstall from the install link. Settings in localStorage survive a reinstall.
- **Tampermonkey** checks about daily and updates by itself.
- Inside the script: the version shows at the bottom of the 🛒 home screen and in ⚙ → About, with a "Check for updates" button.

## Torn PDA quirks (learned the hard way)
- **`PDA_httpGet(url, headers)`** is how cross-origin requests work in Torn PDA. It resolves to `{status, responseText}`. It **silently returns `undefined` if the same URL was requested in the last 2 seconds** (de-duplication). Always retry after ~2.1s instead of reading `.status` on undefined, and don't fire the same URL twice in quick succession (reuse in-flight promises).
- **API key:** put the literal string `"###PDA-APIKEY###"` in the script. Torn PDA replaces it with the user's key at runtime. If it still contains `#`, there is no PDA key; fall back to a key entered in the script's settings. When adding the script, PDA shows an "uses an API key" prompt: **Add** uses the PDA key, **Set API Key** sets a separate one. Recommend a **Public** key.
- Injection time should be **END**.
- Torn PDA's source is public at github.com/Manuito83/torn-pda (`userscripts/README.md`, `TornPDA_API.js`, `GMforPDA.user.js`). It also ships the **Torn API v2 OpenAPI spec** at `lib/models/api_v2/swagger/torn_v2.json`. Read these instead of guessing field names.
- Fall back in this order: `PDA_httpGet` → `GM_xmlhttpRequest` (Tampermonkey) → `fetch`.

## Notifications: use ntfy (all scripts)
The owner wants alerts sent as phone notifications with **ntfy** (https://ntfy.sh, free app, no account). Any script that alerts the user should also push to ntfy; an in-page banner alone isn't enough.
- Publish: `POST https://ntfy.sh/<topic>`, body = message text. Headers: `Title`, `Tags` (emoji shortcodes like `bell`, `warning`, `moneybag`), `Priority` (1-5, alerts use 4), `Click` (URL opened when tapped). Header values must be plain ASCII, so put emoji in `Tags`, not `Title`.
- POST order: `PDA_httpPost(url, headers, body)` (Torn PDA; the Torn page CSP blocks direct requests) → `GM_xmlhttpRequest({method:"POST"})` with `@connect ntfy.sh` → `fetch`.
- Settings: a topic box with a **New** button (random topic, because anyone who knows a topic can read it), the 3 setup steps (install ntfy → + subscribe to the topic → Send test) and a **Send test** button. Empty topic = off.
- Anonymous ntfy.sh is rate-limited per IP (HTTP 429): retry an alert once after ~65s, and show "too many messages, try later" for a test. Tests from this cloud often hit 429 because the IP is shared; verify delivery by polling `GET https://ntfy.sh/<topic>/json?poll=1`.
- Be honest about limits: a userscript only runs while a Torn page is open. Phones may pause Torn PDA in the background, so for alerts while away, tell users to leave Torn open in a browser on a computer.
- Only send what's new (Bazaar Plus keeps a shared `notified` set in localStorage) so several open tabs don't notify twice.

## Data sources
- **Bazaar listings: TornW3B (weav3r.dev)**, public, no key.
  - `GET https://weav3r.dev/api/marketplace` → `{items:[{item_id,item_name,type,market_price,lowest_price,total_bazaars,bazaar_average}]}`
  - `GET https://weav3r.dev/api/marketplace/{id}` → `{item_name,market_price,listings:[{player_id,player_name,quantity,price,content_updated,last_checked,uid?}]}`
  - TornW3B doesn't track $1 listings.
- **Official Torn API** (100 calls/min per user, shared across all their tools):
  - v2 `/market/{id}/itemmarket` → `itemmarket.listings[{price,amount}]`, plus `cache_timestamp`. It's cached, so up to about a minute old.
  - v2 `/market/{id}/bazaar` → `bazaar.specialized[{id,name,is_open,...}]`
  - v2 `/torn/{id}/items` → `items[{name,description,effect,requirement,type,sub_type,circulation,value{buy_price,sell_price,market_price,vendor}}]`
  - v1 `/user/{id}?selections=profile` → `status{description,state,details,until}`, `last_action{status,relative}`, `level`
  - v1 `/user/?selections=bazaar` → own bazaar; parse field names tolerantly (`ID/id`, `quantity/amount`, `price/cost`).
  - Errors come back as `{error:{code,error}}` with HTTP 200.
- **Item Market fees** (Torn wiki): 5% sales fee since 22 June 2025, plus 10% when listing anonymously. The 5★ Car Dealership or 5★ Property Broker company special removes the anonymous fee.
- Page URLs: Item Market item `page.php?sid=ItemMarket#/market/view=search&itemID=206`; bazaar `bazaar.php?userId=ID#/`; profile `profiles.php?XID=ID`; item image `/images/items/{id}/medium.png`. Your own player id is in the `uid` cookie.

## Script conventions (Bazaar Plus)
- UI lives in a **Shadow DOM** host so Torn's CSS can't break it (and vice versa). Mobile-first bottom sheet, desktop side panel, dark theme.
- Settings are saved in `localStorage` with the prefix `bzp_`.
- Re-render only the parts that change during live updates, so typing isn't interrupted.
- Avoid CSS class names that collide inside the shadow root. An `.alert` badge class once picked up the alert-banner styles.

## Testing
- This cloud environment's network may block torn.com, weav3r.dev, api.torn.com and greasyfork.org; github.com and raw.githubusercontent.com work. Don't fake results: say what couldn't be tested live.
- Test in headless Chromium with Playwright (`/opt/node22/lib/node_modules/playwright`, browsers in `/opt/pw-browsers`). Mock torn.com pages and the APIs with `context.route`, and **simulate Torn PDA** by defining `window.PDA_httpGet` with its 2-second de-duplication before running the script.
- Add a viewport meta tag to mock pages, or the mobile layout won't apply.
- Take screenshots and look at them. Several layout bugs were only visible that way.
- Things only the owner can check on the real site: Item Market page detection, the price-helper DOM on the bazaar add-items and Item Market add-listing pages, and the bazaar highlight.
