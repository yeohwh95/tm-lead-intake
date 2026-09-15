// Intent hold — do not ROUTE a lead until we know buy vs sell. Run: node intent_hold_test.js
//
// THE BUG THIS EXISTS FOR (real chat, 13 Sep 10:40 MYT, +6013-988 8904):
//   "Hi" → "Tm motorworld" → bot assigns ASO, a sales rep, because `product` is the fallback
//   10:42 → "Boleh jual motor ke dekat TM Motorworld?"  ← a trade-in, never re-read
//   next morning → the lead lands with Amir, a sales rep. Fitri, who BUYS the bikes, never hears.
// TM sources its used stock through Fitri, so a trade-in routed to a sales rep is a bike TM does
// not buy. The same shape is still open on +6010 272 3324, sitting under Fazwan.
//
// The two things that must stay true, and are the only reasons to be careful here:
//   1. a customer who answers NOTHING must still become a lead (the hold is a delay, not a drop)
//   2. a customer who names a bike must NOT be delayed at all
const os=require('os'), path=require('path');
process.env.FIRSTRESPONSE_ON='1'; process.env.FR_INTENT_HOLD='1';
process.env.FR_DEBOUNCE_MS='200'; process.env.FR_INTENT_HOLD_MS='400';   // 10 min compressed
process.env.FR_STATE_FILE=path.join(os.tmpdir(),`to_${process.pid}.json`);
process.env.FR_EVENTS_FILE=path.join(os.tmpdir(),`to_ev_${process.pid}.jsonl`);
const fr=require('./firstresponse.js');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const sent=[], leads=[]; let pass=0,fail=0;
const ok=(c,n)=>{c?(pass++,console.log('✅',n)):(fail++,console.log('❌',n));};
fr.init({ waSend:async(to,t)=>{sent.push({to,text:t});return 'm';},
  assignLeads:(ls,ov)=>ls.map(l=>({...l,want:l.interest,brand:'HQ',origin:'WhatsApp Direct',
    assignee:(ov&&ov.noAssign)?'':'Aso',staff:(ov&&ov.noAssign)?null:{phone:'+60127674828',openId:'x'}})),
  larkWriteLead:async l=>{leads.push(l);return 'r';}, notifyStaff:async()=>'d',
  sla:{register:()=>{}}, getUnavailable:async()=>new Set(), log:()=>{}, isStaffPhone:()=>false,
  wooCheckStock:async()=>({matches:[]}), inDistHours:()=>true, inOpenHours:()=>true,
  hoursLabel:()=>require('./hours').hoursLabel([1,2,3,4,5,6],9,18),
  nextWindowLabel:()=>null, larkPatchWant:async()=>{}, larkPatchPhone:async()=>{},
  deferStaffNotify:()=>{}, aiClassify:async()=>null });
(async()=>{
  const J='silent@s.whatsapp.net';
  fr.onMessage({jid:J,phone:'60111111111',kind:'text',text:'Hi'}); await wait(500);
  fr.onMessage({jid:J,phone:'60111111111',kind:'text',text:'Tm motorworld'}); await wait(500);
  ok(leads.length===0,'held: nothing assigned while we wait for the answer');
  ok(sent.some(s=>/beli.*jual|jual.*beli/i.test(s.text)),'held: the buy-or-sell question was asked');
  await wait(500);                       // let the hold expire with NO reply
  await fr.gateSweep();
  ok(leads.length===1,'🚨 timeout: a silent customer STILL becomes a lead (never lose a lead)');
  ok(leads[0] && leads[0].assignee==='Aso','timeout: assigned to a sales rep, exactly as before');
  ok(sent.some(s=>/ASO/i.test(s.text)),'timeout: the customer is told who has them');

  // a clear BUYING lead must not be delayed at all
  const J2='buyer@s.whatsapp.net'; const n=leads.length;
  fr.onMessage({jid:J2,phone:'60122222222',kind:'text',text:'Zontes 368 ada stock tak?'});
  await wait(500);
  ok(leads.length===n+1,'🚨 a customer who names a bike is assigned IMMEDIATELY, no hold');
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
