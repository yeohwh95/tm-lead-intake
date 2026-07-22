# TM Motoworld — Lead Intake Bot (tm-lead-intake)

WhatsApp lead → AI extract → Lark CRM + notify the assigned salesperson. **LIVE.**

## 🟢 BULK LEAD THROTTLE — LIVE 2026-07-21 (event Excel/form drops no longer blast the team)
Staff sometimes drop an entire event's leads at once (e.g. a test-ride registration Excel, 100+ rows). Benjamin flagged the risk: assigning + DMing + starting SLA timers for all of them in one shot dumps dozens of leads on a 4-person brand pool instantly (guaranteed SLA reassign storm) and is exactly the kind of automated burst that risks the WhatsApp number.
- **Fully automatic — staff do nothing differently.** They drop the file into the group exactly as before.
- If a single message yields **> `BULK_THRESHOLD` leads (default 15)**: ALL leads are still written to Lark + assigned immediately (nothing is ever delayed or lost from the CRM) — only the first batch of `BULK_BATCH_SIZE` (default 15) gets the salesperson WhatsApp DM + SLA timer start right away. The rest queue in `bulk_queue.json` and drain automatically every `BULK_DRAIN_MS` (default 6h, Benjamin 2026-07-21), **business hours only** (reuses the Mon–Sat 9–6 MYT gate, `inBusinessHours()`), until the queue is empty. The group gets one message when bulk mode kicks in + a short progress note each batch.
- ⚠️ `bulk_queue.json` is on Render's ephemeral disk (same caveat as `sla_store.json`/`fr_state.json`) — a mid-drain redeploy loses the QUEUED (not-yet-notified) batches. The leads themselves are safe (already in Lark, already assigned to a salesperson) — worst case is that batch never gets its WhatsApp DM/SLA timer and needs a manual nudge.
- Also fixed same session: `excelToText()` was silently truncated at 24,000 characters — a 260-row real event export (the Zontes/KTM test-ride form) would have been cut off after row ~100, silently losing the rest. Raised to 120,000 chars.
- Env overrides: `BULK_THRESHOLD`, `BULK_BATCH_SIZE`, `BULK_DRAIN_MS` (ms).

## 🟢 TEAM OVERRIDE (filename/caption) — LIVE 2026-07-21 (Harith: "only want HQ + Shah Alam, other team no need")
Staff can now restrict a WHOLE file's assignment to two or more named teams instead of each lead routing individually by its own brand — e.g. an event Excel captioned **"hq + shah alam"** rotates every lead across the combined HQ+ShahAlam pool only, ignoring Honda/KS entirely, regardless of what brand each row says.
- **Trigger:** the filename/caption names **2 or more** of `hq` / `honda` / `klang`/`ks` / `shah alam`. Naming exactly ONE keyword keeps the pre-existing single-BRAND-override behavior unchanged (e.g. "tiktok dm honda" still just forces brand=Honda — no behavior change for the normal daily case).
- `fileOverrides()` returns `teamOverride: ['HQ','ShahAlam']` (array of `POOLS` keys); `assignLeads()` merges those pools (deduped) and round-robins across the combined list under a shared `ROT` key (e.g. `"HQ+ShahAlam"`) instead of calling `poolForBrand()`. Brand is still recorded per-lead from the AI/model for reporting — it just no longer decides the pool when a team override is active.
- Verified with a standalone rotation test (mixed-brand leads all cycling correctly through the combined pool) — no dedicated index.js test harness exists yet for the assignment pipeline.

## 🐛→✅ FIXED 2026-07-21 — real incident: Zontes/KTM Excel (139 leads) only yielded 21, and "shah alam + hq" caption was ignored
Harith dropped the real test-ride Excel with caption "shah alam + hq" expecting a combined-team override (see TEAM OVERRIDE above). Two compounding bugs, both confirmed from live Render logs at the exact timestamp:
1. **AI extraction silently incomplete:** `aiExtract()` was handed the WHOLE spreadsheet as one text blob. Log showed `openai finish=stop len=3472` — the model completed its OWN response cleanly (not a token-limit cutoff, `finish_reason` was `stop` not `length`) after only ~21 of 139 leads. Zero error, zero warning — a "clean-looking" partial result. **Fix:** `excelToChunks()` splits the sheet into 20-row chunks (header repeated in each); `aiExtract()` now runs ONCE PER CHUNK and results are merged. 262 real rows → 14 chunks, full coverage verified directly against the actual file.
2. **Caption ignored in favor of filename:** the code called `fileOverrides(info.fileName || info.caption)` — filename wins whenever present, and a real document ALWAYS has a filename. The file's own name, "ZONTES KTM TEST RIDE 2026 (Responses).xlsx", contains the word "ktm" → got misread as a forced BRAND override (brand=KTM for every lead) → routed everything to the ShahAlam pool only, completely ignoring "shah alam + hq". **Fix:** flipped to `fileOverrides(info.caption || info.fileName)` — caption (a deliberate human instruction) now wins; filename is only a fallback when there's no caption. Same precedence fix applied to the AI prompt's own brand-hint line (it had the identical filename-first wording).
3. A third contributing factor (not a bug): Amirul was marked unavailable in the Lark sheet at the time (`availability refreshed — OFF: amir, azwin, amirul, bella`), so the 21 leads split 7/7/7 across the 3 remaining ShahAlam reps — working as designed.
⚠️ **Operational note:** the first 21 leads from that drop are ALREADY in Lark + already notified to Nazrin/Aso/Roy. If staff re-send the same Excel now that the fix is live, those 21 rows will be re-extracted and re-assigned as NEW duplicate leads (no dedup-by-phone exists). Staff should mark those rows done / remove them from the file before re-dropping it, not just resend as-is.

## 🐛→✅ FIXED 2026-07-22 — a 👍 reaction to the bot's own message caused it to HALLUCINATE fake leads from its own prompt examples
Benjamin spotted a "4 LEADS" card in the group with obviously fake data: "mas.saifuddin" / "+60123456789", "John Doe" / "+601112223333", "@bikeenthusiast" / "+60109876543" — all assigned to REAL salespeople (Syaza, Syahrin, Jebat) as if genuine.
**Root cause:** someone reacted 👍 to the bot's own "Bulk batch detected" message. A reaction has `kind:'reaction', text:''` — but `handle()` only special-cased text/image/document in its type-branch; anything else fell through with an EMPTY `blocks` array, then still got `EXTRACT_INSTRUCTION` appended and sent to OpenAI. The AI was handed literally nothing but its own instructions — which contain worked EXAMPLES ("e.g. mas.saifuddin", "aveta nova 250 (pricing)", the `+60...` phone format) — and hallucinated those examples back as if they were real extracted leads, in valid JSON, with `finish_reason=stop` (looked completely legitimate).
**Blast radius confirmed via Lark search:** `+60123456789` alone had **5 separate fake records**, historically assigned to Hazirah/Anis/Syafa/Syaza — this was a RECURRING bug, not a one-off, quietly polluting the CRM and pinging real reps with phantom leads every time a reaction (or likely a sticker) landed in the intake group.
**Fix:** `handle()` now hard-gates immediately after the dedup check — `if (!['text','image','document'].includes(info.kind)) return;` — reactions/stickers/anything else never reach the AI extractor at all (SLA-ack-via-reaction above this gate is unaffected). Existing fake records were NOT deleted (flag/clean up in Lark manually per the never-delete-rows rule) — search `Phone number` = `+60123456789` / `+601112223333` / `+60109876543` to find them all.

## 🐛→✅ FIXED 2026-07-21 (same incident) — confirmation card claimed ALL leads were notified when only the first batch was
Benjamin caught it: the group card said "✅ 21 LEADS — saved to Lark + salesperson notified" with a full tally (Nazrin:7, Aso:7, Roy:7) even though only the FIRST 15 had actually been sent to WhatsApp at that point — the other 6 were still sitting queued for the next drain. Root cause: `renderCard()` always ran BEFORE the bulk-mode branch decided how many leads to actually notify, so its "notified" claim and per-assignee tally covered the FULL enriched list regardless of what bulk mode was about to do.
**Fix:** in bulk mode (`enriched.length > BULK_THRESHOLD`), `renderCard()` is skipped entirely — the "📦 Bulk batch detected" message (which already correctly said "first 15 assigned... remaining 6 queued") is now the ONLY group confirmation for that event, so there's one accurate message instead of two conflicting ones. Non-bulk drops are unchanged.

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

## 📅 FIXED 2026-07-18 — SATURDAY is a working day (SLA_DAYS)
TM operates Mon–SAT, but `HOURS.days` was Mon–Fri (original spec assumption) → every Saturday the whole SLA layer slept: sweep skipped (13 Ads-Tiktok leads 07-18 had no SLA — Benjamin caught it in Lark), timers/reassigns dormant, FR-bot leads registered as off-hours. Now `SLA_DAYS` env (default `1,2,3,4,5,6`); Sunday stays OFF until the team confirms Sunday ops. Diagnosis trail: sweep worked daily ~09:02 MYT until Thu 07-16, silent after; manual Lark query proved data/roster fine; temp diag logged `off-hours` at Sat 13:14 → calendar, not code. **Lesson: encode the CLIENT'S actual business days, not the spec template's.**

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

## 🟢 FIRST-RESPONSE BOT v3 — LIVE 2026-07-20: real stock check + corrected loan/default templates (Harith feedback)
Harith flagged 4 real chat examples of vague/wrong customer-facing replies. Fixed + deployed (`d4bc627`, Render `dep-d9epkhm7r5hc73dh6e70`, tests 50/50):
1. **Stock never checked before replying** — new `wooCheckStock()` in `index.js` (WooCommerce `wc/v3/products?search=`, Basic Auth via `WOO_SITE`/`WOO_USER`/`WOO_APP_PW` env vars, same app-password as `reference_tm_wordpress.md`) queries the live catalog before any product reply that names a real bike model. 4s timeout, fails silently (never blocks the reply) if Woo is unreachable. Wired into `firstresponse.js` as injected dep `D.wooCheckStock`, new `stockLineFor()` helper composes "✅ Ada, stok tersedia — dari RM X" or "⚠️ takde stok untuk model tu" — lead still gets assigned either way.
2. **Loan template was vague + wrong** — was "kami ada loan kedai, Aeon & EPP kad kredit 0%" (implied CIMB EPP works — it doesn't). Now lists real financiers: shop loan = Aeon Credit, Chailease, JCL, Parkson, BSNC · EPP = Maybank, Public Bank, UOB, RHB, OCBC, Affin, AmBank, HLB, Alliance Bank, HSBC, Standard Chartered, BSN & AEON Credit Card — **CIMB EPP explicitly called out as unavailable** (`LOAN_SHOP`/`LOAN_EPP` constants in `firstresponse.js`).
3. **Default/product reply reworded** to staff's preferred formal phrasing: "Terima kasih kerana menghubungi kami. 😊 Mesej anda telah diterima. Sales advisor kami akan menghubungi anda dalam masa terdekat untuk membantu menjawab pertanyaan anda."
✅ **RESOLVED same day (07-20):** team gave the standing test-ride-by-branch line-up, testride now ASSIGNS (was info-only) reusing the existing brand→pool routing, no more dated event text. `FR_EVENT_INFO` env var is now dead code. Details below under "FIRST-RESPONSE BOT v3... test-ride now assigns by branch".

⚠️ **KNOWN GAP (flagged 2026-07-20, unconfirmed):** "Roadsinc" (one of the two Honda Impian X test-ride models, per the team's list) doesn't match any pattern in `brandFromModel()` (`index.js`) — a customer naming only "Roadsinc" (no "Honda" in the message) would fall through to the HQ catch-all pool instead of the Honda pool. Need Benjamin/team to confirm the actual model name/spelling before adding it to the regex.

## 🟢 FIRST-RESPONSE BOT — LIVE 2026-07-17 (`FIRSTRESPONSE_ON=1`) — v2 same evening (staff feedback)
**v2 (staff review of first 5 leads):** ① customer reply now ENDS with the ASSIGNED salesperson card (`AZRUL : 010-2323259` + wa.me) — assign runs BEFORE the reply so the name is known; also lets admins SEE who got the lead (chat 1: bot assigned Adib, admin unknowingly handed Syafa). ② No more raw-text echo ("untuk detail hi ya" 😬 — killed). ③ Malay short-forms (nk/tnya/sy/ape/kew…) → "hi + nk tnya" = BM not EN. ④ TESTRIDE category live: info-only reply from `FR_EVENT_INFO` env (default: 17 & 18 July, Zontes & KTM, walk-in ok) — **NO assignment** (Benjamin). ⑤ Vague greeting-flow answers label the lead "[ad click — model belum stated, sila probe]" instead of "Wants: hi". Tests 43/43.
`firstresponse.js` — instant first touch on customer DMs to 93210 (Product / Loan / Trade-in; spec: FIRSTRESPONSE-SPEC.md). **Prime rule (Benjamin): category confirmed = lead ASSIGNED immediately** — Product/Loan → `assignLeads` round-robin → Lark → salesperson DM → SLA timers; Trade-in → Fitri (purchaser 010-8093259) DM + Lark `TRADE-IN:` record. One-touch: bot replies once (greeting flow: ask model → their answer, ANY answer, = assign; 2 touches max) then silent — humans own the chat (fromMe on `messages.upsert` → `markHuman`). 10s debounce aggregates multi-message sends. BM default / EN on real English sentences (bare "Hi" = BM). Guards: staff roster (19 + support numbers, last-9-digit match), vendors/OTP, groups, 447*, one greeting per 7 days. Follow-up nudges PARKED (Benjamin: design later). Test-ride/Service categories PARKED. Kill switch: `FIRSTRESPONSE_ON=0` + redeploy. Tests: `firstresponse_test.js` 36/36 (real inbox messages as fixtures).
⚠️ `fr_state.json` is on Render's ephemeral disk (same as sla_store) — a deploy wipes greeted/pending state → worst case one duplicate greeting to a recent chat after deploy.

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
