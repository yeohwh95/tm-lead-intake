# TM Motoworld — Lead Intake Bot (tm-lead-intake)

WhatsApp lead → AI extract → Lark CRM + notify the assigned salesperson. **LIVE.**

## Where it runs
- **Render** `srv-d8oft4ho3t8c73dkmpng` (acct `tea-d81kknkdirrc73a46jlg`, key in memory `reference_render_new_account.md`). Auto-deploys on push to `main` (github `yeohwh95/tm-lead-intake`).
- WhatsApp session = WaSender **93210**. Acts ONLY in `INTAKE_GROUP_JID` (`120363410229539926@g.us`); everything else is capture-only.
- Fan-outs (fire-and-forget, never block lead flow): `INBOX_FORWARD_URL` → 8787 console · `WOO_FORWARD_URL` → `http://66.42.52.89/woo/` (website-upload service).

## ⚠️ `REVIEW_TOKEN` — group-notify sender (fixed 2026-07-10)
`REVIEW_TOKEN`/`REVIEW_GROUP_JID` drive the SLA digest (12PM/6PM `digestTick`) + the "no lead found" alert, both into "AI Agent Project TM Motoworld". Until 2026-07-10 this was still Benjamin's **personal** PA WaSender token — missed by an earlier same-day sweep that switched the other two TM group-notify flows (`tm-woo-upload` draft-ready ping, `tm-daily-report` cron) because those live on the **VPS**, while this service is on **Render**. Now switched to the TM Marketing token (session 93210), same as everywhere else. **Lesson:** a "switch this token everywhere" sweep must check every hosting platform (Render env vars AND VPS crontab/`.env` files) that references the var name, not just the ones already top-of-mind.

## Flow
webhook → `extract()` → if intake group → AI `aiExtract` (gpt-4o: text / image-vision / PDF / Excel) → `parseLeads` → `assignLeads` → Lark write → **group confirmation card FIRST** → per-salesperson DMs (5s spaced).

## Assignment = BRAND-driven (`poolForBrand`)
Honda→Honda pool · Lambretta/Thunder→Klang+ShahAlam · KTM/Zontes→ShahAlam · **HQ/Suzuki/Kawasaki/Aveta/anything-else→HQ pool (catch-all)**. Brand comes from the lead data OR the **filename/caption** (`fileOverrides`) OR — new 2026-07-02 — inferred from the **model** (`brandFromModel`).

## 🧠 Brand auto-detection (2026-07-02 — never leave blank, never ask & wait)
`brandFromModel(text)` reads the brand off the bike model so a lead ALWAYS gets a brand + pool + salesperson (was: no-brand leads sat blank → bot DM'd the group "what brand?" and waited). Resolution order in `assignLeads`: caption/AI brand → `brandFromModel` → **default HQ**. `VALID_BRANDS` whitelist coerces any off-list value to HQ. **`askMissing` (the "Brand unknown?" group ask) is now effectively dead** — brand is never blank.
- **PIC rulings (locked 2026-07-02):** `cbr*`→**Honda** · `368*`/zontes→**Zontes** · moca/moda/modenas/qj/benda→**HQ** · `aveta`→**Aveta** (HQ pool) · Honda families (cb#/pcx/vario/wave/rs150/africa twin…)→Honda · x-series/v-special/g350→Lambretta · **non-TM (Suzuki/Kawasaki/Yamaha/Ducati/BMW)→HQ** (dropped from detection so they fall through to the HQ catch-all).
- **"HQ" is NOT a bike brand** — it's TM's catch-all desk/team that absorbs Suzuki/Kawasaki/Modenas/non-TM. "Brand = HQ" means "handled by HQ team".
- Two assignment PATHS: (1) WhatsApp bot leads assign here; (2) **TikTok form leads (`Ads Tiktok`)** are written by the TikTok engine and assigned by **`sync.py`** round-robin — they bypass this file. So pool mismatches on TikTok-DM/form leads are EXPECTED (manual grabs / sync.py), NOT bugs.

## 🧹 SLA SWEEP — SLA on EVERY lead, any source (2026-07-02, `69a66cf`)
`slaSweep()` runs every 3 min: finds Lark rows with a Salesman but **no SLA Assigned At** → DMs the rep → starts the 75-min timer → stamps SLA cols. This covers **TikTok-engine / sync.py / manual** leads (they got a rep but no SLA before — SLA only fired from the WhatsApp bot). Triple-gated + safe: needs `SLA_ON=1` + `SLA_SWEEP=1` + `SLA_SWEEP_FROM` (epoch-ms cutoff, only enrols leads created at/after it → can't touch the ~5,700 historical rows) + `SLA_SWEEP_CAP` (per-run cap), working-hours only. **ON since 2026-07-02** (cutoff 18:49, cap 3; raise cap after watching first live sweep). Kill switch: `SLA_SWEEP=0`.

## 🗄️ Console message store (reconciliation / backfill goldmine)
The 8787 console persists EVERY forwarded message per channel:
`/opt/weihao-beef-business-whatsapp-order-bot/data/channels/tm-motoworld-lead-intake/inbox/messages.json`
(+ decrypted media in `…/downloads/<msgId>.jpg`). Records have `jid` (group), `text`, `timestamp`, `media.fileName`. Filter `jid` for the HQ Mudah group `1511270883` to reconstruct any post. Used 2026-06-22 to reconcile Mudah↔WooCommerce + backfill 4 bikes (text + photos) without re-sending.

## Fixes 2026-06-22 (committed)
- **Brand from filename/caption** → `fileOverrides` now detects lambretta/thunder/honda/hq/etc → forces brand → leads assign. (Was: no-brand "Get Leads" exports landed unassigned.)
- **Big-file reply** → renderCard sends a COMPACT per-assignee summary when the full card >3900 chars; `waSend` hard-caps text at 4096 (WhatsApp limit — full card was 422'ing → "no reply"/"bot not working").
- **Group card FIRST**, then staff DMs (was queued behind ~8× 5s DMs → looked dead for ~40s).
- **Vision fix** → feed OpenAI the WaSender **public URL**, not the local decrypted buffer (buffer was occasionally malformed → GPT returned empty on readable lead screenshots).

## 🐞 FIXED 2026-07-15 — sticker ack silently dropped → Syaza lost her lead
Syaza acked her 15:46 lead with an "Ok NOTED" **sticker** at 16:04 → `extract()` had no stickerMessage branch → `NO-EXTRACT` → ack never registered → T+75 reassigned to Anis → staff complaint ("ni syaza respon tapi kenapa still pass lead ya?"). Her TEXT ack the day before worked fine. Fix (3 parts):
1. `extract()` returns `kind:'sticker'` (like reaction) — stickers now ack.
2. SLA ack gate accepts `'sticker'`.
3. **Safety net:** ANY unparseable `messages-personal.received` (future unknown msg types) still routes phone/jid → `sla.onReply()` — logged as `✅MATCH ack (UNPARSED msg type — safety net)`. Unreadable ≠ ignorable: an unknown message type must never silently cost a rep her lead.
Staff SOP to circulate: **no "✅ Noted" reply from the bot = your ack didn't count — send a text.**

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
- **Visibility:** `/sla` endpoint = live JSON (reassign on/off, tracked, byStatus, pending list). **Group summaries at 12:00 + 18:00 MYT** (`digestTick` in index.js) — routine 75-min flags, reassign/pass, AND manager escalations buffer via `digestPush` → `sla_digest.json`, aggregated by rep, NO 1-by-1 spam (Harith's request, 2026-07-06). Per-rep DMs unchanged. (Was: hourly status post — removed.)
- **Ephemeral store caveat (Rule 24):** `sla_store.json` **and `sla_digest.json`** are on Render's ephemeral disk → every deploy/restart wipes in-flight leads, timers, AND the buffered 12PM/6PM digest events. So a deploy = clean baseline (past leads "let go"; Lark SLA columns are the durable record). ⚠️ **Batch doc+code into ONE push** — a separate doc-only push causes an avoidable mid-day restart that resets state (bit us 2026-07-06: `tracked` 39→5). For durability, rehydrate-from-Lark on startup (TODO).
- Files: `sla.js` (engine, 18/18 tests in `sla_test.js`) · wiring in `index.js` · `SLA-SPEC.md`.

## 🚀 AUTO-REASSIGN LIVE from Mon 2026-07-06 9am (`e7e2c23`, env armed 2026-07-03)
`SLA_REASSIGN=1` + `SLA_REASSIGN_FROM=1783299600000` (Mon 06 Jul 09:00 MYT). `/sla` shows `reassign: ON`, store wiped clean (`tracked:0`). Behaviour:
- **Round-robin lead**, 75-min no-reply → auto-moves to next region-pool rep (delete DM → DM next → update Lark Salesman → group note). 2nd miss → escalate to manager.
- **Named/deliberate lead protected** (`override`): WhatsApp caption `(Name)` OR sweep leads (Salesman already set in Lark) → nudged + group-escalated, NEVER auto-moved (Benjamin's Option B, 2026-07-03).
- **New leads only:** `SLA_REASSIGN_FROM` cutoff → any lead assigned before Mon 9am never moves (protects old in-flight leads even though the store persisted).
- Weekend/off-hours safe: working-hours gate (Mon–Fri 9–6) means nothing fires until Mon 9am.
- **Kill switch:** set `SLA_REASSIGN=0` (Render env) + redeploy → back to flag-only. Tests 24/24.

## 🐛→✅ SLA LATE-ACK bug FIXED 2026-07-03 (`f6b2a2d`)
**Symptom:** active reps (e.g. Allysa) showed `No-Response` / 0% in Lark even though they replied ✅ — proven by the WhatsApp console screenshot + Render logs (`match noop: … replied but has no pending leads`).
**Root cause:** `onReply` only acked leads with `status==='pending'`. Once a lead flipped to `flagged_noreassign` (No-Response) at T+75 — or a reply landed in the split-second **before** the lead registered — there was nothing "pending", so the reply was dropped as `noop` and the ack was lost. Reps looked silent when they weren't.
**Fix (`sla.js`):** a reply now acknowledges any lead in `RECOVERABLE = {pending, flagged_noreassign, skipped_offhours}` (these stay in the store while reassign is paused). Late acks write `SLA Status=Acknowledged` + `Within SLA?=false` + real `Response Time`; logs `SLA late-ack recovered`. Genuinely-silent reps (no reply at all) still stay No-Response. Tests: `sla_test.js` **21/21** (+3 late-ack).
**Lark backfill (2026-07-03):** reconciled the 15 `No-Response` rows (01–03 Jul) against the reply logs → **flipped 6** to Acknowledged-late (reps who provably replied after receiving: Allysa ×3, Adib, Nabil, Amirul); **kept 9** truly-silent (Azwin ×2, Nazrin ×2, Roy ×3, Fazwan, Syahrin). Backfill scripts in scratchpad (`backfill_plan.py` → `flips.json` → `write_flips.py`).
**⚠️ Takeaway:** the raw reply log (`✅MATCH ack` / `noop` lines) is the ground truth for "did the rep reply", NOT the `SLA Status` column (which under-counted before this fix). Do NOT turn on `SLA_REASSIGN=1` until enough live acks confirm the fix — else it would yank leads reps actually handled.

## 🟢 SLA → Lark columns (durable DB, live 2026-07-01)
Lark ("Lead management" table `tblP12qfzg5jlyZ2`, app `JmtibHNxPal4A5sUepml6LK5gzg`) is now the durable SLA record — no longer only the ephemeral `sla_store.json`. 13 columns, all prefixed `SLA `. Written by:
- **Assign (T+0)** `larkWriteLead` → `SLA Assigned At`, `SLA Original Salesman`, `SLA Status`=Pending (or Off-hours), `SLA Reassign Count`=0.
- **Reply** `sla.onReply` → `SLA First Response At`, `SLA Response Action`=Keep/Pass, `SLA Status`=Acknowledged, `SLA Response Time (min)` (rep-fair: from *their* assign), `SLA Customer Wait (min)` (from first assign), `SLA Within SLA?` (≤60 min).
- **Nudge (T+60)** `sla.tick` → `SLA Nudged At`.
- **Reassign** `reassignLead` → `SLA Reassigned At/From`, `SLA Reassign Count`, `SLA Status`=Reassigned. No-response while PAUSED → `SLA Status`=No-Response (no move). Escalate → `SLA Escalated At`, Status=Escalated.
- Field-write formats (verified): datetime = epoch **millis** (number), single-select = option **string**, checkbox = **bool**, number = int. Writes via `larkUpdateSLA(recordId, fields)` dep; `slaWrite()` is a no-op when the dep isn't injected (tests).
- Auto-reassign still **PAUSED** (`SLA_REASSIGN` unset). Explicit rep "pass" still moves the lead (pre-existing).
