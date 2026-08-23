# TM Motoworld — Lead Intake Bot (tm-lead-intake)

WhatsApp lead → AI extract → Lark CRM + notify the assigned salesperson. **LIVE.**

## 🔧 THE FUNNEL DID NOT ADD UP, AND THE CARD LISTED ONE PERSON TWICE — fixed 2026-08-23

The 08-21 rebuild shipped and ran for two days. Reviewing what it actually sent found four defects,
all measured against live data, not inferred.

### 1. 🚨 The funnel mixed two populations, so it could not add up
It printed `Assigned 15/21` above `Answered 16/30` — **more people answered than were ever
captured**. Stages 1-2 came from the decision log (only chats the FR bot handled); stage 3 from
Lark (every lead, incl. the TikTok ones `sync.py` writes). Fri 21 Aug: **log 21 · Lark 53**
(30 WhatsApp Direct · 13 Ads Tiktok · 6 Tiktok DM · 3 Tiktok Get Leads · 1 Whatsapp).
🔑 It also reported **71% assigned when the truth was 87%** — the card was making the team look
worse than they are. **All three stages now come from Lark**, so the funnel is monotonic by
construction. The log still supplies the WHY buckets (nothing else knows them) and the card states
how much of the gap they *cannot* explain.
⚪ **The daily cross-check warning is DELETED.** It fired every day comparing those two populations —
reporting my own design error as a data fault. A warning that fires daily teaches the reader to
ignore warnings.

### 2. 🚨 One person rendered as two — AND three people rendered as one
```
🔴 waited over 75 min:          ⏱️ Response speed:
   Shahrin            1            Shahrinjamaluddin  4 leads
   Shahrinjamaluddin  1
```
The late list was built from `SLA Reassigned From` (a roster KEY) and the scoreboard from `Salesman`
(whatever a human typed). Two vocabularies, one person, one message — his misses split across two
rows, understating both.

**And the opposite, which is worse.** The card shortened every name to its first word:
`MUHAMAD AMIRUL BIN KAMARULZAMAN`→Muhamad · `Muhammad Fazwan Bin Zabidi`→Muhammad ·
`Mohamad Amir`→Mohamad. **Three different people (Amirul, Fazwan, Amir) as three lookalike labels.**
🚨 Benjamin read that as one person spelled three ways and **approved merging them** — merging would
have erased three real salespeople. Raised and corrected before building.
🔑 **A Malay name begins with a shared honorific far more often than it ends with one: the first
token is the LEAST identifying part of the name.**
New `repname.js` (39 tests) resolves every name against `STAFF`. Tier order matters: whole-token
equality **before** prefix, because `Amir` is a key AND a prefix of `AMIRUL` — prefix-first deletes
a person. `shahrinjamaluddin → Syahrin` is an explicit **human-confirmed** alias (roster spells it
Sy-, Lark spells it Sh-; no rule can bridge that). An unknown name is printed BY NAME with a
warning, never bucketed.

### 3. 🚨 Both clocks are now BUSINESS HOURS
Shipped card: `Adib 1 leads · avg 16h 29m 🔴`. His lead arrived **Fri 15:36** and he replied next
morning — the clock ran all night through a **closed shop**. SLA-SPEC says *"Outside hours /
weekends → NO timer"*; a metric that ignores that measures the calendar, not the salesperson.
Both clocks now use `heartbeat.businessMinutesBetween` over real timestamps:
- customer clock = `SLA Assigned At` → `SLA First Response At`
- rep clock = **`SLA Reassigned At` || `SLA Assigned At`** → `SLA First Response At`

🔑 **The rep clock MUST start at the reassign where there was one.** The first attempt used the
original assign time and made Roy look SLOWER (49m) than his own wall-clock response (11m) — a
rescuer inheriting the whole original wait.

### 4. A rep with one lead has no score
`Jue 1 leads · avg 1h 24m · 0% 🔴` — a red flag on a single message, inside a 14-row table nobody
reads to the bottom. Reps under `SCOREBOARD_MIN_LEADS` (3) fold into one summary line. **Folded, not
dropped:** their leads stay in the funnel and their misses in the late list; only the per-rep
*average* is withheld, because one lead cannot support one. Card: **35 lines → 21**.

### 5. box-66: the marketing card had NEVER been delivered
`OPS CARD WaSender: True` then `⚠️ marketing card failed: HTTP Error 429: Too Many Requests` — on
**22 AND 23 Aug**. Adding the OPS send on 08-21 put two sends in one run; WaSender rate-limited the
second and `_card_emit` had no retry, so the card silently ceased to exist.
Fixed with **spacing** (`CARD_SEND_GAP_S`, default 8s) **and retry** (3 attempts, backoff) — the
Render bot has had exactly this since 08-18 (`cardsched.sendWithRetry`); box-66 never got it. Same
class of bug on two machines. A give-up now prints a **loud** line naming the attempts; the old code
raised into a bare `except` and the log line simply vanished, which is why it ran broken for 2 days.
✅ **Proven live**: both cards sent, attempt 1, to the QA group.

### 6. Operations ran on a closed Sunday
The Render bot skips Sundays; the box-66 job had no guard, so 23 Aug sent a card about a shut shop —
the same list as Saturday. `CARD_SUNDAY=1` overrides for testing.

**Deployed:** Render (this commit) · box-66 `daily_report.py` (backup
`daily_report.py.bak-pre-retry-20260823`).
Tests: repname **39** (new) · cards **70 → 77** · suite **945 → 992**.

## 📊 THE REPORTS BECAME ONE FUNNEL — and using the rep's clock would have halved the problem — 2026-08-21

Benjamin: *"I cannot understand what it says and cannot tell immediately what to do."* He then gave
the goal the sales report exists to serve, in his own words: **"capture all leads → assign all leads
to a salesperson → make sure the leads are responded to promptly. That is the final goal."**

**Root cause of the unreadability, named:** ONE event — *a customer nobody replied to* — was counted
**four times, on four clocks, under four names, across two cards**:

| Clock | Name it got | Card |
|---|---|---|
| 75 minutes | "no reply within 75 minutes" | Boss |
| reassigned once, still nothing | "STILL WAITING" | Sales |
| 3 failed auto-assign tries | "NO SALESPERSON" | Sales (dead — `orphans` was `armed:false`) |
| 11 days | "never contacted at all" | Boss |

No card could open with *"N customers are waiting"*, which is the only line that tells anyone what
to do. **Four reports → three** (`sales` · `marketing` · `operations`); the BOSS card is DELETED, not
simplified — it was a restatement of the other three in different words and different units, and
that restatement is what created two of the four clocks.

### 🚨 THE MEASUREMENT THAT CHANGED THE BUILD: two clocks, and the wrong one is half the truth
Stage 3 was first built on `SLA Response Time (min)`. Probed against 100 live Lark rows before
shipping:

| | count |
|---|---|
| leads late by the **rep** clock | **14** |
| leads late by the **customer** clock | **28** |

**Exactly double.** 17 of 63 leads had been reassigned, and `SLA Response Time (min)` **restarts at
the reassign**. A real row: *Roy answered in 2 minutes* — of a wait the customer had already spent
**78 minutes** in. True about Roy, false about the customer. Shipping that would have produced a card
that flatters the team and misses the stated goal.

So each field now answers only its own question, and the card says which is which:
- **`SLA Customer Wait (min)`** → the funnel's stage 3 + the late list. Time from the **first**
  assignment, across every reassignment. **This is the goal.**
- **`SLA Response Time (min)`** → the per-rep scoreboard only. A rep must not wear the silence of
  the rep before them.
- Lateness is attributed via **`SLA Reassigned From`** when set — a reassign only fires at T+75, so
  that rep is by definition the one who let it pass. Blaming the rescuer would invert the scoreboard.

🚨 **Nothing new is measured.** Both fields have been stamped on every row by `sla.js` since 2026-07
and were simply never read back. `SLA Within SLA?` is IGNORED — it is written against 60 min while
the engine acts on 75; the threshold now lives in ONE place (`SLA_CARD_THRESHOLD_MIN`, default 75)
so the card and the engine cannot drift.

⚠️ **What "Answered" honestly means.** The stamp lands when the rep replies **YES to the bot**, not
when they message the customer. A rep who acknowledges and does nothing scores fast. The card
therefore never says "replied to the customer". Measuring the real reply needs the rep's outbound
message, which this process cannot see. **Flagged to Benjamin, not built.**

### The card
Three stages, `have/target` + a percent bar, then ONLY the leak. Clean day = `✅ 100% at every step.`
The late block is **name + count only** (Benjamin, 08-21) — ⚠️ *stated consequence:* with the customer
and the `wa.me` link gone, an admin can no longer chase on a rep's behalf **from this card**; reps
still get the customer itself by DM.

### Where each report now lives — and why the JS copies were DELETED, not left dark
`cards.js` exported five renderers; three are gone. `marketingCard` / `operationsCard` were dead code
behind env flags while **box-66 actually sends those cards** from `daily_report.py`, which is the only
machine that can read the Mudah group ledger, the Relay DB and `pending_review.json`.

🚨 **Two renderers for one card is fork drift in miniature** — the named root cause of the 08-21
fleet review — and an unused copy is exactly the copy nobody remembers to update. So:

| Report | Built on | Fires | Goes to |
|---|---|---|---|
| 🏍️ SALES | Render (`cards.js`) | 09:15 + 14:00 | AI Agent Project TM Motoworld |
| 📣 MARKETING | box-66 `daily_report.py` `MKT_CARD=1` | 09:10 | AI Agent Project TM Motoworld |
| 🔧 OPERATIONS | box-66 `daily_report.py` `OPS_CARD=1` | 09:10 | **Benjamin's QA group** |
| 📈 BOSS | — | — | **DELETED 2026-08-21** |

`GET /ops` `cardsOwned` now answers *which machine*, not a boolean — it is the check that stopped two
duplicate cards a day going out.

Tests: cards **81 → 70** (marketing/operations/boss tests left with their renderers), suite **945**.

## 🚨 MALAY `2` IS A WORD SUFFIX, NOT A DIGIT — the phone parser ate it — 2026-08-21
⚠️ **COMMITTED.** Benjamin, confirming the convention: **`ok2` means `okok`.** Malay marks
reduplication with a trailing `2` — `ok2` = okok, `dekat2` = dekat-dekat, `jalan2` = jalan-jalan,
`ada2` = ada-ada. It is orthography, not arithmetic.

`gateParsePhone` matched `/\+?\d[\d\s\-().]{7,20}\d/`, which could **start a candidate at any
digit**. The debounce buffer joins a customer's messages with ` \n `, and `[\d\s...]` spans that
join — so the reduplication marker welded itself onto the number in the next message:

| Customer typed | Stored | Dialable? |
|---|---|---|
| `…tgk dekat2` ⏎ `0137939637` | `20137939637` | ❌ does not exist |
| `ok2` `0126064797` | `20126064797` | ❌ |
| `0137939637` | `60137939637` | ✅ |

**Confirmed damage, 2 leads (both raised as SEV1 on the Ops card and both ignored):**
- `+60137939637` · 20 Aug 10:06 · "Nk tanya moda sportster s v2 bila masuk kedai?" → stored
  `20137939637`, DM to Adib **HTTP 422, given up after 1 attempt**. He chased us **32h later**:
  *"Hi. Xde org contact sy pon."*
- `+60172861226` · 18 Aug 12:47 · "Moda Sporter S V2" → stored `860172861226` (an `8` welded on),
  same 422, same silence.
- ✅ **`1924279574737` and `6713117831235` (both 2 Aug) are NOT this bug — CLOSED.** The parser can
  never emit 13 digits (every branch caps at 12; verified). Both are the **already-documented @lid
  incident of the same day**, fixed by `8362bc2` "never fabricate a phone, address the @lid" — the
  comment above `onMessage` describes these exact rows: *"the Lark row carried a fake 13-digit phone
  no salesperson could ever call."* No recurrence since. **Do not re-investigate.**
- Every other non-`60` number since 1 Jul is a genuine foreign one (SG 65 ×6, TH 66, BD 880,
  CN 86 — a real 13-digit Chinese mobile, so `length > 13` must stay `> 13` — PL 48). Do not "fix" those.
- 📏 **Blast radius is bounded: exactly 4 permanent send failures in the 7-day log window**, all
  `HTTP 422 "The provided JID does not exist on WhatsApp"`, two per victim. No others.

**⚠️ IT IS NOT ONLY MALAY — the 18 Aug victim was a USERNAME.** Reconstructed from the gate log:
`253858337034457@lid` sent `@Khalidiey86` and then `0172861226`. The `86` on the end of his handle
welded on exactly as `dekat2` did. **Any token ending in digits does this** — a username, a nickname,
a model name (`MT25 0123456789` parsed as `250123456789`). Malay reduplication is the most COMMON
trigger, not the only one.

**🚨 And the opposite failure, which is worse because it is silent.** `Z900 0123456789` captured
**NOTHING** — not a wrong number, no number at all. The candidate started at the `0` of `900`,
swallowed `00 0123456789`, failed every length rule, and `match` had already consumed those
characters so the real number was never looked at. The customer gave their number and **the bot kept
asking for it** — the same complaint, from a different cause.

**Fix:** `(?<![A-Za-z0-9])` on the leading digit, so a candidate can only begin at a real token
boundary. Letter-only was NOT enough — that is what left `Z900` broken. Plus: a **lone** leading
digit followed by a separator is a quantity, not a number (`nak 2 0137939637`), so it is trimmed.
Exactly one, never two, because `60 12-345 6789` is a real way to write it.
Tests: gate **70 → 85**, suite **942 → 957**.

🚨 **THIS IS NOT TM-SPECIFIC.** Every Malay-language bot buffers inbound messages and joins them
before parsing. U Fresh, SFF, KoonKen, Metal Age and FSS all take phone numbers out of free text.
Same class of bug, same one-line lookbehind. **Not yet checked on those bots.**

⚠️ **A permanent send failure still only produces an Ops line.** Both victims were reported as SEV1
and neither was recovered — the customer chased us instead. A 422 is not transient; retrying cannot
help. The lead needs to reach a human, not a health card. Flagged, not built.

## 🐛 "AUTO BOT KEEP TANYA SOALAN SAMA" — the qualify flow could not hear the answer — 2026-08-21
⚠️ **COMMITTED, NOT DEPLOYED.** Client reported it twice in the project group (19 Aug 09:54, 21 Aug
09:36). Root cause, measured on live traffic, not inferred:

**`VAGUE()` was the wrong instrument for "did they answer us?".** It runs `classify()`, which has a
`loan` rule and **no `cash` rule at all**, and knows only the models in `RE_BIKE`. So the bot asked
*"Nak cash atau loan?"*, the customer replied *"Cash"*, and that reply scored as `greeting` = said
nothing — and the **byte-identical question went out again**.

| Live case | Customer said | Bot heard | Bot did |
|---|---|---|---|
| 21 Aug 07:46 · +60133664090 | `Cash..` then `Cash` | nothing, twice | asked the same question again, then went silent. A human answered at 09:45 |
| 19 Aug 07:33 · +60185776768 | `Trk502` then `Trk502` | nothing, twice | same question twice. Human stepped in 09:55 |
| 18 Aug 18:49 · +60104181295 | `Cash bpe otr` | nothing | same question again → customer replied `.` and left |
| 20 Aug 22:08 · …767892@lid | `saya nak cash` | nothing | **had already asked cash-or-loan TWICE IN ONE BUBBLE** |

**6 of the 36 customers** who got a qualify ask 18–21 Aug were asked the same thing twice; three
stopped replying. Console inbox is the source, not the log.

### The three defects, and the three fixes
1. **`qualifyVague(text, hasImage)`** replaces `VAGUE` inside the qualify flow. A payment mode
   (`RE_PAYMODE` — cash/tunai/loan/EPP/aeon/depo…), a model-shaped token (`RE_MODELISH` — letters
   glued to digits: `trk502`, `x250gp`, `703f`, `zx1000r`), or a photo all count as a real answer.
   🚨 `RE_MODELISH` is deliberately **NOT** merged into `RE_BIKE`: routing stays conservative, only
   the did-they-answer-us test gets the benefit of the doubt.
2. **`QUALIFY_MAX_ASKS` 2 → 1.** The second ask was a byte-identical repeat, which is the complaint
   verbatim. What reaches ask #2 now is a genuine non-answer (`ok`, `.`) — and the lead is already
   in Lark and already queued, so the rep still gets it at the next drain. Asking again buys nothing.
3. **`qualifyAsk(lang, modelKnown, payAsked)`.** A NEW-unit stock line already ends with *"Bos nak
   cash atau loan?"*; the ask then appended the same question. `payAsked` is detected from the text
   about to be sent (`RE_ASKS_PAY`), never from a flag, so it cannot drift from the stock copy.
   `modelKnown && payAsked` ⇒ the ask is empty and the stock line stands alone.

Suite **927 → 942** (qualify 78 → 93, incl. 7b replaying every answer that used to read as silence,
and 7c the double-ask bubble). All four live conversations replayed clean against the fix.

### What this is NOT
- 🅿️ **The "no assignment" half is CONFIG, not this bug.** `FR_DIST_*` defaults to **Mon–Fri
  09:00–17:00** while TM operates **Mon–Sat 09:00–18:00**. So 17:00–18:00 on weekdays and ALL of
  Saturday the shop is staffed but the bot assigns nobody — the lead parks for the next 09:00 drain.
  `FR_DIST_DAYS=1,2,3,4,5,6` / `FR_DIST_END=18` is a one-env change and `qualify_test` §8 already
  covers both settings. **Benjamin's call, not ours.**
- ✅ **The Moda "belum release lagi" complaint (19 Aug) is already gone** — it came from the Woo
  product literally titled `NEW MODA SPORTER S V2 OPEN FOR BOOKING`. That title has been changed
  (now `NEW MODA SPORTER S SK II SK2 V2`); last booking-line hit was 20 Aug 10:07. Only
  `OPEN FOR BOOKING NEW ZONTES 175X` still carries it, correctly.
- 🚨 **Nothing was deployed 19 or 20 Aug.** Render has been live on `669235d` since **18 Aug 12:40**
  (`/ops` bootAt). The "yesterday's fix" mentioned in the group on 21 Aug never went out.

### Rollback
Two levels. `FR_QUALIFY=0` + **restart** disables the whole qualification flow with no code change
(kill switch, `qualify_test` §14) — ⚠️ a Render single-var PUT does NOT restart. Or revert this
commit; it touches `firstresponse.js` only.

## 📋 SALES + OPS CARDS, HEARTBEAT, LEGACY SWITCH — 2026-08-18
⚠️ **COMMITTED, NOT DEPLOYED.** Everything is flag-off or legacy-preserving by default: `CARDS_ON`
unset ⇒ no cards, `LEGACY_REPORTS` unset ⇒ the four scheduled client sends are byte-identical.

### SALES card rewritten (`cards.js salesCard`) — the 3d8b44b contract, then the action list
Order: `Yesterday: N leads → X assigned` + the WHY buckets (rendered from **`leadsummary.WHY`,
now exported** — never a second copy of the map) → 🚨 **CUSTOMERS STILL WAITING** (Lark `SLA
Status=Escalated`; ~23% of leads, the main event; rep · +phone · want · `wa.me`) → 🚨 NO
SALESPERSON (orphan sweep, usually empty) → both empty ⇒ `✅ Everyone got a reply yesterday.`
- Counts come from **`buildLeadSummary` — the SAME counting path as the client's summary** (its
  `read_error`/`no_data`/`partialFrom` honesty included). Lark is the cross-check; disagree ⇒ BOTH
  numbers print. The old card's Lark-only counting path is gone from the sales card.
- 🚨 A failed Lark read renders the waiting list as **"UNKNOWN, not empty"** and blocks the
  all-clear — an unreadable list is the confident-zero lie in list form.
- `gatherCardData` no longer slices `stuck` at 12 — `fit()` already trims AND SAYS SO; the slice
  was a silent cap that made "12 waiting" out of a worse day.

### NEW OPS card (`cards.js opsCard`) — Benjamin's health card, QA group only
SEV1 (losing leads now: `larkMissing`, undelivered sends) → SEV2 (client numbers broken: missing
sent-markers, `sumOk:false`) → SEV3 (backlog rising vs `summaryMark.backlog` — related counters,
both printed) → SEV4 (going blind: log unreadable, parse errors, Lark unreadable, **no inbound
message for N business hours**). Healthy day = short + `▸` status lines + a MANDATORY `Blind:`
line (inbox cross-check is box-66 09:57 only). Every line is grounded in a signal that exists.

### 🫀 WEBHOOK HEARTBEAT (`heartbeat.js`) — quiet day vs dead WaSender session
`recent[]` is RAM-only, so those two were indistinguishable from inside the bot — and a dead
session is the failure that loses EVERY lead at once. Every inbound `messages.upsert` (echoes
excluded) stamps `last_inbound.json` beside `FR_STATE_FILE` (⇒ `/data` in prod, no new env var),
throttled to ≥60s between writes, best-effort with the ENOSPC test. The quiet measure is
**BUSINESS hours** (`businessMinutesBetween`, minute-walk, 14-day cap that SAYS when it capped) so
a weekend of silence is 25 minutes, not 39 hours — no Monday false alarm. Alarm default 3h
(`OPS_QUIET_ALARM_H`). Exposed on **`GET /ops`** with both marker stores. Boot-read keeps the
`readFrEvents` ENOENT split: missing file in a healthy dir = fresh; missing DIRECTORY = error.

### cardsTick fixes (`index.js` + `cardsched.js`)
- 🚨 **Reports the last WORKING day, not literal yesterday** (`cardsched.workingDayBefore`, MYT):
  Monday reported SUNDAY and Saturday was covered by nothing, a weekly permanent hole.
- 🚨 **Confirmed delivery**: the old code claimed `cardsSent[key]` BEFORE the await and ignored
  `cardsSend`'s return — one transient 5xx lost a card silently forever. Now
  `cardsched.sendWithRetry` (3 attempts, 5s/15s backoff), marker only on a confirmed outcome,
  and after 3 failures a notice to the QA group (发现 → 自己 fix → 3 次不行 → 才通知群组).
- 🚨 **Markers on the persistent disk** (`cards_sent.json` beside `FR_STATE_FILE`) — RAM-only
  markers double-fired every card on a redeploy inside the window. Kept 3 days, because…
- `digest.sent` retention 1 → **3 days**: Sunday's 12:00 prune deleted Saturday's markers a day
  before the Monday ops card could prove Saturday's reports went out.
- Schedule: sales **09:15 AND 14:00** (`CARDS_SALES_HR2`; the 14:00 one covers TODAY so far and is
  labelled so), ops 09:15, boss 18:00 unchanged. Cards interval moved **outside the `SLA_ON`
  gate** — same "reports must not die with the SLA toggle" lesson as digestTick.
- `gatherBacklog`: `Origin='WhatsApp Direct'` filter → **30-day age cap** (`BACKLOG_MAX_DAYS`).
  Measured identical today (15 rows); the Origin filter went blind to a stranded TikTok lead, and
  without any filter it is 242 rows dominated by a 245-day-old "On Site Event" import.

### LEGACY_REPORTS switch — retire, don't delete
`LEGACY_REPORTS=0` disables ONLY the four scheduled client sends in `digestTick` (10:00/16:00
summaries + 12:00/18:00 SLA digests). SLA engine, sweeps, ad-hoc alerts, cards: untouched. Event
pruning still runs so the digest store cannot grow forever; sent-markers are NOT faked. Default
`1` = byte-identical behaviour. ⚠️ **When it is eventually set to 0, box-66's
`probe_tm_summary()` will alarm hourly unless retired in the same pass** — flagged, not touched.

**Env added (all with safe defaults):** `LEGACY_REPORTS=1` · `CARDS_SALES_HR2=14` ·
`CARDS_SENT_FILE` (beside `FR_STATE_FILE`) · `BACKLOG_MAX_DAYS=30` · `LAST_INBOUND_FILE` (beside
`FR_STATE_FILE`) · `INBOUND_STAMP_MS=60000` · `OPS_QUIET_ALARM_H=3`.
Tests: cards **81** · cardsched **15** (new) · heartbeat **28** (new) · full suite **927** (was 837).

## 🩹 ORPHAN SWEEP — a phone with NO salesperson is now recovered, not reported — 2026-08-17
⚠️ **COMMITTED, NOT DEPLOYED, AND OFF BY DEFAULT** (`ORPHAN_FROM` unset ⇒ recovers nothing).

`slaSweep` rescues "has a salesperson, no SLA clock". **Nothing rescued the opposite shape: a real
phone number and NO salesperson at all.** That row is invisible to everything — `slaSweep` filters
`Salesman isNotEmpty`, the SLA engine only knows leads it registered, the drain only knows its own
queue. It sits in the CRM looking like a lead and behaving like nothing.

**That is the signature of the 14 leads lost 31 Jul - 1 Aug, and of +60186682249 on 17 Aug**
("Hello! Can I get more info on this?", Brand HQ, phone present, Salesman empty). Every one was
recoverable in a single round-robin call, and nothing ever looked.

### 🚨 The reporting contract this serves (Benjamin, 2026-08-17)
**发现 → 自己 fix → 3 次不行 → 才通知群组** — the same rule the self-heal alerts already use.
A lead the bot can rescue **must never reach a report**. Only after `MAX_TRIES` (3) failed attempts
does it become a human's problem and earn a line on the sales card. *A report that lists work the
system could have done itself is how a report becomes wallpaper.*
- **A success DELETES the state entry**, it does not record a win: the row stops matching the Lark
  filter, so a kept entry only rots, and a re-orphaned lead should start from a clean count.
- `GET /orphans` is the sales card's ONLY input: `needsHuman` = tried 3×, still stuck. Empty ⇒ the
  card says "all assigned" and nothing more.
- A DM that did not send is **NOT** a recovery. Counting it would hand a rep a lead they never heard
  about and then delete it from the retry list — a silent second loss.

### 🐛 Found by the test, not by reading: `0 = disabled` was not disabled
The cutoff guard was `created < cutoff`. **Nothing is less than zero**, so with `ORPHAN_FROM` unset
the sweep would have matched EVERY row — including the 11-17 day old stuck leads Benjamin
explicitly ruled must not be auto-assigned. An unarmed feature that quietly recovers everything is
the opposite of a safety cutoff. Now an explicit `if (!cutoff) return []`.
🚨 `SLA_SWEEP_FROM` documents the same "0 = disabled" contract — it is enforced there by a separate
`if (!SLA_SWEEP_FROM) return`. **Do not assume a comparison against 0 disables anything.**

### Guards
- Scope is `Origin='WhatsApp Direct'` only. TikTok rows are assigned by `sync.py`; a second assigner
  on the same rows is how one customer gets two salespeople.
- **20-minute grace** — the normal path writes the Lark row then assigns, and the off-hours path
  parks for the 9am drain. Both look like an orphan mid-flight.
- Distribution window only (`inFRDistHours`): a Saturday orphan waits for Monday like every other
  deferred lead. Recovering it into a rep's phone on a day we do not assign is not a fix.
- Junk-phone guards mirror intake (`<9` or `>13` digits, `447*`) — a number a rep cannot dial is
  worse than leaving the row alone (2026-08-02).
- `pruneState` drops rows a human assigned in the meantime, so an exhausted entry cannot nag forever.
- Reuses `lead.staff` from `assignLeads` rather than re-deriving from `STAFF` — two sources of truth
  for one fact always drift.

**Env to arm it:** `ORPHAN_FROM=<epoch-ms cutoff>` (0/unset = off) · `ORPHAN_CAP` (default 10) ·
`ORPHAN_STATE_FILE` (defaults beside `FR_STATE_FILE` ⇒ `/data`).
**Rollback:** unset `ORPHAN_FROM` + redeploy. Additive; nothing else changes behaviour.
Tests: orphan **29** (new) · full suite **796**.

## 🚨 A DATE BEFORE THE LOG BEGINS IS NOT A QUIET DAY — 2026-08-17

**Measured, not predicted.** `GET /lead-summary?date=` was asked for every date 03–16 Aug. Every one
answered **`total: 0, sumOk: true`** — a confident, verified-looking zero. Sat 15 Aug is recorded in
this very file as **29 inbound chats / 25 Lark rows**.

**Root cause: lead logging only deployed 17 Aug 12:07 MYT, so `fr_events.jsonl` does not reach back.**
Rule 3 ("a failed read says couldn't read, never 0") guarded an unreadable file and an unmounted
`/data`. It never guarded **a perfectly healthy file that simply does not cover the date asked** —
which is the dominant real case, and the one that produced a client-facing lie.

| Situation | Before | Now |
|---|---|---|
| Date entirely before the log | `📥 0 leads` | `no_data: true`, **no count fields at all**, card says *"NOT a quiet day"* |
| Window straddles the log start | silent undercount | counts, plus `⚠️ These counts only cover HH:MM onward` |
| Date fully inside the log | unchanged | unchanged |
| Empty log | `0 leads` | blind, not quiet |
| Unreadable file | `read_error` | `read_error` still wins — two different facts, two different messages |

- 🚨 **`no_data` emits NO `total`/`sumOk`/`buckets`.** A zero that does not exist cannot be read as
  a zero by anything downstream. Same shape as `read_error`, for the same reason.
- ⚠️ **The 17 Aug card is ITSELF partial** — it covered from 10:00 but logging began 12:07, so its
  "9 leads" is an undercount. `partialFrom` now says so on the card.
- `logFirstMs` is derived from the events, so it moves correctly if the file is ever pruned.
  Reduce, never `Math.min(...spread)` — the log is unbounded and a spread would blow the stack.

### 🐛 Found by the suite, not by reading: the char budget never actually bounded the card
Adding one header line pushed the real 54-lead card from 3,693 to **4,083 chars** against a 4,000
assert (WhatsApp hard-rejects at 4,096, and `alertReview` does not truncate — an over-long card
simply never arrives). `BLOCK_CHAR_BUDGET` only ever governed **entry** text; category headers, the
backlog line and the "N more not shown" line always rode on top of it, and the header was assumed
near-constant. It is not anymore.
**Fix:** `needsALookText` takes a `charBudget`, and `summaryText` **measures the assembled card and
tightens until it fits** (≤3,900, max 6 iterations) instead of trusting a constant. Severity
ordering means what gets dropped is always the least severe. 🚨 **Do not replace this with a
hand-tuned allowance** — that is the assumption that just broke.

### ⚠️ What the other sources can and cannot back up (verified 2026-08-17)
| Figure | Source | Trust | Reaches back to |
|---|---|---|---|
| Old backlog (15) | Lark | ✅ full history, no page cap hit | all of it |
| Gate / no-phone | `gate_events.jsonl` | ✅ | 04 Aug (feature go-live) |
| Daily lead counts | `fr_events.jsonl` | ⚠️ | **17 Aug 12:07 only** |
| "In the inbox but not in our log" | box-66 console | 🔴 **~4 days** | **13 Aug** |
| Lark `Stage` column | Lark | 🔴 **no signal** | 677 of 680 rows = `Passed lead`, a default |

- 🔴 **The box-66 console is NOT an archive.** This file elsewhere claims it "persists EVERY
  forwarded message" (true when written, used for June reconstructions). Live store now holds
  **nothing before 13 Aug 09:00 MYT** — sampled across 11 chats incl. the 758-message intake group.
  Mechanism (reset vs prune) could not be determined from the API. **Any inbox-vs-log claim older
  than ~4 days is unverifiable, and the card's `(0 new)` on that category means "cannot see".**
- 🔴 **WaSender's token has no read scope** (`/api/chats` returns an HTML login page), so the console
  is the ONLY inbox mirror. There is no second place to go for old history.
- ⚠️ `/gate-status` returns only the **last 500 events** and computes `event_counts` from that same
  slice, with no truncation flag. 179 events today at ~14/day, so it starts silently lying in ~5 weeks.

## 🔁 THE LLM MAY UPGRADE TO `sell`, NEVER DOWNGRADE ONE — 🟢 LIVE 2026-08-17 (`94e2b09`)
Two trade-in customers in two days went to a salesperson instead of **Fitri the purchaser**, so TM
never bought the bike. Both were caught by the 09:57 FR self-audit, one day apart:

| | Customer's first message | `aiClassify` said | Truth |
|---|---|---|---|
| 16/08 | `Cbr650r / Mt25 / Trade in mt25 2024 mileage 25k` | `product` (the model names won) | **sell** |
| 17/08 | `hi boss nk tnye moto masih ade loan lgi boleh trade in` | `greeting` (the hello won) | **sell** |

🚨 **`RE_SELL` had BOTH right.** It only fires on an explicit "I want to sell/trade-in MY bike" and
already strips the `kedai ada jual X?` shop-sells trap before testing — when it says sell, it is
sure. `classifySmart` handed the verdict to the LLM **unconditionally**, so a correct regex verdict
was silently overwritten by a wrong model one.

**The guard is deliberately asymmetric** (`firstresponse.js`, in `classifySmart`):
```js
if (rx.cat === 'sell' && cat !== 'sell') return rx;   // LLM may not downgrade
```
The LLM keeps its whole job in the other direction — it reads Malay phrasings (`jual`/`tolak`/
`lepas`/`let go`) a regex will never keep up with, which is why it was added on 24 Jul. **The costs
are not symmetric:** a wrong `sell` costs one redirect inside the shop; a missed one costs the
trade-in, and TM buys its used stock this way.

Prompt tightened in the same change for the phrasings the regex genuinely misses (`index.js`
`CLASSIFY_PROMPT`): `greeting` is now stated as a **LAST RESORT** with the 17/08 message as the
worked example, and the priority line reads `sell beats loan beats product beats greeting` plus
*naming bike models does not make it product when the customer is also handing us a bike*.

⚠️ **Do not "simplify" the guard away.** Two call sites in `classifySmart` differ only by where the
verdict is trusted; the safe one was reasoning, not luck. `sell_override_test.js` (14) pins both real
messages, the shop-sells trap and the 24 Jul trade-in-with-loan trap — **verified in both directions:
removing the guard fails 4 of them.** Full suite **751**.

## 🌙 "DON'T SAY WE ARE CLOSED" — off-hours qualification — 2026-08-16 (batch 3)
🟢 **LIVE** — batches 1–3 deployed 2026-08-17 12:07 MYT (through `7976d3e`).
⚠️ The short-ask tweak below (2026-08-17) is **committed, NOT deployed** — it lands on top of
running production code.

Client: *"Outside operating hours, don't say we are closed now. Say something like I will get the
sales person to contact you in the next working day ya."* Plus: qualify the customer first, so the
salesperson opens **"Z900 RS, loan"** on Monday instead of **"Hi"**.

### What a Friday 17:16 customer now sees
```
👤  Hi bos, z900 ada stok tak?
🤖  ✅ Ada ya bos, 2019 Kawasaki Z900 RS (31,000 km). Salesman kami akan confirm harga & plan bulanan dengan bos ya.

    Boleh saya tahu sikit, tuan minat model yang mana ya? Nak cash atau loan? 😊 Saya pass semua detail kat salesman supaya dia terus boleh bantu tuan.
👤  Z900 RS, nak loan
🤖  Sales advisor kami akan contact tuan Isnin pagi ya 🙏 Terima kasih tuan.
```
**The `⏰ Waktu operasi kami: …` sentence is REMOVED ENTIRELY.** `tpl()`'s 5th parameter changed
meaning with it: it was `closed` (a boolean), it is now `nextLabel` (`{bm,en}` or null).

### 🚨 The day is COMPUTED, never written
`hours.nextWindowLabel(nowMs, days, startH, endH)` derives it from the **DISTRIBUTION** window
(`FR_DIST_*`), not the operating hours — those are two different facts and merging them is the
2026-07-30 incident. Hardcoding "Isnin" would be that same incident again.
- Open right now → **null**, and the reply promises no day at all (a rep is getting it).
- Later today → `pagi ini sebentar lagi` · tomorrow → `esok pagi` · otherwise the weekday name.
- ⚠️ **After 21:00 it names the day instead of saying "esok".** At 23:00 on a Sunday "esok pagi" is
  technically right and practically confusing: the customer reads it minutes from midnight, and a
  lead they expect "tomorrow" is a lead they think was missed.
- 🚨 **The unresolved Saturday question stays env-only, end to end.** The same Friday 17:16 renders
  `Isnin pagi` under `FR_DIST_DAYS=1,2,3,4,5` and `esok pagi` under `1,2,3,4,5,6`. Both are tested
  in `hours_test.js` **and** driven end-to-end through the real flow in `qualify_test.js`.

### The qualify machine
`state.pending` → `state.qualify[jid] = { ts, asks, cat, want, lang, recordId, phase }`, on `/data`.
Legacy `pending` entries **migrate on load** (`phase:'model'`) so nobody mid-greeting is stranded at
deploy. `PENDING_MODEL_MS` **48h → 72h** (a Friday ask answered Monday is 62h later).
- 🚨 **The Lark row is written and the staff half queued on the FIRST message, unchanged.**
  Qualification is layered on top and can never delay or replace it. **A customer who answers
  nothing is still queued and still assigned at the next drain** — the non-negotiable test.
- Answers PATCH `Customer want` **and the queued entry** (`larkPatchWant`). Patching Lark alone
  would leave Monday's rep DM carrying the stale pre-qualification snapshot.
- 🚨 **Ordering: qualify FIRST, phone gate LAST.** A no-phone customer is qualified before the
  number is asked for. ⚠️ This was **wrong in my first pass** and only surfaced because the test
  asserted the ordering: the no-phone branch still asked for the number first. No Lark row is
  written for them until the gate resolves (a row with neither number nor salesman is unactionable
  — the 2026-07-30 `staff:null` shape).
- 🚨 **ONE Lark row per customer.** The qualify flow parks a row on message 1, so `gateRelease` on
  such a lead PATCHES the phone onto it (`larkPatchPhone`) instead of calling `assign()` again.
  A second call meant **two salespeople ringing one customer about one enquiry.**
- **Touch cap ≤3**, enforced structurally: a qualify-born hold gets `maxAsks = 1` at the gate, so
  the evening total is answer+qualifyAsk → re-ask *or* closing → gate ask.
- `sell` excluded (its template already asks model/year/photos and routes to Fitri).
- The drain calls `clearQualify(jid)`: a rep owns the chat, the bot stops quizzing.

### 🚨 THE LANDMINE, AND THE TEST THAT GUARDS IT
`markHuman()` fires on ANY `fromMe` message — **including the bot's own sends echoing back** — so
the chat is flagged human-owned the instant the bot asks its qualifying question. On 2026-08-05 that
binned **4 of 4** real phone numbers and made the gate report **0% conversion when the truth was
100%**, a false number that was nearly used to scrap the feature. `state.qualify` is now in the
`midFlow` exemption, as the code comment there demands of every future waiting-on-the-customer state.
**I verified the test refuses:** deleting `state.qualify` from `midFlow` fails 3 assertions in
`qualify_test.js` (`THE ANSWER IS HEARD, not dropped`). A test that only passes today is not a guard.

**Kill switch `FR_QUALIFY=0`** — pre-qualification behaviour, but the closure sentence stays removed
and the computed closing day stays. The client banned that sentence; a kill switch must not resurrect it.

### ✅ RESOLVED 2026-08-17 — the ask now adapts to what the customer already told us
The open copy question above is answered (client approved). Asking *"tuan minat model yang mana ya?"*
immediately after the bot has **named the exact unit** reads like it wasn't listening.

| Customer's first message | Ask |
|---|---|
| Names a model (`"z900 ada stok tak?"`) | **short**: `Nak cash atau loan ya bos? 😊 Saya pass semua detail…` |
| Names nothing (`"Hi"`, bare ad click) | **full form, byte-identical to before** |

- 🚨 **The signal is `RE_BIKE`** — the one the code ALREADY trusts to mean "a bike was named": it is
  what routes a message to `product` in `classify()` and what gates `stockLineFor()`. Deliberately
  **not** a second signal invented for this; two sources of truth for one fact always drift.
- Three call sites, audited: the qualify-machine re-ask passes the `modelKnown` recorded on the
  entry (same original message, same answer) · the greeting path passes **`false`** by definition ·
  the main off-window path computes `RE_BIKE.test(text)`.
- ⚠️ **An entry written by the previously-deployed build has no `modelKnown`.** `undefined` is
  falsy, so an in-flight customer gets the full ask — exactly today's behaviour. No migration.
- ⚠️ **KNOWN IMPRECISION, reported not worked around.** `RE_BIKE` also matches **bare BRAND words**
  (`yamaha`, `ducati`, `ktm`…, added 2026-07-22 because brand-only enquiries got no reply at all).
  So `"ada yamaha apa2"` reads as "model known" when it names a brand, not a model.
  - **Usually self-correcting:** a brand query with several Woo matches gets the multi-match stock
    line, which already ends *"Yang mana satu bos berminat ya?"* — the model question is still asked,
    just by the stock line rather than the qualify ask. Verified by rendering.
  - **The residual gap** is a brand-only message with NO Woo match: the neutral stock line plus the
    short ask, and the model question is genuinely not asked. Verified by rendering.
  - It is a **copy-precision** issue, not a lead-loss one — the lead is still parked, still queued,
    still assigned, and the rep still gets cash-or-loan. Tightening it would mean splitting `RE_BIKE`
    into model-vs-brand tokens, i.e. the second signal this deliberately avoids. **Flagged for the
    client's call, not fixed.**

Tests: hours **41** (+25) · qualify **78** (new) · firstresponse **174** · full suite **737** (was 633).

## 👀 "NEEDS A LOOK" — the report's real job, and gap-proof windows — 2026-08-16 (batch 2b)
⚠️ **CODE COMMITTED, NOT DEPLOYED.** VPS half is live and idle until the endpoint ships.

Client feedback on batch 2, in their words: *"need more info for leads that is unsure or suspicious,
so the admin can cross check, **that is the main point**."* **The counts were never the product.**
Three changes.

### 1. Report times → 10:00 and 16:00 MYT
The bot's own SLA digest still fires at **12:00 and 18:00, unchanged**. All four are in-bot timers on
the one existing 5-min interval. **No new cron.** ⚠️ Deliberately independent of the 09:57 VPS
`audit_fr.py` run, which makes OpenAI calls and can overrun: the cards read the decision log and Lark
directly, and the VPS cross-check stays a separate safety net.

### 2. 🚨 Windows are CONTIGUOUS and anchored on the last SUCCESSFUL SEND, not on the clock
The 10:00 card covers everything since the last 16:00 card; the 16:00 card covers 10:00 → 16:00.
**Implementing that with fixed clock times would have opened a 24h hole every single week**: with
Sunday skipped, "Sat 16:00 → Sun 16:00" belongs to no report at all. So the window start is the **end
timestamp of the last report that actually sent**, persisted in `summary_mark.json` (env
`SUMMARY_MARK_FILE`, `/data` in prod, same pattern as batch 1).

| Situation | What happens |
|---|---|
| Skipped Sunday | Mon 10:00 covers **Sat 16:00 → Mon 10:00 (42h)** |
| Bot down at 10:00 | the 16:00 card absorbs that span |
| Restart mid-window | marker is on disk, so no gap and no double-count |
| **Send FAILS** | 🚨 marker does **not** advance, window stays open, next card re-covers it |

- `alertReview()` now **returns whether the group actually received it**, and the marker moves on
  that boolean and nothing else. A failed send must never be able to skip a window.
- Every card prints its own window: `🪟 Window: Sat 15 Aug 16:00 → Mon 17 Aug 10:00 (42h, covers the
  weekend)`. Longer than normal ⇒ it **says why** (weekend, or the previous report did not send).
- No marker on a first run ⇒ falls back to the usual boundary and **says it is a fallback** rather
  than silently reporting a partial window. A marker dated in the FUTURE is treated as no marker.

### 3. 👀 The NEEDS A LOOK block — seven categories, severity-ordered
`🚨 nobody took it → ⏰ parked too long → ⚠️ inbox gap → 📵 cannot be contacted → 📤 not delivered
→ ❓ could not classify → 🔁 came back, got silence`, stalest first inside each. Every entry carries
**timestamp · phone or @handle · their first message verbatim (~70 chars) · what the bot did · a
`wa.me` link**.
- 🚨 **Never a fabricated `wa.me` link.** No number ⇒ "reply in the *TM Marketing (93210)* inbox".
  A dead link that looks actionable is the 2026-08-02 failure wearing a new hat.
- **⏰ parked too long** is read from **Lark, not the decision log** — the exact 14-lead signature
  (`Origin=WhatsApp Direct` + Salesman empty + `SLA Assigned At` empty, older than the last drain),
  because the whole failure mode is the queue being GONE while the CRM row survives. Age in days.
  `lastDrainStart()` works under `FR_DIST_DAYS=1-5` **and** `1-6`, so Q1 stays env-only.
- **❓ could not classify** needed a new signal: `classifier_skip` conflated **a vendor robot**
  (ignore forever) with **a message the classifier could not read** (a possible buyer who got
  nothing). Now `vendor_auto` vs `unclassified`, and only the second reaches the block.
- **📤 not delivered** reuses `alertSendFailure` — the one place that knows a send was given up on.
  It now *records* as well as shouts, via the existing durable digest store. ⚠️ Digest retention
  raised 26h → 8 days so a Saturday failure still appears on the Monday 42h card.
- ⚠️ **⚠️ inbox gap CANNOT be derived here and the card SAYS SO.** The Render bot genuinely cannot
  read box 66's capture file. It is checked by `audit_fr.py` at 09:57 and the category renders
  *"checked on box 66 by the 09:57 audit, not from here"*. **Approximating it would be inventing a
  number.**

### 🐛🐛 Two bugs found by RENDERING THE REAL BACKLOG, not by reading the code
1. 🚨 **The card was 6,322 chars. WhatsApp rejects anything over 4,096 (422).** And `alertReview`
   does **not** route through `waSend`, so it has none of `waSend`'s truncation — an over-long card
   is not trimmed, **it simply never arrives**. With the real 54-lead Lark backlog the client's most
   important report would have failed silently on day one. Fixed with a character budget
   (`BLOCK_CHAR_BUDGET`) on top of the entry cap; severity ordering means the worst entries are the
   ones that survive, and the true count still prints (`⏰ Parked too long (54)`) alongside
   `⚠️ 42 more not shown`. Real card now **3,693 chars**.
2. `[ad click — model belum stated…]` is a **bot-authored** string that now renders on the card, so
   it was swept to a comma. ⚠️ Rows written before this still carry the em dash, so it will show in
   quoted historic data for a while. Customer text is quoted **verbatim** by design, so the dash
   assert covers bot copy, not what a customer typed.

### 🐛 Corrections after the coordinator re-verified against live Lark (2026-08-16)
**Two things, and only one of them was a code bug. Be precise about which.**

1. **My "Parked too long (54)" was a BAD VERIFICATION, not a boundary bug.** `lastDrainStart`
   returned the correct `Fri 14 Aug 09:00` at the real clock. I rendered the card with `now = Mon
   17 Aug 10:00` — a *future* clock — against a Lark snapshot taken Sunday evening, so leads that
   had not yet had their Monday drain looked overdue. 🚨 **A replay whose clock and whose data
   come from different moments will produce a confident, wrong number.** Pin both to the same
   instant, or the render is fiction.
2. **A REAL bug the review exposed: "the last drain that OPENED" ≠ "the last drain that
   COMPLETED".** The drain releases one queued entry per 60s tick, so at 09:05 on a Monday it is
   minutes into a weekend backlog. Taking the opening instant as the boundary flagged **every**
   weekend lead as "parked too long" *while the drain was still running* — 39 healthy leads
   presented to an admin as failures on the first morning. Now `lastCompletedDrain()` with a
   `DRAIN_GRACE_MS` (60 min) hold-off. Live counts at Sun 16 Aug 21:00: **89** unassigned
   WhatsApp-Direct rows · **54** match the stuck signature · **15 genuinely stuck** (before
   Fri 14 Aug 09:00) · **39 normal weekend leads that must NOT be flagged**.
   Regression tests: same lead at three clocks (Sunday, mid-drain Monday 09:05, Monday 10:00),
   plus the exact-drain-minute boundary, under `FR_DIST_DAYS=1-5` and `1-6`.
3. ⚠️ **My first grace value (60 min) was sized off a WRONG PREMISE.** I wrote that the drain
   "releases one entry per 60s tick". It does not: `drainFRDeferred` holds a
   `while (frDeferred.length && inFRDistHours())` loop that empties the **whole queue in one
   invocation**, and the 60s interval merely re-triggers it. The real pacing is the serialized
   send chain, `SEND_GAP = 5200`ms, so a 46-lead backlog drains in **~4 minutes, finishing ~09:04**.
   🚨 A 60-minute grace put "completed" at exactly **10:00 — the moment the report fires**, with
   *literally zero margin* (`09:00 <= 09:00`): one second early, or any change to the report time
   or `FR_DIST_START`, and a totally dead drain would render as a clean morning.
   **Now `DRAIN_GRACE_MIN`, default 15** (~3.5× the real drain time). ⚠️ Note the coordinator's
   requested pin (dead drain → 10:00 card shows the full backlog) passes under BOTH values; what
   actually discriminates is 09:15–09:59 and the zero-margin instant, so the suite also **pins the
   default itself** — otherwise raising it back to 60 breaks nothing while reopening the race.
   🚨 **The grace must never approach the gap between the drain and the card.**

### ⚖️ The `Yamaha MT15` row stays on the list (Benjamin, 2026-08-16) — do NOT re-raise
I proposed a suppression marker for it. **Rejected, and the reasoning is worth keeping**: it is a
real 6 Aug customer with no reachable number, recovered record-only, and **nobody has ever picked
them up**. It is not a false positive, it is an unresolved lead correctly appearing on a list of
unresolved leads. A row leaves the list the moment someone assigns a salesman. **Do not build a
mechanism to hide work that has not been done**, and do not modify that row.

### 🔴 A permanent nag list becomes wallpaper
Those 15 would have appeared on every card forever. By Wednesday the admin scrolls past the block
and a genuinely new stuck lead hides inside a list they have stopped reading — the same failure as
an alert nobody acts on. So the block now splits on the window marker it already keeps:
- **Only entries NEW since the last report are detailed.** Headline counts new: `👀 NEEDS A LOOK
  (1 new)`, category reads `⏰ Parked too long (1 new, 15 already known)`.
- Everything already reported collapses to **one line**:
  `🔴 Old backlog: 15 lead(s) still stuck (oldest 17 days, unchanged) → /lead-summary`.
- 🚨 **A GROWING backlog is the signal**, so it is called out: `🔺 … UP from 15 at the last report`.
  The count rides on the window marker (`summaryMark.backlog`), persisted only on a confirmed send.
- Applies to every category generically. In practice only `parked_long` can persist — the
  event-derived ones are already window-scoped and are therefore always new.

**Proof it still screams when it should:** modelling a FAILED Monday drain (the 14-lead scenario
repeating) renders `👀 NEEDS A LOOK (24 new)` + `🔺 Old backlog: 30 … UP from 15`, 3,944 chars.
The realistic card, with the drain succeeding, is `(0 new)` + one backlog line, 1,182 chars.

### Verified on real data (2026-08-16)
- **Sat 15 Aug: 29 inbound chats vs 25 Lark rows.** The 4-lead gap is **four salespeople sending SLA
  acks** — Allysa `PASS`, Jebat `✅`, Nazrin `👍🏻`, Roy `Done` — logged `ai_skip(staff_or_internal)`,
  excluded from lead totals, shown on the "not sales leads" line. The VPS audit independently
  measured `inbox_chats=29`. **29 − 4 = 25 = Lark. Reconciles exactly.**
- **All 14 orphans of 31 Jul–1 Aug surface** in ⏰ parked too long with correct ages (**16–17 days**),
  first `recvqWC7aSoj5n` +60126233609, last `recvr0Q02rcLni` +601156402131.
- Live Lark today shows **54** rows matching that stuck signature, not 14. The backlog is real.

Tests: leadsummary **100** · firstresponse **173** · full suite **599** (was 544).

## 📋 "HOW MANY LEADS TODAY, HOW MANY ASSIGNED, WHY NOT THE REST" — 2026-08-14 (batch 2)
⚠️ **CODE COMMITTED, NOT DEPLOYED.** The Render half is not live. The VPS half IS live and is
deliberately idle until the endpoint ships (see the PENDING note below).

Harith's ask is three numbers. **None of them could be answered**, and the reason is structural:
**Lark only records the leads that SUCCEEDED.** A chat the bot skipped, held at the phone gate, or
handed to a human writes no row at all — so "why wasn't it assigned" had no source. Render rotates
logs within hours, so the only other trace was gone by morning.

### The decision log (`fr_events.jsonl`)
One JSONL line per DECISION, beside the gate log on `/data` (derived from `FR_STATE_FILE`, so no new
env var in prod). Best-effort exactly like `gateLogEvent` — **a logging failure must never break a
lead**, and there is a test that throws `ENOSPC` at it and asserts the customer still gets their
reply and the lead still reaches Lark.

| Outcome | When | Counts as a lead? |
|---|---|---|
| `assigned` · `parked` · `no_rep` | from `assign()`'s ctx, logged at the ONE call site per path | ✅ |
| `gate_held` | phone gate holding — **Lark has no row for these at all**, so nothing else can see them | ✅ |
| `awaiting_model` | greeted, waiting for "which bike" | ✅ |
| `ai_skip` | vendor/OTP (`classifier_skip`), `junk_number`, `no_identity`, `staff_or_internal` | ❌ |
| `human_owned` | a human replied first, or took over a hold | ❌ |
| `repeat` | already greeted within 7d, bot silent by design | ❌ |

- 🚨 **Logged at the CALL SITE, never inside `assign()`** — a gate release goes through `assign()`
  too, so logging in both places would double-count every held lead.
- **`repeat` exists only for reconciliation** (Benjamin approved). Without it the inbox cross-check
  reads every returning chatter as a webhook the bot never received.
- **`staff_or_internal` is logged on purpose.** The VPS cross-check has to apply the same staff
  exclusion the bot applies, and the only drift-free way is for the bot to say so. The alternative
  was a **5th copy of the roster** on box 66 — and roster drift has already cost TM leads four times.

### `leadsummary.js` (+ `leadsummary_test.js`, 46 tests) — the three rules
1. **Buckets are mutually exclusive and must sum, or the card says so.** `total` is counted
   independently (one per lead chat) and compared to the sum of the buckets the card knows how to
   print. An outcome nobody taught the file about lands in `other`, **breaks the sum**, and prints
   `⚠️ buckets don't sum to the total (X vs Y)`. Tested with a deliberately bogus outcome.
2. **Two independent sources, both numbers printed when they disagree.** Lark rows created that day
   vs the log's `assigned + parked`. Lark unreadable says so; a 100-row page cap says so.
3. 🚨 **A failed read says "couldn't read", never 0.** `summarize()` short-circuits before any
   counting, so there is no code path where an unreadable log produces a number.
- **Lead-day attribution**: a lead belongs to the MYT date of its FIRST event (96h lookback) and is
  counted by its LATEST event. That is what stops a Friday lead being counted again on Monday —
  Monday shows it as `🔁 earlier lead resolved today` instead.
- 🚨 **PERMANENT FIXTURE: the 14 lost leads**, like the R1/forza ones. 8 on Fri 31 Jul + 6 on Sat
  01 Aug, all `parked`, and Monday must claim none of them.

### 🐛 Found by running it, not by reading it: ENOENT means two opposite things
Pointing the live endpoint at a bad path made it answer **`total: 0`** with complete confidence.
`readFrEvents` treated every `ENOENT` as "fresh disk, no leads yet". But **a missing FILE in a
healthy directory** and **a missing DIRECTORY** are opposite facts: the second means `/data` is not
mounted or `FR_EVENTS_FILE` has a typo, and reporting "0 leads today" then is the exact lie this
whole module exists to prevent. Now it `accessSync`es the parent directory and returns a read error.
**One unmounted disk away from telling the client a quiet day.**

### Delivery
- `digestTick` now has **three** windows: **12:00** SLA card **+ the summary appended to it** (one
  message, not two) · **16:00 summary alone** (new) · **18:00 SLA end-of-day, byte-identical to
  today**. Both summaries are **day-to-date** regardless of the SLA window above them.
- ⚠️ **`digestTick` moved OUT of the `if (SLA_ON)` block.** It used to be registered inside it, so
  toggling the SLA engine off would have silently killed the CLIENT's report too — the same
  "9 unregistered reports" failure class. `buildDigest` gates the SLA half per-kind instead.
- **Sunday is skipped** (TM operates Mon–Sat; Benjamin, 2026-08-14). The 18:00 SLA card is unchanged.
- `GET /lead-summary?date=YYYY-MM-DD` — read-only. ⚠️ **A read failure returns HTTP 200 with
  `read_error` and NO count fields**, never a 500: a 500 would leave the sentinel unable to tell
  "bot down" from "log unreadable". `sent` exposes the digest markers so the probe can prove the
  cards went out (durable now they live on `/data` — batch 1).

### Box 66 — 🟢 LIVE, no new cron
Backups taken: `audit_fr.py.bak-pre-summary-20260814` · `sentinel.py.bak-pre-tmsummary-20260814`.
- **`audit_fr.py`** (existing 09:57 cron) gained a day-scoped cross-check: distinct non-group inbound
  chats in the box-66 capture for yesterday vs `/lead-summary?date=yesterday`. Prints BOTH numbers
  when they differ. ⚠️ It counts **`@lid` chats too** — the pre-existing 24h audit above it filters
  on `@s.whatsapp.net` only and therefore **silently ignores 14% of TM's leads**. Not fixed here,
  flagged.
- **`sentinel.py`**: `tm-lead-summary-xcheck` + `tm-fr-audit` registered in `JOBS`, and
  `probe_tm_summary()` probes the report BY OUTCOME (it runs inside Render and cannot beat here) —
  after 12:30/16:30 MYT today's sent-marker must exist; a `read_error` is `BLIND`, not healthy.
- 🚨 **I watched both refuse, for real.** Before the endpoint existed they went `FAILED` /
  `UNKNOWN` and fired a real alert to the PA group. That is the guard working — but a 6-hourly alarm
  for something nobody can fix until a deploy window opens is noise that trains people to ignore the
  group. So "the bot answered but this route isn't on the deployed build" (non-JSON body) is now
  **`PENDING`** and stays quiet; a genuine unreachable host is still `UNKNOWN` and still alerts.
  **It flips to live by itself the moment the endpoint ships — nobody has to remember.**

**Env:** `FR_EVENTS_FILE` only, and it is optional (defaults beside `FR_STATE_FILE` → `/data`).
The 16:00 window is code, not config — a second env-driven clock is how the hours drifted in July.
**Rollback:** the report is additive. Reverting removes the endpoint + the 16:00 window; the 12:00
card returns to SLA-only and `fr_events.jsonl` keeps appending harmlessly. VPS: restore the two `.bak`s.

Tests: leadsummary **46** (new) · firstresponse **172** · gate **70** · full suite **544**.

## 🚨 THE 14 LOST LEADS, AND WHY THE QUEUE COULD NOT SURVIVE A DEPLOY — 2026-08-14 (batch 1)
⚠️ **CODE COMMITTED, NOT DEPLOYED.** Nothing below is live until someone pushes and sets the env vars.

**Fri 31 Jul 18:14 → Sat 01 Aug 11:34, 14 real customers were parked for the Monday drain and never
reached anyone.** Two independent defects had to line up, and both are now closed:

| | What went wrong | Fix |
|---|---|---|
| ① | `fr_deferred.json` sat on Render's **ephemeral** disk. The Sun 02 Aug 23:41 deploy wiped the parked-lead queue outright. | `FR_DEFER_FILE` env → `/data/fr_deferred.json` (the 1GB disk `fr_state.json` already uses) |
| ② | The boot rehydrator's backstop only reached back **36h**. A Friday-17:00 lead needs **64h** to reach Monday 09:00 — 36h can *never* rescue a weekend. | `REHYDRATE_DEFER_H`, default **96** |

The boundary matches to seven minutes: the 36h cutoff reached back to Sat 11:41, the last orphan was
11:34, the first recovered lead 12:08. **The backstop was not "mostly working" — it was structurally
incapable of covering the one gap it existed for.**

- **96h, not 72h** (Benjamin, 2026-08-14). 72h covers a normal weekend (64h) but **not** Fri 17:00 →
  a public-holiday Tuesday 09:00, which is 88h. Re-queueing an already-assigned lead is harmless —
  step 3 requires `Salesman` empty **AND** `SLA Assigned At` empty and dedupes by recordId — while
  losing one is not. Take the slack. Rollback is `REHYDRATE_DEFER_H=36`, env only.
- **Two siblings moved in the same change**, same defect, one line each:
  `BULK_QUEUE_FILE` (documented 2026-07-21: "mid-drain redeploy loses the queued batches" — the
  rehydrator's part-4 rebuild is a mitigation, not a fix) and `SLA_DIGEST_FILE`. The digest store
  matters more than it looks: it holds `digest.sent`, the "already sent the 12PM card" markers, so a
  deploy at 12:00–12:15 makes the card **double-fire**.
- Bonus, **env-only, no code change**: `sla.js:6` already honours `SLA_STORE` — point it at `/data`
  and in-flight SLA timers survive deploys too.
- ⚠️ **First boot with the new envs starts each file EMPTY on `/data`** (the old copies died with the
  ephemeral disk anyway). Rehydrate backfills the deferred queue; bulk part-4 backfills the bulk
  queue. The digest `sent` markers start empty, so **deploy outside 12:00–12:14 and 18:00–18:14 MYT**
  or the card can re-send once.
- 🚨 **The real test is not a unit test.** These constants live in `index.js`, which boots a server on
  require and therefore cannot host tested logic. After deploying: confirm `/data/fr_deferred.json`
  exists after the next `FR 🌙 … deferred` line, then **trigger a manual redeploy at night on
  purpose** and confirm the 9:00 drain still releases it (`🌅 FR deferred drain: releasing N`). That
  redeploy-and-drain is the exact scenario that lost the 14 leads. Do it once, deliberately.

### 🗣️ "Saya customer service je" — the bot stops sounding like it can approve a loan
Same commit. Two approved copy changes (Benjamin, 2026-08-14), both aimed at the same failure class
as the 08-10 price incident: **the bot making a claim only a salesperson can stand behind.**
- **Loan** (`tpl()`): still names every real financier (Harith 2026-07-20 — and CIMB EPP is still
  explicitly called out as unavailable), but now says outright *"Saya customer service je ya, jadi
  untuk detail loan & kelulusan salesman kami lagi arif"*, then confirms the handoff already
  happened. ⚠️ The `👇` pointer is appended **only when a card actually follows** — parked, held and
  no-rep leads get no card, and an arrow pointing at nothing reads as a broken message.
- **Price inside a product enquiry** (`RE_PRICE` → `stockLineFor`): when the customer asks a price,
  *"Untuk harga & plan bulanan saya customer service je, tak berani bagi angka salah 🙏"*
  **REPLACES** the old "salesman will confirm the price" tail — it never appends. Two
  salesman-will-confirm sentences in one message is the double-say the tests count occurrences to
  prevent. Applies to used-single, used-multi (after the "Yang mana satu" clarify), wants-NEW (the
  cash-or-loan qualifier is kept) and the no-match neutral line (where the CS line stands **alone**).
  Booking replies are untouched — no price is ever discussed there.
- ⚠️ `RE_PRICE` is deliberately **not a category**. It only flavours a closing sentence, and is only
  consulted once the category already resolved to `product`, so a loan message never gets both.

### ➖ The dash sweep, and why a hand-written inventory was never going to hold
Every bot-authored message dropped the em dash `—` and any standalone ` - `. **Kept**: hyphens inside
words / model names / phones (`012-932 3259`, `MT-09`, `V-Strom`, `trade-in`), the **en dash `–` in
hour ranges** from `hours.js` (`9 pagi–6 petang` is a range, not punctuation), and `•` bullets.
🚨 **`RE_USERNAME_KV` still contains a `—` and must keep it** — that one PARSES customer input
(`username — foo`); removing it breaks the phone gate.
- Sentences were **rewritten**, not truncated: `✅ Ada — Kawasaki Vulcan S` → `✅ Ada ya bos, Kawasaki
  Vulcan S`; `One thing —` → `One thing ya,`; `Satu je bos —` → `Satu je bos,`.
- ⚠️ **The counts were wrong three times.** The brief said 17 customer-facing lines; a grep found 15
  + 1 staff-facing; sweeping turned up **two more** (`gateGotUser`, both languages) that no inventory
  had listed. **The regression assert is the guarantee, not the list** — `firstresponse_test.js` and
  `gate_test.js` now assert that *no message sent anywhere in the suite* contains an em dash, and
  separately that `MT-09`, `017-8869542`, `trade-in` and `9 pagi–6 petang` all still survive (so a
  future "fix" cannot pass by deleting characters).
- **`notifyText()` extracted to `notify.js`** (+ `notify_test.js`, 19 tests) — the architectural rule:
  it was about to carry tested behaviour, and `index.js` boots a server on require. Three changes:
  header `New Lead — Honda` → `New Lead: Honda`; the `⚠️ …hidden by WhatsApp —` line takes a full
  stop; and **the `👤 —` line is now OMITTED when there is no name** rather than printing a
  placeholder that reads as a failed field. `·` separators stay (a middot is not a dash).
- Same treatment for the same card family: `slaSweep`'s DM header, and `sla.js`'s reassign DM
  (header + the `👤 —` placeholder) and T+60 nudge list. **NOT swept** (Benjamin's call, internal
  group-facing, deserves its own approval): `buildDigest`, `renderCard`, bulk/group messages,
  `alertReview` strings.
- 🟠 **Known gap, deliberately left**: a multi-lead card entry with **no phone** still shows no
  contact route at all (the single-lead card gained that line in 2026-08-02; the multi one never
  did). One line to fix, but outside this batch's approved scope. Flagged, not fixed.

**Render env to set at deploy** (env changes need a MANUAL redeploy — Rule 102):
`FR_DEFER_FILE=/data/fr_deferred.json` · `BULK_QUEUE_FILE=/data/bulk_queue.json` ·
`SLA_DIGEST_FILE=/data/sla_digest.json` · `SLA_STORE=/data/sla_store.json`.
Optional: `REHYDRATE_DEFER_H` (defaults to 96 in code).
**Rollback:** unset the four envs + redeploy → the code falls back to `__dirname`, old behaviour.
Copy/notify changes revert with one commit; no env, no data migration.

Tests: firstresponse **154** (+28) · gate **64** (+4) · notify **19** (new) · full suite **474** (was 423).

## 🚨 THE BOT NO LONGER QUOTES A PRICE — 2026-08-10 (Benjamin approved)

Benjamin sent three real screenshots. **All three replies were wrong**, and TM staff had already
spent that morning correcting them by hand.

| Customer asked | Bot said | Truth | How we know |
|---|---|---|---|
| "Yamaha **R1** ada ke cik" | three **R15**s, RM 4,880–14,598 | TM has never stocked an R1 | Adib typed *"R1 tak ada stock tuan"* 4 min later |
| "forza 250 **baru** ada?" | "dari **RM 20,800**" | that is a 2022 **used** unit, 42,000 km. Real answer **OTR RM 28,800** | staff 12:41: *"maaf ya tuan, harga ni salah ya"* |
| "mt09" | "dari **RM 22,800**" | one 2015 bike with **79,000 km**, not "the price of an MT-09" | staff 12:24: *"maaf ya tuan harga ni tersilap"* |

**Root cause — one sentence: the bot was handed a used-unit inventory list and asked to behave like
a price list.** Every Woo row is ONE physical secondhand bike (year, plate, mileage, its own loan
table). The customers were asking about a MODEL. Three consequences, all now closed:

1. **Identity** — the matcher was `alnum(name).includes(token)`, so `r1` ⊂ `r15`. → `catalog.js`.
2. **Condition** — no working new/used field. 87 rows are titled "NEW …", 109 carry mileage, and
   **113 carry no mileage at all**; the `motor_status` taxonomy is **completely empty (0 terms —
   checked live)**. The team's title convention `^NEW ` is the only reliable signal → `RE_NEW_UNIT`.
3. **Price meaning** — one number lifted out of its row. → **no price is emitted at all, ever.**

⚠️ **The deeper lesson: this code was carefully hardened against a wrong "no" and never against a
wrong "yes."** The 2026-07-24 comment says it outright — *"a wrong 'no stock' loses the sale"* — so
a live re-check was added before any negative. But a wrong "no" costs one lead; a wrong
*"✅ Ada, dari RM 20,800"* brings a customer to Kapar expecting a price that does not exist. **Guard
the positive claim at least as hard as the negative one.**

### What changed
- 🚨 **`wooCheckStock` returns NO price field.** Do not re-add one, here or in `stockLineFor`.
- **New `catalog.js`** (+ `catalog_test.js`, **27 tests**) holds the matcher as pure functions —
  index.js boots a server on require, so it cannot host tested logic (same reason as `identity.js`
  / `roster.js` / `hours.js`). **Read the R1/R15 rule at the top of that file before touching it.**
  A token must land on a CLEAN EDGE: equal to a name token, or a prefix that does not cut a number
  in half. `r1` vs `r15` → next char `5` → refused. `cbr250` vs `cbr250rr` → next char `r` → allowed.
- **Brands never glue to a following number.** `"CB 150"` → `cb150` (one model split by a space);
  `"KTM 250"` stays `[ktm, 250]` (brand + displacement). Backwards either way breaks real matches.
- **Reply lines** (`stockLineFor`): used single → `✅ Ada — 2015 Yamaha MT-09 V1 (79,000 km).
  Salesman kami akan confirm harga & plan bulanan` · used multi → the units listed with mileage,
  no prices, still `Yang mana satu` · **wants NEW → no stock claim at all**, one qualifier
  (`Bos nak cash atau loan?`) then assign, per Benjamin: *"no need answer so many question"*.
- **`RE_WANTS_NEW`** ⚠️ Malay `baru` is also the adverb "just/recently" — `"baru nak tanya"`,
  `"saya baru beli"`. As an adjective it FOLLOWS its noun (`forza 250 baru`), so the lookahead drops
  the adverbial forms. A false positive is cheap; a false miss re-creates the RM 20,800 quote.
- **An all-NEW match now qualifies instead of listing** (behaviour change: "aveta 250" used to list
  3 models with prices). Naming an unmaintained NEW row IS a stock claim — that half of the catalog
  is hand-typed, one row is priced **RM 888,888.8888** and another has no price at all.
- **Every named unit is now live re-verified** (was: only the single-distinct case). A verify
  FAILURE trusts the ≤10-min cache; only a confirmed `outofstock` drops the unit.
- ⚠️ **Mileage is NOT fetched in the bulk catalog refresh.** Measured 2026-08-10: adding `meta_data`
  takes a page from **12KB → 562KB**, and this site has been seen taking **12.6s** for a trivial GET
  — that payload against the 15s page timeout would risk the whole refresh. Mileage rides along on
  the per-product live check of the ≤4 units we actually name. **Do not add `meta_data` to
  `catalogRefresh`.**
- **`FR 📚 stock "<query>" → [tokens] → <units|no match>`** logs one auditable line per decision.

### How we will know it worked
The durable failure signal is **a staff correction message in the customer's own chat** — today's
baseline is **3** (two "maaf, harga ni salah" + Adib's "R1 tak ada stock"). Render rotates logs in
hours, so the `FR 📚` line is for the live watch, not for history.

### Still open — NOT fixed by this change
- 🔴 **New-bike prices have no source of truth anywhere.** The Mudah-group pipeline
  (`tm-woo-upload`) requires **model + price + plate**, and a new bike has no plate — so it is
  *structurally* excluded from the one pipeline that works. The 87 "NEW …" rows are hand-typed,
  scattered across 9 months. Ask Steven: *can the team post new arrivals in the Mudah group the
  same way, just without a plate?* Everything downstream already exists.
- 🔴 **No reliable "sold" signal.** Staff DO announce it (7 bare `"sold"` / `"sold cash"` messages
  in the capture window) but **none are quoted replies** — `stanzaId` is null on every one, and Adib
  fired four in one minute, so nothing links them to a bike. Worse, `tm-woo-upload` `batch.js:192`
  prompt rule 6 says *Ignore chatter ("thanks", "Sold by ...")* and `server.js:609` filters it out
  of the orphan pool — **the signal arrives daily and is deliberately binned.** Cheap fix: ask staff
  to *reply* to the listing with `sold`; the `stanzaId` → `mid` → plate → SKU chain already exists.
- ⚪ Current availability truth = *published, not trashed, not `outofstock`* (207 instock / 15 out,
  192 trashed). Human-maintained, lags hours-to-days. Good enough to avoid quoting a sold bike;
  **not** good enough to promise "ready".

Tests: catalog **27** · firstresponse **126** (+13, all three real customers as fixtures) ·
full suite **423**.

## 📋 PASTED lead lists now chunk like a spreadsheet — 🟢 LIVE 2026-08-04 12:12 MYT (`2541a89`)
Deploy verified: Render status `live`, boot clean (`catalog refresh: 262 products`, `availability
baseline (20 staff)`, SLA engine ON), the 5 in-flight SLA timers and 1 phone-gate hold survived the
restart. ⏳ Still unproven: the first REAL paste through the webhook — Harith runs it.
Harith has 53 event leads (Lambretta/Thunder) and asked whether staff can **paste** them into the
intake group instead of attaching a file. They can — and until this fix that lost **every one of
them, silently.**

**Measured against the live extractor with his actual list, not predicted:**

| | Result |
|---|---|
| **Old path** (paste today) | `finish_reason=length` · JSON truncated mid-object · `parseLeads` → `[]` · **0 of 53** |
| What Harith would have seen | **Nothing.** `index.js` only posts "no lead found" for images/files — a TEXT drop with zero leads `return`s silently |
| **New path** (chunked) | 3 calls of 20/20/13 → **53 of 53**, 0 missing, 0 duplicates |

**Root cause — the same trap as the 139-row Excel on 21 July, entered from the other side.** The
`document` branch has chunked since that incident; the `text` branch never did. A paste was one
`aiExtract` call at `max_tokens: 1500`, and 53 leads need ~2,700 tokens of JSON. **Staff paste —
that is how they work — so the paste path now gets the protection the file path has.**

- **`textchunk.js`** (+`textchunk_test.js`, 58 tests, his real 53-lead list as a permanent fixture)
  splits a paste into chunks of ≤`TEXT_CHUNK_LEADS` (default 20) phone-bearing records, repeating
  the human's header line into every chunk exactly like `excelToChunks` repeats the CSV header.
  A lead line = a run with **≥9 digits**, so `X250` / `LS250-S` / `RM 23,888` / `2026-08-04` are
  never mistaken for phone numbers. Handles both list shapes staff use (`Name - phone - model` per
  line, and name-on-one-line-phone-on-the-next).
- **At or below 20 leads the original single-call path is untouched** — the everyday 1–5 lead drop
  behaves byte-for-byte as before.
- 🚨 **`dedupeByPhone` — chunked extraction returned 57 leads for 53 customers.** A line naming two
  bikes ("48. Muhammad Amzar - +601151689420 - Lambretta X250, Thunder LS250-S") makes the model
  emit **one lead per model**, and each copy would be round-robinned to a **different rep** — two
  salespeople ringing the same customer about the same enquiry. Now merged into `interest`.
  Applies to every source (a multi-model row does this in a spreadsheet too). **Within ONE drop
  only** — re-sending the same file still creates fresh rows (the known 2026-07-21 gap, unchanged).
  **Leads with no phone are never merged into each other** — blank is not an identity, and `@lid`
  customers legitimately have none (2026-08-02).
- **Completeness check (the "make failures loud" lesson):** if fewer leads come back than there were
  phone lines, the group is told **both numbers** and the review group is alerted. A paste that
  clearly held leads but read as zero now says so instead of returning silently. Plain group chatter
  (no phone lines) still stays silent, as designed.
- Env: `TEXT_CHUNK_LEADS` (default 20). Tests: textchunk 58 · full suite **368/368**.

**⚠️ Operational note for a text paste:** a pasted message has **no caption**, so `fileOverrides`
never runs and `origin` came back blank for all 53. The header line IS repeated into every chunk —
so putting the origin in the first line (e.g. `ON SITE EVENT — LAMBRETTA / THUNDER LEADS`) is what
makes it land on every lead. Brand blank is harmless: `brandFromModel` fills it from the model text.
✅ Verified NOT a problem: the AI preserved `+33`, `+65` and the `+850` typo **exactly** — the
"normalize to Malaysian +60" rule did not corrupt them, so foreign numbers need no pre-cleaning.

## 🐛🐛🐛→✅ FIXED 2026-07-30 — three bugs behind one wrong client report + one ignored customer
Harith disputed the 6PM SLA card of 07-29 ("yesterday only passed 1 lead, not 3, and ikhwan acknowledged"). He was right on every count. Benjamin also flagged a real screenshot: customer **+60129717912** asked "looking to purchase a 368g, whats your best deal?" at **10:05am 07-30** and got **no reply at all**. Three independent root causes, all confirmed from live Render logs + Lark. New file `identity.js` (+ `identity_test.js`, 24 tests) holds the identity logic, because index.js boots a server on require and was therefore untestable.

**① Customer pushnames were fuzzy-matched to the roster → customers impersonated reps.** `matchStaff()` is deliberately fuzzy (prefix + Levenshtein ≤2) so STAFF can type names loosely in captions ("nabeel"→Nabil). It was also being used on **inbound pushnames** to answer "is this sender a rep?" — but a pushname is chosen by the SENDER. Live collisions: `Joel`→**Jue** (dist 2), `amer`→**Amir** (dist 1), `fa`→**Fazwan** (prefix). Each was read as that rep acknowledging their leads: the ack branch then `return`ed, so `firstresponse` never ran → **customer got zero reply**, no Lark row, no follow-up; and the rep was credited with a response they never made. **3 of 16 acks in 28h were really customers** (~19%). Two of those customers re-messaged and were picked up; +60129717912 sent once and was lost.
**Fix:** identity now resolves **PHONE → name** (`identity.byLast9` / `nameByPhone`), never pushname→name. `matchStaff` stays fuzzy but ONLY for caption/filename overrides, which staff write. Also: `sla.onReply` returns `via:'phone'|'lid'|'name'`, and **only learns a rep's `@lid` on a PHONE match** — previously any match learned it, so a mis-matched customer had their own `@lid` permanently bound to that rep, making every later message from them an ack with no phone check ever again. Belt-and-braces at the call site: an ack/pass may only short-circuit the handler for a trusted sender, else it logs `SLA ⚠️REFUSED` and **falls through to first-response** — a mis-identified sender now costs a log line, never a customer's enquiry.
⚠️ **Short roster names are the standing risk surface** (Jue/Aso/Roy/Amir/Anis). Never reintroduce name-based sender identification.

**② `openId: ''` became a matchable identity → Fitri's trade-ins charged to Ikhwan.** `STAFF_BY_OPENID` was built unfiltered from `STAFF`, so Ikhwan (added 07-29, `openId` deliberately blank pending his real Lark id) put a literal `""` KEY in the map. Every reverse lookup reads `Salesman[0]?.id || ''` — so **any Lark row with no Salesman resolved to Ikhwan**. Trade-in rows are exactly that shape: `larkWriteLead` skips `Salesman` when `staff:null` (line ~628) but still stamps `SLA Assigned At` + `SLA Status=Pending` (~630-639). So Fitri's 3 trade-ins (14:32/14:40/14:53) were restored onto **Ikhwan's** clock by `rehydrateFromLark` after the 17:40 deploy, were instantly >75min, and got reported to the client as **his** 3 missed follow-ups. Verified in Lark: all 3 carry `SLA Original Salesman = Fitri`.
**Fix:** `identity.byOpenId` skips blank openIds. Plus `identity.rosterWarnings` logs at boot on ① any blank openId and ② any **last-9 phone collision** between two reps — the latter was checked BY HAND for Ikhwan vs Jue on 07-29, now automated so the next roster edit can't quietly reintroduce it. **Never key a map on a falsy id.**

**③ The 12PM/6PM card described "right now", not the window.** `buildDigest` built its header from `sla.stats()` — a live snapshot of the in-memory store on Render's **ephemeral** disk. A deploy at **17:40** wiped it, so the 18:00 card reported the desk as it looked 20 minutes later. Worse, `rehydrateFromLark` restores only `SLA Status=Pending` rows → **acknowledged leads are unrestorable by construction, so "0 acknowledged" after ANY deploy, permanently.** Reported *5 assigned · 0 acknowledged · 2 waiting*; ground truth from Lark was **17 assigned · 13 acknowledged · 3 no-response · 1 passed**.
**Fix:** new `slaWindowStats(since, until)` reads the window from **Lark** (the durable record) — a restart can no longer rewrite history. Buckets (`acked`/`waiting`/`missed`/`moved`/`other`) are mutually exclusive and **must sum to `assigned`**, so a client-facing card can never print numbers that don't add up (a **PASS is a response but NOT an ack** — it lands in `moved`). Verified by replaying both 07-29 windows against live Lark: 28=28 and 17=17. Also: adds `⏱️ within-60min`, an explicit note when the read hit the 100-row page cap (no silent truncation), an honest "couldn't read Lark" line instead of falling back to a snapshot, and `ℹ️ Bot restarted at HH:MM — the lists above may be incomplete` whenever boot time falls inside the window. `digestTick` is now async and claims its slot BEFORE awaiting, so a slow Lark read can't double-fire.

Tests: identity 24/24 · sla 34/34 (+6 identity cases, real incident fixtures) · fr 93/93.
**Follow-ups:** ✅ the 4 falsely-acked Lark rows were corrected + verified same day (Fazwan ×2 → No-Response; Amir → his real 10:07 reply, 66min, outside SLA; Jue → her real 10:38 reply, 43min, within SLA — the logs proved Amir and Jue DID reply, just after the customer had stolen the ack, so their real replies logged as `noop`). ✅ Ikhwan's real `openId` captured (see ROSTER above). ⚠️ STILL OPEN: **+60129717912 never got a reply** (Zontes 368G, 10:05am) — the bot won't retry a flushed message, needs a human. Benjamin chose to leave it.

## 🐛→✅ FIXED 2026-08-02 — @lid customers with NO phone: 5 real customers lost over one weekend
Benjamin asked "everything working ok?" — the weekend checks all passed, but the **undelivered-message alert added on 07-30 fired 4 times**, which is how this surfaced. It had been failing silently before that alert existed.
**WhatsApp sometimes discloses NO phone at all** for a privacy-addressed chat. Verified against the raw webhook capture: the payload carries only `key.remoteJid` + `key.senderLid`, both the same `@lid`, and nothing else. WaSender's `/api/contacts` maps 4,193 of 8,491 contacts `lid → phone` — but **none of these five**. The number is genuinely unavailable.
Pretending otherwise caused **two separate silent failures**:
| LID | Digits | What happened |
|---|---|---|
| `1924279574737`, `6713117831235` | 13 | LID digits used AS a phone → send to `<lid>@s.whatsapp.net` → **HTTP 422 "JID does not exist"** → no reply, and the Lark row carried a **fake phone** no salesperson could call |
| `235450526621777`, `255116863123463`, `81969484460213` | 14–15 | **Silently dropped** by `num.length > 13` — a guard written for junk PHONE numbers — no reply, **no lead, no log line at all** |
**Sending to the raw `@lid` DOES work** — proven from the inbox capture: two `@lid` threads (`187282183180475`, `240015724572924`) where the **customer replied immediately after our outbound**. ⚠️ The 07-28 note "WaSenderAPI silently no-ops on a @lid address" is **obsolete**. Also note two things that look like proof and are not: a send to a **fabricated** `@lid` still returns `success:true` **and** still produces a `fromMe` webhook echo. Only a customer replying afterwards proves delivery.
**Fix (`firstresponse.js` `onMessage`):** never invent a phone. `isLid` is computed first; `num` falls back to the jid digits **only for non-@lid chats**; the junk-number guards (`447*`, `length>13`) apply **only when a real phone exists**; an `@lid` with no phone is a genuine customer and proceeds with `phone=''`. `sendTarget()` then already addresses the raw `@lid` correctly, and `larkWriteLead` writes a **blank** phone instead of a fake one.
**Also (`index.js` `notifyText`):** with no phone the salesperson DM used to just omit the wa.me link, leaving an unactionable lead. It now says `⚠️ Customer's number is hidden by WhatsApp — reply to them directly in the TM Marketing (93210) inbox`.
Tests: fr **112/112** (+8 — 13-digit and 15-digit no-phone @lid, blank Lark phone, @lid *with* a phone still resolving to the phone JID so the 07-28 fix can't regress, and both junk-number guards still rejecting real phones).
⚠️ **The 5 weekend customers were never replied to** — the bot won't retry a flushed message. They need a manual reply; two of their Lark rows also carry a bogus 13-digit phone that should be blanked.

## 🟢 ROSTER-FROM-SHEET — **LIVE 2026-07-30 16:45** (`ROSTER_FROM_SHEET=1` in Render env)
The team list lives in **FOUR** places: this file's `POOLS`/`STAFF`, `tiktok-lead-engine/sync.py` `POOL_*`, `tm-daily-report/daily_report.py` `TEAM_KW`, and the Lark sheet (which until now only said who was PAUSED, not who was on the team). Drift has silently cost leads **four times** — Ikhwan invisible for weeks · Ikhwan's blank openId charging Fitri's leads to him · Ikhwan absent from `TEAM_KW` (and my first fix used "ikhwan" when Lark stores **"Ikhwa"**) · Azwin still getting TikTok leads 2 days after removal from one roster.
**The sheet is now the intended single source.** Benjamin chose the existing Lark wiki sheet over a new Bitable table (no permission change needed, team already uses it). Columns **C–F added 2026-07-30** — A/B untouched:
`A Salesman Name | B Available? | C Branch | D Phone | E Lark ID | F Notes`
**Branch fully determines pool membership** (verified identical to the hardcoded `POOLS`): `Klang→KS` · `Shah Alam→KS+ShahAlam` · `HQ→HQ` · `Honda→Honda` · **blank→no rotation** (how a leaver is parked). One human-friendly column replaces four code lists. Legend written into `H1:H9` of the sheet for whoever maintains it.
**`roster.js`** (+`roster_test.js`, 40 tests) parses it. Safety rules baked in: SHOUTED sheet names canonicalise to the code spelling (`FAZWAN`→`Fazwan`) · phones normalise (`012-817 4828`→`+60128174828`) · **Branch set but NO phone ⇒ excluded from rotation** (a lead assigned to someone uncontactable is worse than one assigned to nobody) · no Lark ID ⇒ still gets leads, warns about the CRM cell only · unknown Branch ⇒ no leads + warning · duplicate row ⇒ first wins + warning · **zero parsed rows ⇒ `ok:false`, refuse to use it** (wrong tab / accidentally cleared).
**✅ NOW LIVE.** `rosterShadowTick()` runs 25s after boot then every 5 min. With `ROSTER_FROM_SHEET=1` it swaps the roster in place when the sheet passes `rosterSanity()`, logging `🔁 ROSTER APPLIED from sheet — N people · KS:x HQ:x Honda:x ShahAlam:x`, plus `ℹ️ sheet differs from the compiled-in copy` naming exactly which code copy is now stale. On refusal: `🚨 ROSTER REFUSED — <reason> · keeping the roster currently in use` + an hourly-throttled group alert. With the flag OFF it reverts to report-only shadow mode (kill switch: unset the env var + redeploy).
**Proven live, refusal FIRST (deliberate order — a guard you haven't seen refuse is not a guard):**
1. `ROSTER_MIN_PEOPLE=100` + flag on → `🚨 ROSTER REFUSED — only 20 people parsed (expected at least 100) — looks truncated` · bot kept serving off the built-in list ✅
2. `ROSTER_MIN_PEOPLE=10` → `🔁 ROSTER APPLIED from sheet — 20 people · KS:8 HQ:6 Honda:5 ShahAlam:4` ✅
3. Changed ASO's Branch `Shah Alam`→`Klang` in the sheet → **picked up in 4 min**, `ShahAlam:3`, and it named the stale copy: `~ pool ShahAlam: sheet=[Amirul,Nazrin,Roy] code=[Amirul,Aso,Nazrin,Roy]` ✅
4. Reverted → `ShahAlam:4`; sheet columns A/B verified **byte-identical** to the pre-session backup ✅
⚠️ `ROSTER_MIN_PEOPLE` is currently `10` in Render env — leave it; it is the truncation guard.
⚠️ The compiled-in `STAFF`/`POOLS` are now a **FALLBACK**, not dead code (used if Lark is unreachable). The `ℹ️ sheet differs…` line is the signal to re-sync them — don't let them rot.
At wiring time the sheet reproduced the code roster **EXACTLY** — 20 people, all 4 pools, every phone and Lark ID, zero warnings.
**Still to migrate afterwards:** `sync.py` `POOL_*` (+ its `POOL_LAMBRETTA` TikTok-ads override) and `daily_report.py` `TEAM_KW`, so all four read the one sheet.

## 🐛→✅ FIXED 2026-07-30 — availability tab was read BY POSITION, not by name
`getUnavailable()` and `readAvail()` both took `meta.data.sheets[0]` — the FIRST tab in the UI. The spreadsheet behind `AVAIL_SHEET` is the Lark wiki doc **"AI REFERENCE SHEET"** (`YjLTslshkhRGeXt9V5DlJi8cgdl`, wiki node `QI0BwlzF2iffE7kYWdvlOTRVgHf`) and it has **two** human-edited tabs: `11b1e9` "Salesman Availability" (index 0) and `28oJvT` "mudah group info" (index 1).
**The risk:** anyone dragging the tabs, or adding a tab at the front, would make the bot read the wrong tab → zero YES/NO names parsed → `_unavail` empty → **unavailable reps silently start receiving leads again**. And no alert would fire, because `pollAvailability()` deliberately treats an empty read as "skip, don't reset the baseline". Classic silent failure that looks healthy.
**Fix:** `availSheetId(tok)` resolves the tab by TITLE (`AVAIL_TAB_TITLE`, default `Salesman Availability`), caches the id (tab ids survive renames), and if the title is missing it logs `⚠️ AVAILABILITY: tab … NOT FOUND` listing the real tabs before falling back to index 0. Same helper used by both readers.
**Also confirmed:** the app CAN write to this sheet (probed an empty corner cell `11b1e9!T200` and blanked it again) — so extending this sheet is viable without any Lark permission change, unlike creating a Bitable table (`1254302 RolePermNotAllow`).

## 🐛→✅ FIXED 2026-07-30 — a transient HTTP 520 silently dropped a real customer's reply
Benjamin flagged a live chat: +60192822043 sent "Slmt ptg" (15:06, bot greeted correctly), then **"Boleh sy nk tau zontes 368D" (15:07) and got NOTHING**. The bot was fine — it classified the message, wrote the lead, assigned **Nazrin** and DM'd him (he acked at 15:08). The failure was one line later:
```
07:07:24Z  SLA register: Nazrin ← 1 lead(s)          ← salesperson DM sent OK
07:07:24Z  FR ✅ PRODUCT lead assigned → Nazrin
07:08:12Z  waSend HTTP 520 <!DOCTYPE html>           ← the CUSTOMER's reply, dropped
```
**Root cause:** `waSend`'s retry loop retried **only on 429**. Every other outcome hit `if (!r.ok) { log(...); return null; }` — one transient Cloudflare 520 on WaSenderAPI's side and the message was gone, with no retry and **no alert**: the sole record was a log line nobody reads. Frequency measured before fixing: 1 occurrence in 28h of logs — rare, but permanently silent.
**Second, worse problem found while fixing it:** `fetch` had **no timeout**. All sends share ONE serialized chain (`_sendChain`, 5.2s spacing), so a single hung request stalls *every queued outbound* — which presents exactly as "the bot stopped responding".
**Fix — new `wasend.js`** (+`wasend_test.js`, 25 tests) holding the retry policy, `index.js` keeps the chain:
- **Retries** 429 (honouring `retry_after`, unchanged) **plus** 408/425/5xx/520-527 and network errors — 3 attempts, 3s then 8s backoff.
- **Does NOT retry** ordinary 4xx (400/401/403/404/422): a malformed payload or bad token never fixes itself and retrying just delays the whole chain.
- **Per-attempt `AbortController` timeout** (`SEND_TIMEOUT_MS`, default 20s) so one hung request can never stall the chain.
- **`alertSendFailure()`** → on final failure, a `🚨 Message NOT delivered` post to the review group naming the number + the text + "the bot will NOT retry this one". Throttled to 1/5min with a suppressed count, so a WaSender outage can't spam. ⚠️ `alertReview` uses `REVIEW_TOKEN` and its own `fetch` — it does NOT route back through `waSend`, so a failing send cannot recurse.
- Contract unchanged: returns `msgId` on success, `null` on failure (SLA still deletes by msgId on reassign). Envs: `SEND_ATTEMPTS`, `SEND_TIMEOUT_MS`.
- Tests cover the exact incident (520→200 recovers · 520 always → gives up with the status kept for the alert), 502/503/524, network errors, persistent 429, all five permanent 4xx, hang→abort→retry, and payload shape.
⚠️ **The customer never got their reply** — the bot won't retry a flushed message. Nazrin holds the lead and acked it, so follow-up is his.
⚠️ **Cross-client:** the retry-only-on-429 pattern (and the missing timeout) exists in the KoonKen, Metal Age, U Fresh, FSS and SFF bots. Same fix applies — sweep them after TM is proven clean.

## 🕘 HOURS 2026-07-30 — TWO windows, deliberately different. Do NOT merge them.
Harith: *"can help change operation hour to isnin–sabtu, 9 pagi–6 petang?"* — flagged off a real customer chat (+60122607096, 6:44pm) where the bot quoted **"Isnin–Jumaat, 9 pagi–5 petang"**. Root cause: **two sources of truth for one fact.** The sentence was HARDCODED in `firstresponse.js` `tpl()` while the window it described lived in `FR_DIST_DAYS/START/END`. They drifted and the bot spent 8 days quoting hours TM doesn't keep.
Benjamin then corrected the obvious-looking fix: *"they are working on Saturday but we don't assign lead on Sat."* So there are genuinely **two facts**, and collapsing them into one window would be wrong:

| | Config | Value | Governs |
|---|---|---|---|
| **OPERATING hours** | `FR_HOURS_DAYS/START/END` | **Mon–Sat 9am–6pm** | ONLY what customers are TOLD (`hoursLabel`) |
| **DISTRIBUTION window** | `FR_DIST_DAYS/START/END` | **Mon–Fri 9am–5pm** | when the bot auto-assigns + DMs a salesperson |

**Three reply states** (`tpl()`'s 5th arg is now `closed`, was `offHours`):
1. **In distribution** → salesman card, as before.
2. **Open but not distributing** (Saturday, or 5–6pm weekday) → no card, and **NO "bila pejabat dibuka semula" line** — the shop IS open and a human watches the inbox, so telling the customer we're shut is the same wrongness Harith flagged. They get the normal "sales advisor akan menghubungi anda" and the lead still drains to a rep Monday 9am as a backstop. Benjamin picked this wording explicitly.
3. **Genuinely closed** (outside operating hours) → the operating-hours + reopen line.
- **`hours.js`** (+`hours_test.js`, 16 tests) GENERATES the sentence from the OPERATING config in EN + BM, handling non-contiguous days, `tengah hari` vs `petang`, and noon/midnight edges. Injected as the `hoursLabel` dep. `firstresponse_test.js` covers all three states incl. the Saturday case (104/104).
- Boot logs BOTH windows so the split is visible: `🕘 Operating hours (told to customers): …` + `🕘 Lead auto-assignment window: … — deliberately narrower`.
- ⚠️ **Never hardcode a customer-facing fact that also exists as config** — change the config, the sentence follows. And ⚠️ **never "tidy" these two windows into one**: a future reader will see Mon–Sat 9–6 next to Mon–Fri 9–5 and assume drift. It isn't. TM works Saturdays but does not auto-assign then.
- 🔜 If Harith later wants weekday assignment to run to 6pm too, that's `FR_DIST_END=18` (Benjamin chose to keep 5pm, 2026-07-30).

## 🔁 TRADE-INS now carry Fitri's Lark Salesman (2026-07-30, Benjamin approved)
`firstresponse.assign()` used to write trade-in rows with `staff: null` → Lark `Salesman` cell EMPTY. That emptiness is precisely what let the blank-openId bug attribute her 3 leads to Ikhwan and report them to the client as his misses. `FITRI` now carries `openId: ou_9dbd12586dfb70716c3ee77aefe010ed` (confirmed live, 122 existing rows).
**Safe because:** `slaSweep` only picks rows with NO `SLA Assigned At` (trade-ins always have one) → no DM to Fitri; `rehydrateFromLark` maps openId→`STAFF`, where she is deliberately ABSENT → skipped, so she never gets SLA timers. She is the purchaser, not a rep on the round-robin.
**Also fixed the reporting side:** trade-ins get `SLA Status=Pending` at write time but can never be acknowledged (no rep, no timer), so they used to sit in the digest's `waiting` bucket **forever**, silently inflating the sales team's outstanding count. `slaWindowStats` now counts them separately and prints `🔁 N trade-in(s) → Fitri (purchaser, no SLA clock)` — excluded from the rep scoreboard, never hidden.

## 👤 ROSTER — IKHWAN's real Lark openId, read 2026-07-30
`ou_5dff90be7f04fd6222d29c2f6f502ae0`, read off row `recvqPiX6HbIx8` ("test lead", 601121246061, Tiktok Get Leads) which **Ikhwan assigned to himself** — the never-name-harvest rule, and it matters: a full scan of all 6,944 rows found **8 Salesman openIds not in the code roster**, including a STALE Zeera account (`ou_7cde75e1…`, "Hazirah Zulaika", 248 rows) and a second Syaza (`ou_93719870…`, "Syaza Hanaa"). Searching by name would have picked a wrong one. His `SLA Original Salesman`/Lark `Salesman` cell now fills in normally.
Also confirmed in that scan: **Fitri HAS a real Lark account** (`ou_9dbd1258…`, 122 rows). ✅ **DONE same day** (Benjamin approved, `1fd78d0`) — trade-ins now carry her `Salesman`; see the TRADE-INS section above.

## 👤 ROSTER 2026-07-29 — IKHWAN added to the HQ pool (was in Lark but invisible to the bot)
`IKHWAN +60129593259` → `STAFF` + `POOLS.HQ` (now 6: Adib, Syahrin, Fazwan, Azrul, Amir, Ikhwan).
- **He was already row 21 of the Lark "Salesman Availability" tab, marked YES** — but the sheet only ever tells the bot who to SKIP (`getUnavailable` collects `NO` rows). Rotation membership comes from `POOLS` in code, so a name present in Lark and absent from `POOLS` receives **zero leads, silently, forever**. That was Ikhwan since whenever the team added him. ⚠️ **Lesson: adding a salesperson to the Lark sheet does NOT enrol them — the code roster is the source of truth for rotation.** Worth a periodic diff of sheet names vs `POOLS` (Azwin is still row 8 of the sheet though removed from `POOLS.KS` on 07-21 as resigned — harmless direction, but the same drift).
- `openId` deliberately left `''` until he assigns ONE Lark row and we read the id back off that exact row (never name-harvest — duplicate/stale accounts have burned us twice). Both write paths guard on empty (`larkWriteLead` line ~627, `larkUpdateSalesman` line ~648), so his WhatsApp DM + SLA timers work now and only the Lark `Salesman` cell stays blank.
- Adding him to `STAFF` also auto-protects his number from being treated as a customer (`staffLast9` derives from `STAFF`). Verified no last-9 phone collision — Jue `129653259` vs Ikhwan `129593259`. Tests 93/93 + 27/27.

## 🐛→✅ FIXED 2026-07-28 (`b5ccf02`) — @lid click-to-chat customers got zero reply
Benjamin flagged a real chat screenshot: +60186528335 sent "Hi, nak tanya pasal moto" at 9:23am on the
93210 number and got no bot reply at all — nothing in Render logs looked wrong. Traced via the VPS console
capture (`tm-motoworld-lead-intake` channel forwards every webhook, not just intake-group ones): the
message's `remoteJid` was `143499823448076@lid` (`entryPointConversionSource: click_to_chat_link` in the
raw payload) — WhatsApp's newer privacy addressing for customers who arrive via a wa.me/click-to-chat
link, instead of the normal `<phone>@s.whatsapp.net`. `firstresponse.js` was passing that raw `@lid` jid
straight into `D.waSend(jid, ...)` as the reply target — WaSenderAPI's `/send-message` silently no-ops on
a `@lid` address (no error, no 4xx). The bot classified the message correctly and wrote the lead to Lark;
it just never actually messaged the customer back.
**Fix:** new `sendTarget(jid, phone)` helper in `firstresponse.js` — resolves the SEND target to
`<phone>@s.whatsapp.net` whenever `jid` is `@lid` and a real phone was extracted (`cleanedSenderPn`/
`senderPn`, already captured at the `index.js` webhook layer). State (`buffers`/`state.pending`/
`state.greeted`/`humanTouched`) still keys off the raw `jid` unchanged — `markHuman()` sees the same
`@lid` for a human's outbound reply in that same chat, so human-takeover detection stays consistent.
Tests 93/93 (+3 new, using this exact real message as a fixture). Deployed live same day.
General pattern (not TM-specific) now documented in `skills/wasenderapi_integration.md`.
⚠️ The 9:23am customer never got a reply before the fix shipped — needs a manual follow-up, the bot won't retry an already-flushed message.

## 🟢 FR STOCK v2 — 2026-07-24 (`341c412`): search miss ≠ "takde stok" + booking-listing pitch
Steven/Benjamin reported 4 real same-morning misfires. Root causes + fixes:
1. **ER6N + MT-07 told "takde stok" while available.** `extractProductQuery`'s neighbor-word grab put "ada" into the query/name-filter tokens → real in-stock ER6N filtered to zero; MT-07 additionally is marked `outofstock` in Woo itself (data issue — both 2019 MT-07 listings; team to correct). Fix (asymmetric claims): zero-match / outofstock now sends a NEUTRAL "salesman kami akan confirm stock" line — the bot only makes the positive "✅ Ada — dari RM X" claim on a live instock name-match. A search miss or stale Woo flag can never again become a confident negative to a customer.
2. **Zontes 175X quoted "we have stock — from RM 8,888.889"** off the placeholder price of the listing titled "OPEN FOR BOOKING NEW ZONTES 175X". Fix: `wooCheckStock` splits name-matches into `{matches, booking}` (booking = /open for booking|booking|pre-?order|coming soon/ in the title); `stockLineFor` answers booking-only matches with the booking pitch (BM/EN), never stock/price. Zontes bookings carry Steven's lines: Zontes dealer, book early = faster stock + mystery gift, "Beli Zontes, beli dengan TM Motoworld 😁".
3. **"mau tolak moto" (sell) misrouted to LOAN template** — keyword-list gap → fixed by (A) below.
Tests 83/83 (real 2026-07-24 messages added as fixtures).

## 🟢 FR v5 — 2026-07-24 PM (Benjamin approved A + B same day): LLM intent + local catalog cache
**(A) gpt-4o intent classification** (`aiClassify` in index.js, `classifySmart` in firstresponse.js): the LLM decides Product/Loan/Sell/Testride/Greeting/Skip; regex `classify()` is the instant fallback on API error/timeout/garbage output, and still fully owns image-only messages + vendor auto-replies. An image WITH caption keeps the regex verdict if the LLM says greeting/skip (image carries intent the LLM can't see). Live-validated 10/10 on real messages incl. every historical misroute ("tolak moto + loan"→sell, "outlet ada jual keeway"→product, "let go"→sell). Cost ~RM 7/mo at ~30 DMs/day (600 in / 5 out tokens per call, temp 0). **Kill switch: `FR_AI_CLASSIFY=0`** (env only, no code revert).
**(B) Local catalog cache** (`CATALOG` + `catalogRefresh` in index.js): full ~300-product Woo catalog fetched every 10 min (`CATALOG_REFRESH_MS`, default 600000; `_fields` keeps pages light); `wooCheckStock` now matches model tokens (RE_BIKE words + digit tokens ONLY — filler like "ada" never reaches the matcher, the exact poison that zeroed ER6N) against cached names, alphanumeric-normalized (er6n = ER-6N). WP's near-literal live search is gone from the customer path. **Positive "✅ Ada" claims are live re-verified per product** (`wooVerifyLive`, 3s timeout, single-distinct-model case only) so a bike sold minutes ago is never claimed in stock — verify failure trusts the ≤10-min cache. Cache empty at boot (~first seconds) → neutral line, safe. Validated live on 8 regression cases (ER6N ×3 units, Aveta 250 w/o Marvel 150, 368D, moda moca, RSV4, GPX 250, MT-07 sold-out → neutral, 175X → booking). Tests 88/88.
**Monitoring window (few days, per Benjamin):** watch Render logs for `FR 🧠 ai overrides regex` lines (each one = a lead the old regex would have misrouted) + `catalog refresh: N products` every 10 min + any `aiClassify err` spam (if OpenAI flakes, replies silently fall back to regex — no customer impact).

## 🟢 REHYDRATE-FROM-LARK on boot — 2026-07-24 evening (closes the ephemeral-disk TODO)
`rehydrateFromLark()` in index.js, runs once ~20s after boot (kill switch `REHYDRATE=0`). Rebuilds from Lark (the durable record) what a Render deploy used to wipe:
1. **Pending SLA timers** (rows `SLA Status=Pending`, assigned <4h) — re-registered with the ORIGINAL `SLA Assigned At` so the 60/75-min clocks RESUME, not restart (`sla.register` now accepts `assignedAt`/`firstAssignedAt` overrides). No DM re-send. `override=true` on all rehydrated leads — post-restart we can't tell round-robin from deliberate, and wrongly auto-moving a deliberate lead is the worse failure (nudge/escalate still fire). Known gap: boot OUTSIDE working hours skips restore (register's off-hours gate) — acceptable, timers wouldn't run then anyway.
2. **FR greeted map** (WhatsApp Direct leads, last 7d, by phone) — kills the re-greet-after-deploy artifact (seen live 2026-07-24 12:24). `firstresponse.rehydrateGreeted()` — existing live state always wins.
3. **Deferred off-hours FR leads** (Origin=WhatsApp Direct + Salesman empty + <36h + no SLA stamp) — re-queued into `fr_deferred.json` for the 9am drain, deduped by recordId so plain restarts add nothing. Trade-ins excluded (Fitri DM not safely reconstructable — accepted loss, rare).
Tests: sla 27/27 (resumed-timer semantics) + fr 90/90 (no duplicate greeting). **Deploys are now ~stateless-safe; the "batch doc+code into one push" rule matters much less.**
4. **Bulk drip-feed queue** (same evening, closes the last ephemeral file): bulk leads beyond the first batch are now stamped **`SLA Status='Queued'`** in Lark at write time ('Queued' option auto-created via API, verified on a junk row first); `drainBulkQueue` flips each to `Pending` + fresh `SLA Assigned At` at REAL DM time (rep-fair clock — the Lark timestamp used to say write-time). Rehydrator part 4 rebuilds `bulk_queue.json` from Queued rows (<7d, one job, batches of BULK_BATCH_SIZE, `chatId=INTAKE_GROUP_JID`, dedup by recordId) so the throttled trickle resumes after any deploy. Queued rows are invisible to the sweep (Assigned At set) AND to timer-rehydrate (filters Status=Pending) — so no rep ever gets nudged for a lead whose DM never went out (that was a real latent bug in part 1 until this).
⚠️ Legacy edge: bulk leads queued BEFORE this deploy carry Status=Pending (old stamp) — one-time; queue was empty at deploy time.

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

## 🟢 FR BOT v4 — 2026-07-22 PM: shop-sells classification, ambiguous-model clarify, Mon–Fri 9–5 lead distribution
Three fixes from the team's second feedback round (all real incidents, all verified against live data):
1. **"ada jual motor X" misrouted to trade-in (Keeway XDV180):** `RE_SELL`'s bare `jual motor` pattern matched "outlet... ADA jual motor keeway" — a "do YOU sell this?" BUY question. Fix: `RE_SHOP_SELLS` strips shop-sells phrasing (`ada/kedai/outlet/shop + jual`) from the text BEFORE the sell test — stripping (not vetoing) keeps mixed messages right ("ada jual tak? sy nak jual motor lama" still = sell).
2. **Wrong price from the wrong bike (Aveta 250 → quoted RM 7,988 = the Marvel 150):** WooCommerce search matches descriptions too, and `stockLineFor` quoted `Math.min` across ALL loose matches. Fix (two layers): `wooCheckStock` now requires every query token to appear in the product NAME (alphanumeric-normalized), and `stockLineFor` only quotes a price when EXACTLY ONE distinct model matches — several matches → lists up to 4 options with their own prices + "Yang mana satu bos berminat ya?" (Harith's ask-to-clarify suggestion). per_page 5→10 so the filter can't starve the list. Verified live: "Aveta 250" → 4 real 250s listed, Marvel 150 excluded; gpx 250 / zontes 368D / rsv4 / moda moca all single-match with correct prices.
3. **24/7 replies, Mon–Fri 9am–5pm lead distribution (team request):** outside `FR_DIST_DAYS/START/END` (default 1-5, 9, 17 MYT) the customer still gets the instant reply + stock answer, but it ends with the office-hours line (no salesman card), and the lead is written to Lark **UNASSIGNED** (blank Salesman = `slaSweep` can't early-enrol it). The staff-facing half queues in `fr_deferred.json`; a 60s drain releases it when the window opens: round-robin AT DRAIN TIME (fair 9am spread), `larkUpdateSalesman` + SLA columns stamped (prevents sweep double-DM), salesperson DM + `sla.register`. Trade-ins defer Fitri's DM the same way. ⚠️ `fr_deferred.json` is on Render's ephemeral disk — a deploy between night and morning drops queued DMs (leads themselves are safe in Lark, visible as unassigned rows). Tests: 74/74.
⚠️ NOTE the deliberate split: SLA engine days stay Mon–SAT (staff-dropped group leads), FR auto-distribution is Mon–FRI per the team's explicit request. Two different windows, two different envs.

## 🐛→✅ FIXED 2026-07-22 — RE_BIKE only had specific MODEL codes, missing entire BRANDS (KTM had zero coverage)
Audit of real conversations found a detailed, serious English purchase inquiry — "interested in purchasing the KTM 390 Adv R... quickshifter... OTR price and waiting time?" — got ZERO reply. Root cause: `RE_BIKE` (`firstresponse.js`) was built entirely from specific model codes (cbr, rsv4, duke, tracer...) and never had the BRAND words themselves. Pulled the real 32-brand `product_brand` taxonomy live from tmmotoworld.com's WooCommerce (`GET /wc/v3/products/brands`) and added every brand with stock as a bare keyword — biggest gaps were **Yamaha (90 products), Suzuki (38), Honda (39), Kawasaki (30), KTM (8), Modenas (16), BMW (8)**, all previously unmatchable unless the customer happened to name one of the few specific model codes already covered. Added: ktm, yamaha, suzuki, honda, kawasaki, bmw, modenas, ducati, aprilia, triumph, benelli, cfmoto, harley, agusta (MV Agusta), enfield (Royal Enfield), qj (QJ Moto), morini (Moto Morini), afaz, ktns. Verified live against WooCommerce for KTM + 6 other brands, zero regressions (60/60 tests).
⚠️ **Still open, NOT fixed:** a real customer asked about "srk 250" — not a real brand/model in TM's 32-brand catalog, likely a typo/mishearing of something else. Didn't guess-map it since a wrong mapping is worse than no mapping. Needs Benjamin/staff to confirm what model this actually refers to before adding a keyword for it.

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

## 📞 Phone gate — hold the assignment until we have a number (built 2026-08-04)

**Plain English:** 14% of TM's chats now arrive with **no phone at all** — the highest of any
client, and climbing (10% on 2 Aug → 14% on 4 Aug). Those leads were still assigned, handing a
salesperson someone they cannot ring. Now the bot answers the customer's question as normal,
asks for a number, and **holds the assignment** until it has one — or 60 minutes, whichever
comes first. Nobody is left waiting on a privacy setting.

| Situation | Before | After |
|---|---|---|
| Lead with a phone | Assigned | Assigned — completely unchanged |
| No phone at all | Assigned; Lark row blank-phone; SA can't call | **Held** — answered + asked, `assign()` never reached |
| Customer gives a number | — | Assigned with a real phone on the Lark row |
| Customer asks why / "scam ke" | — | Names WhatsApp's username/hide-number setting, then stops asking |
| **Customer offers their username** | — | Asks them to type it (WhatsApp does **not** expose it — verified) |
| **Customer types a username** | — | **Assigned on it** — see below (2026-08-04) |
| Silent 60 min | — | Assigned anyway, exactly as before |
| Human replies during the hold | — | Hold dropped — never double-handled |

- Gate lives in `firstresponse.js` (`gateHold` / `gateOnReply` / `gateRelease` / `gateSweep`).
  Sweep shares the existing 60s `drainFRDeferred` tick — no new timer.
- **`assign()` is never called while held**, so no Lark row, no SLA clock, no salesperson DM.
  That is deliberate: `larkWriteLead` with `staff:null` still stamps SLA fields, and that is
  exactly what charged Fitri's trade-ins to Ikhwan (2026-07-30).
- **Ask at most twice**, then go quiet. `FR_GATE_MS` (default 1h), `GATE_MAX_ASKS=2`.
- Tests: `node gate_test.js` (45) + the existing `firstresponse_test.js` (113).

### 👤 A typed USERNAME now releases the hold (2026-08-04) — ⚠️ NOT DEPLOYED
The gate already *recognised* a username offer and asked the customer to type it — but only a
phone number actually released the hold, so a customer who typed their handle was still stuck.
**Benjamin's call, 4 Aug: either identifier is enough.** Ported to all four bots the same day.
- `gateAsk` now offers **phone or username** in one message and names the `@` — that prefix is
  what makes a handle safely parseable out of free text.
- `gateParseUsername(text, expectUsername)` mirrors `phone_gate.parse_username` in the Python
  bots. Rejects emails, domains, all-digit tokens, and *"U can find my username to contact me"*
  (no handle typed). A **bare** one-word reply counts only after we asked (`h.askedUsername`) —
  otherwise "zontes" would be filed as somebody's handle.
- 🚨 **The handle never becomes the phone.** `gateRelease` is called with `phone=''` and the
  handle prefixed onto `want` as `@x (username, not dialable)`, so the Lark phone cell stays
  blank. `larkWriteLead` would happily store a handle as a phone — that is exactly the fake-phone
  failure of 2026-08-02 wearing a new hat.
- 🚨 `gateGotUser` promises follow-up **in this chat**, never a call back: a handle is not
  dialable in Malaysia until WhatsApp's rollout (~Sept 2026) and never if the customer set a
  *username key*.
- ⚠️ **Awaiting Benjamin's push approval — nothing is live.**

### 🐛→✅ FIXED 2026-08-05 — the bot silenced itself, and binned every phone number it was given
**Plain English:** the bot has a rule "if a human is handling this chat, stay out of the way". But
`markHuman()` fires on ANY `fromMe` message — **including the bot's own sends echoing back** — so the
chat was flagged human-owned the *instant the bot asked for the number*. The next line of `onMessage`
then dropped the customer's reply **before it was even buffered**. `state.pending` (the greeting flow)
was exempt from that guard; **the phone gate was not.**

**Cost:** every held customer who complied was discarded and released at timeout as "never answered".
Ground truth from the inbox — **4 of 4 gave a real number within ONE minute** (`014-8369971` ·
`01160727568` · `0169559643` · `0102360706`) and two also gave a username (`@Keekzy77` · `@hkm.hkmi`).
The gate reported **0% conversion when the truth was 100%**, and that number was used to recommend
abandoning the ask entirely. Nobody was actually lost only because TM staff read the inbox by hand and
called them — humans covering for broken automation. The Lark rows still carry blank phones.

**Fix:** the guard now exempts every state where the bot is waiting on the customer:
```js
const midFlow = state.pending[info.jid] || (state.awaitingPhone || {})[info.jid];
if (humanTouched.has(info.jid) && !midFlow) return;
```
🚨 **Any future "waiting on the customer" state MUST be added here too.** Regression tests use the real
dropped replies (`014-8369971`, `@Keekzy77`) — `node gate_test.js` (52).

### 🐛→✅ FIXED 2026-08-05 — a human takeover left no trace
Dropping the hold on human takeover wrote only a `D.log` line, no gate event. `/gate-status` then showed
nothing held and no outcome, so the lead read as **stuck forever** and was flagged for a human who had
already handled it. **2 of TM's first 4 gated leads ended this way** — normal operation for TM (staff
watch that inbox), not an edge case, and it was quietly breaking the watch count. Now logged as
`human_takeover`. **Every terminal path needs an event, including the good ones.**

### 🟢 fr_state.json now lives on a persistent disk
`FR_STATE_FILE=/data/fr_state.json` on a 1GB Render disk (`dsk-d9okds4s728c73fbfjig`), attached
2026-08-04. Previously the file sat on ephemeral storage and **every deploy wiped it** — the
reason `rehydrateGreeted()` had to be built. A phone-gate hold would have been lost the same way,
leaving a customer permanently unassigned. Holds and the greeted map now survive deploys.
`rehydrateGreeted()` stays as the belt-and-braces path for a genuinely fresh disk.

### 📊 Gate observability (added 2026-08-04)
`GET /gate-status` — same JSON shape as the three Python bots, so one tool reports on all four
(`~/.claude/skills/gate-contact-report/`). Events are appended as JSONL to
`gate_events.jsonl` beside `FR_STATE_FILE` (i.e. `/data/`, the persistent disk).

**Why a file and not just `D.log()`:** Render rotates logs every few hours, so a resolved gated
lead became unreviewable almost immediately — and TM produces more of them than any other client
(14% of chats). Kinds emitted: `held` · `phone_received` · `asked_username` · `explained_why` ·
`re_asked` · `no_reply_usable` · `assigned` · `timeout` · `human_takeover` · `assigned_after_park`.

### 🔍 2026-08-06 — one dash meant three different things, so a real failure was invisible
Found while auditing Ariff (`@mat.arip`, Aveta Vanguard V2 loan). He gave his username at **17:09**
on 5 Aug and the gate released correctly — but the event logged `salesperson: ""`, so `/gate-status`
printed **`assigned to: —`**. That dash covered three situations that could not be told apart:

| Reality | Printed | Is it OK? |
|---|---|---|
| A rep holds it | `—` when the name was missing | fine |
| Released after 5pm → parked for the 9am drain (TM assigns **Mon–Fri 9–5**, narrower than opening hours) | `—` | normal, but the customer was promised a follow-up |
| **NOBODY took it** — Lark row with an empty Salesman, and `slaSweep` filters `Salesman isNotEmpty`, so nothing will ever chase it | `—` | **broken, silently** |

Ariff was the middle case: parked 16h → Fazwan at 09:00 → no response in 75 min → reassigned to
Shahrin → **escalated 11:32, still unanswered 19h after he asked.** Only a hand-check in Lark found
it; the log looked identical to a healthy lead.

**Fix — three parts, all monitoring, none of them change how a lead is assigned:**
1. **`assign()` now reports WHY there is no card.** New optional `ctx` in/out bag (NOT a return-shape
   change — `tpl()` still receives the same card-or-null, so no customer-facing text moved).
   `ctx.outcome` = `assigned` · `parked` · `no_rep`, written to the gate event as `assign_state`.
   `no_rep` also logs `FR 🚨 NO SALESPERSON took the released lead`. ⚠️ `no_rep` is *rare by design*:
   `assignLeads` falls back to the whole pool when everyone is marked unavailable, so reaching it
   means a pool is structurally empty (e.g. a branch blanked in the roster sheet).
2. **The morning drain closes the story.** Deferred entries now carry `jid` + `gated`, and
   `drainFRDeferred` calls `firstresponse.gateLogParked()` → an `assigned_after_park` event naming
   the rep and how long the customer waited. Before this, the log's last word on a parked lead was
   "parked" and the only way to learn who got them was to open Lark. Entries queued before this
   shipped (or re-queued by `rehydrateFromLark`) have no `jid` and are skipped, never mislogged.
3. **`report.py` ranks by staleness** — every lead needing attention is repeated in a
   `⚠️ NEEDS A LOOK — stalest first` block with time since last activity. A 19-hour-old stuck lead
   no longer renders exactly like one that resolved five minutes ago.

Tests: gate **60** (+8 — assigned/parked/no_rep marking, the parked entry carrying its chat, the
drain writing the ending, and the loud log line). Full suite **383**.
⚠️ `init()` REPLACES the dep bag, it does not merge — `gate_test.js` now has `BASE_DEPS` + `initWith()`
because a partial re-init leaves the module without `waSend`/`log`.
