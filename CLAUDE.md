# TM Motoworld — Lead Intake Bot (tm-lead-intake)

WhatsApp lead → AI extract → Lark CRM + notify the assigned salesperson. **LIVE.**

## Where it runs
- **Render** `srv-d8oft4ho3t8c73dkmpng` (acct `tea-d81kknkdirrc73a46jlg`, key in memory `reference_render_new_account.md`). Auto-deploys on push to `main` (github `yeohwh95/tm-lead-intake`).
- WhatsApp session = WaSender **93210**. Acts ONLY in `INTAKE_GROUP_JID` (`120363410229539926@g.us`); everything else is capture-only.
- Fan-outs (fire-and-forget, never block lead flow): `INBOX_FORWARD_URL` → 8787 console · `WOO_FORWARD_URL` → `http://66.42.52.89/woo/` (website-upload service).

## Flow
webhook → `extract()` → if intake group → AI `aiExtract` (gpt-4o: text / image-vision / PDF / Excel) → `parseLeads` → `assignLeads` → Lark write → **group confirmation card FIRST** → per-salesperson DMs (5s spaced).

## Assignment = BRAND-driven (`poolForBrand`)
Honda→Honda pool · HQ/Suzuki→HQ · Lambretta/Thunder→Klang+ShahAlam · KTM/Zontes→ShahAlam. **No brand = no pool = no salesman** (Salesman left blank in Lark). Brand comes from the lead data OR the **filename/caption** (`fileOverrides` forces it — "get lead lambretta.csv" → Lambretta on all rows).

## 🗄️ Console message store (reconciliation / backfill goldmine)
The 8787 console persists EVERY forwarded message per channel:
`/opt/weihao-beef-business-whatsapp-order-bot/data/channels/tm-motoworld-lead-intake/inbox/messages.json`
(+ decrypted media in `…/downloads/<msgId>.jpg`). Records have `jid` (group), `text`, `timestamp`, `media.fileName`. Filter `jid` for the HQ Mudah group `1511270883` to reconstruct any post. Used 2026-06-22 to reconcile Mudah↔WooCommerce + backfill 4 bikes (text + photos) without re-sending.

## Fixes 2026-06-22 (committed)
- **Brand from filename/caption** → `fileOverrides` now detects lambretta/thunder/honda/hq/etc → forces brand → leads assign. (Was: no-brand "Get Leads" exports landed unassigned.)
- **Big-file reply** → renderCard sends a COMPACT per-assignee summary when the full card >3900 chars; `waSend` hard-caps text at 4096 (WhatsApp limit — full card was 422'ing → "no reply"/"bot not working").
- **Group card FIRST**, then staff DMs (was queued behind ~8× 5s DMs → looked dead for ~40s).
- **Vision fix** → feed OpenAI the WaSender **public URL**, not the local decrypted buffer (buffer was occasionally malformed → GPT returned empty on readable lead screenshots).

## 🟢 Lead SLA — LIVE 2026-07-01 (gated `SLA_ON=1` in Render env)
`sla.js` engine + wiring in `index.js`. **Mon–Fri 9 AM–6 PM MYT** (skips outside hours). Per lead:
- **T+0** rep DM'd → ends with "✅ Reply YES once you have contacted this lead" → `sla.register()` saves the DM `msgId`.
- Rep replies **YES** (personal DM to the TM number) → confirms ALL their pending leads → bot replies "✅ Noted — thanks!".
- **T+60min** no YES → ONE summary nudge to the rep.
- **T+75min** no YES → 🗑️ delete the T+0 DM + the summary (WaSender `DELETE /messages/{msgId}`) → reassign to next region-pool rep (`pickNextRep`, skips unavailable) → DM them → update Lark Salesman → group note.
- **2nd miss** → escalate to group (no further auto-reassign).
- **Only NEW leads from activation onward** are tracked (never retroactive — `register()` fires only at assign-time).
- Engine is decoupled + simulated-time tested: `sla_test.js` (15/15). Spec: `SLA-SPEC.md`.
- ⚠️ Store `sla_store.json` is on Render's ephemeral disk → a mid-day redeploy wipes in-flight timers (acceptable for now; rehydrate-from-Lark if it bites).
- **Kill switch:** set `SLA_ON=0` (Render env) + redeploy → dormant, lead bot unaffected.

## Gotchas
- WaSender msg hard limit **4096 chars** (422 otherwise).
- Render env change needs a MANUAL redeploy to load (see ai-benjamin Rule 102).
- `messages.upsert` replays on reconnect — dedup by msg id + ignore stale timestamps.

## 🟢 Lead SLA — behavior finalized 2026-07-01
- **ANY reply from the rep = acknowledged** (not just "YES"). **"pass"** = instant reassign to next region-pool rep. **👍 reactions** also acknowledge.
- **Reply matching (Rule 23):** rep replies arrive from `@lid` privacy JIDs, so match by `key.cleanedSenderPn` (real phone) → name (pushName→roster) → learned-@lid. `onReply(realPhone, text, repHint, jid)` returns `{repKey, action:'ack'|'pass'}`.
- **SAFETY: auto-reassign on no-response is PAUSED** unless `SLA_REASSIGN=1` (Render env). While paused, a 75-min no-reply only alerts the group ("please follow up") — never moves the lead. Explicit "pass" still reassigns. Turn ON only after confirming acks work live.
- **Visibility:** `/sla` endpoint = live JSON (reassign on/off, tracked, byStatus, pending list). **Hourly group status** posted to the AI Agent group (assigned/acknowledged/waiting).
- **Ephemeral store caveat (Rule 24):** `sla_store.json` is on Render's ephemeral disk → every deploy wipes in-flight leads. So a deploy = clean baseline (past leads "let go"). For durability, rehydrate-from-Lark on startup (TODO).
- Files: `sla.js` (engine, 18/18 tests in `sla_test.js`) · wiring in `index.js` · `SLA-SPEC.md`.
