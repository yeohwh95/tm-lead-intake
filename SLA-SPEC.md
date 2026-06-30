# Lead SLA — spec (Steven's 1-hour follow-up concern)

Track whether an assigned salesperson contacts a lead in time; nudge → reassign → escalate. Scoreboard in the daily report.

## Working hours
- **Mon–Fri, 9 AM–6 PM MYT.** Outside hours / weekends → NO timer, NO reassign (skip).
- If a lead's 75-min reassign mark falls outside working hours → skip the reassign.

## Timeline (per lead)
| Mark | Action |
|---|---|
| **T+0** | Lead assigned during hours → DM salesperson the lead + "Reply YES once contacted". Save the lead-DM `msgId`. |
| **T+60min** | No YES → ONE summary of that rep's uncontacted leads + "Reply YES, else reassign in 15 min". Save the summary `msgId`. |
| **T+75min** | No YES → 🗑️ delete the lead DM(s) + the summary from the old rep → 🔄 reassign to next in the region pool → DM new rep (+ save new msgId, restart timer) → 📝 update CRM Salesman field → 📢 group note. |
| **2nd miss** | Escalate to manager/group. NO further auto-reassign. |

## Rules
- **One YES = confirms ALL that rep's pending leads** (no per-lead codes). So either everything confirms (nothing reassigns) or nothing confirms (all reassign + summary fully obsolete → safe to delete).
- **YES detection:** rep replies YES **to the TM Marketing number (+60163352468)** → bot reads via webhook (case-insensitive, any msg containing "yes").
- Respect the **availability sheet** — skip reps marked unavailable when reassigning.
- **Delete on reassign:** both the T+0 lead DM(s) AND the T+60 summary (WaSender `DELETE /messages/{msgId}` — confirmed working).

## Scoreboard (daily 9 AM report, new section)
- Per rep: avg response time, % within SLA (contacted ≤ ~60 min), # escalations/reassigns.

## Build location
- `tm-lead-intake` bot (already: assigns via `assignLeads`/`poolForBrand`, DMs rep on TM number via WaSender, writes Lark). Add:
  - Persistent lead-status store (survive Render restarts).
  - A **1-minute checker** (not setTimeout) that evaluates T+60 / T+75 marks in working-hours time.
  - YES-reply detection on the TM number webhook.
  - Reassign + delete + Lark Salesman update + group notify.
- WaSender delete: `DELETE https://www.wasenderapi.com/api/messages/{msgId}` (Bearer + UA). Send returns `data.msgId`.
