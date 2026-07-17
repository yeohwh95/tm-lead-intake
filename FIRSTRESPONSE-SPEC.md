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
3. **One-touch rule:** after the bot's first reply the bot goes SILENT in that chat — except the
   greeting flow, where the customer's model answer gets the handoff reply (2 touches max), then silent.
4. NO follow-up nudges for now (parked — Benjamin: "later we only figure out follow up part").

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
**(b) Greeting-only** («Hi», «pagi» — ad click, bike unknown):
> BM: «Selamat {waktu} 😊 Ya bos, berminat motor apa ya? Boleh share model atau screenshot
> iklan yang bos tengok tadi 👍»
> EN: «Hi! Which bike are you interested in? Feel free to share the model or a screenshot
> of the ad you saw 👍»
→ if they answer with a model/photo → flow (a). If silent → nothing (follow-up ladder PARKED, to be designed later).

## Rollout (Benjamin 2026-07-17: straight to Phase C)
- **Live 24/7 immediately** (`FIRSTRESPONSE_ON=1`), instant replies — then collect team comments
  and iterate. No shadow phase, no after-hours-only phase.
- Kill switch: `FIRSTRESPONSE_ON=0` + redeploy. Never sends to staff, never groups.

## PENDING (parked per Benjamin 2026-07-17)
- **Test-ride/Event replies** — needs an editable "current event" text (dates, models, license rules)
  the team maintains; bot reads it. Park until Product/Loan/Sell proven.
- **Service/parts replies** — needs workshop numbers per branch. Park.
- Extension 07-16 zip rollout — only if staff complain about a failed draft.
