# TM First-Response Bot — DRAFT SPEC (2026-07-17, approved categories: Product · Loan · Sell)

KoonKen-style lead bot for the TM Marketing number (93210) — with one structural difference:
**93210 is actively manned by human admins during shop hours** (1–4 min replies). The bot must
NEVER compete with them. Test-ride + Service categories = PENDING (see end).

## Architecture — module inside tm-lead-intake (NOT a new service)
The lead-intake bot (Render) already receives every personal message on 93210 (SLA ack path proves
it), holds the 19-person staff roster, the per-brand round-robin pools (`assignLeads`), Lark CRM
writes, and the SLA engine. First-response = new module `firstresponse.js` wired into `handle()`:
same webhook, zero new infra, one kill switch (`FIRSTRESPONSE_ON=1`).

## Reply timing (Benjamin 2026-07-17: INSTANT, no human-wait)
On a qualifying inbound personal message from a NON-staff number:
1. **10-second debounce** (env `FR_DEBOUNCE_MS`) — aggregate multi-message sends ("Hi" + "Vstrom 800
   ada?") into ONE classification, one reply.
2. Reply immediately, 24/7 — bot owns the FIRST TOUCH; admins/salespeople own everything after.
3. **One-touch rule — RELAXED 2026-08-16 for off-hours only (Benjamin approved).** There are now
   TWO regimes, and the difference is whether a salesperson is about to receive the lead:
   - **Inside the distribution window (`FR_DIST_*`) — UNCHANGED.** The bot replies once and goes
     SILENT, except the greeting flow where the customer's model answer gets the handoff reply
     (2 touches max). A rep has the lead within minutes; the bot must not compete with them.
   - **Outside it** the bot may hold a short QUALIFICATION exchange, because nobody is coming until
     the next working day and this is the only chance to hand the rep something useful. Cap: **2
     qualifying asks + 1 phone-gate ask = 3 ask-type messages maximum**, then silent. Acks and the
     closing line are not asks and are merged into an existing message wherever possible.
   *Why the relaxation:* the client asked for the customer to be qualified before the handoff, so a
   salesperson opens "Z900 RS, loan" on Monday instead of "Hi". The one-touch rule exists to stop
   the bot talking over a human who is actively working the chat — which is not the situation at
   9pm on a Friday.
4. **Never announce a closure.** The old `⏰ Waktu operasi kami …` sentence is REMOVED (client,
   2026-08-16: *"don't say we are closed now. Say something like I will get the sales person to
   contact you in the next working day ya."*). Off-window replies commit to the next working day
   BY NAME, computed from `FR_DIST_DAYS`/`FR_DIST_START` via `hours.nextWindowLabel()` — 🚨 never
   hardcoded, which is the 2026-07-30 hours-drift lesson. `FR_QUALIFY=0` disables qualification but
   does NOT bring the closure sentence back: the client banned it outright.
5. NO follow-up nudges for now (parked — Benjamin: "later we only figure out follow up part").

## Guards (all KoonKen lessons)
- Personal chats only, never groups. Never staff/roster numbers, never Benjamin, never auto-responders
  (vendor auto-reply patterns), never `447*`/long JIDs.
- One bot greeting per chat per 7 days (no mid-conversation re-greetings — human-feel rule).
- Bot goes SILENT in a chat the moment any human outbound appears after it (handover detection).
- Language matching: reply BM by default, EN if the customer wrote English (KoonKen/Metal Age pattern).
- Every send logged; failures → existing failure-alerts daemon. QA console channel visible.

## Classification (priority order) + REPLY DRAFTS (lifted from staff's own templates)

### 1. SELL / TRADE-IN — keywords: jual motor|nak jual|mahu jual|trade in|tukar motor
Route: **Fitri (purchaser, 010-809 3259)** — confirmed from staff behavior.
> BM: «Selamat {pagi/tengah hari/petang} 😊 Boleh tuan. Nak jual/trade-in motor apa ya?
> Boleh share model, tahun & gambar motor. Purchaser kami akan contact awak —
> atau boleh direct WhatsApp: FITRI 010-809 3259 / https://wa.me/60108093259»
>
> EN: «Hi! Sure, we do buy & trade-in. Which bike (model, year) — photos help!
> Our purchaser will contact you shortly, or WhatsApp directly: FITRI 010-809 3259 /
> https://wa.me/60108093259»
Log to Lark CRM with type=TradeIn, assigned Fitri (no SLA round-robin).

### 2. LOAN / EPP — keywords: loan|ansuran|epp|kad kredit|credit card|pinjaman|bulanan|0 depo|blacklist|ctos
Route: normal salesperson pool (staff today treat loan asks as product leads) + **tag `Loan` in Lark**
(feeds the upcoming loan-automation agent — its intake stream starts here).
> BM: «Selamat {waktu} 😊 Boleh tuan — kami ada loan kedai, Aeon & EPP kad kredit 0% (3/5 tahun).
> Motor mana yang tuan berminat ya? Salesman kami akan contact awak sebentar lagi untuk bantu
> dengan detail loan.»
>
> EN: «Hi! Yes — we offer shop loan, Aeon & 0% credit-card EPP (3/5 years). Which bike are you
> looking at? Our salesperson will contact you shortly with the loan details.»
Then: `assignLeads` round-robin → salesperson DM (existing flow) → SLA timers ON.

### 3. PRODUCT (default) — names a bike/price/stock, or greeting-only from an ad click
Two variants:
**(a) Model named** («Vstrom 800 re», «Z800 ada ke»):
> BM: «Selamat {waktu} 😊 Ya tuan, boleh — salesman kami akan contact awak sebentar lagi
> untuk detail {model} ya 👍»
> EN: «Hi! Yes — our salesperson will contact you shortly with the details for {model} 👍»
→ `assignLeads` by brand pool → DM salesperson → Lark CRM → SLA.
**(b) Greeting-only** («Hi», «pagi» — ad click, bike unknown). ⚠️ Off-window this ask becomes the
fuller `qualifyAsk` (model **and** cash/loan in one message) — see the qualify machine below:
> BM: «Selamat {waktu} 😊 Ya bos, berminat motor apa ya? Boleh share model atau screenshot
> iklan yang bos tengok tadi 👍»
> EN: «Hi! Which bike are you interested in? Feel free to share the model or a screenshot
> of the ad you saw 👍»
→ if they answer with a model/photo → flow (a). If silent → nothing (follow-up ladder PARKED, to be designed later).

## Off-hours qualification machine (2026-08-16)
`state.qualify[jid] = { ts, asks, cat, want, lang, recordId, phase }`, persisted in
`FR_STATE_FILE` (`/data`). Replaces the old `state.pending`; legacy entries migrate on load with
`phase:'model'` so a customer mid-greeting at deploy time is not stranded.
- `phase:'model'` — the greeting flow (in-window and off).
- `phase:'detail'` — off-window, model known, waiting on the cash/loan + detail answer.
- **`PENDING_MODEL_MS` 48h → 72h**: a Friday-evening ask answered Monday morning is 62h later.
- 🚨 **The Lark row is written and the staff half queued on the FIRST message, exactly as before.**
  Qualification is layered on top and can never delay or replace it. A customer who answers nothing
  is still assigned at the next drain. Answers PATCH `Customer want` (`larkPatchWant`) **and** the
  queued entry, so Monday's rep DM carries the qualified text, not the stale snapshot.
- 🚨 **Ordering: qualify FIRST, phone gate LAST.** Never model + phone + username in one evening.
  A no-phone customer is qualified before the number is asked for, and no Lark row is written until
  the gate resolves (a row with neither number nor salesman is unactionable).
- 🚨 **One Lark row per customer.** A gate release on a lead the qualify flow already parked
  PATCHES the phone onto that row (`larkPatchPhone`) instead of calling `assign()` again — a second
  call would create a second row and put two salespeople on one enquiry.
- 🚨 **`state.qualify` is in the `midFlow` exemption in `onMessage()`.** It is a "waiting on the
  customer" state, and the 2026-08-05 rule says every one of those must be, or the bot's own
  outbound echo makes it deaf to the answer. `qualify_test.js` fails if it is ever removed.
- `sell` is excluded — its template already asks model/year/photos and routes to Fitri.
- The drain calls `clearQualify(jid)` on release: a rep owns the chat, the bot stops quizzing.

## Rollout (Benjamin 2026-07-17: straight to Phase C)
- **Live 24/7 immediately** (`FIRSTRESPONSE_ON=1`), instant replies — then collect team comments
  and iterate. No shadow phase, no after-hours-only phase.
- Kill switch: `FIRSTRESPONSE_ON=0` + redeploy. Never sends to staff, never groups.
- Qualification kill switch: **`FR_QUALIFY=0`** (env only). Off = pre-qualification behaviour,
  EXCEPT the closure sentence stays removed and the computed closing day stays.

## PENDING (parked per Benjamin 2026-07-17)
- **Test-ride/Event replies** — needs an editable "current event" text (dates, models, license rules)
  the team maintains; bot reads it. Park until Product/Loan/Sell proven.
- **Service/parts replies** — needs workshop numbers per branch. Park.
- Extension 07-16 zip rollout — only if staff complain about a failed draft.
