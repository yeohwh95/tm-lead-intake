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

  // ---- OFF-HOURS (2026-09-16). The first version of this hold ran in-hours only, which is half
  // the clock and the wrong half: off-hours the row is written now and drained to a rep at 09:00,
  // so a category decided at 01:00 is still wrong eight hours later with nobody awake to catch it.
  const patched=[];
  fr.init({ waSend:async(to,t)=>{sent.push({to,text:t});return 'm';},
    assignLeads:(ls,ov)=>ls.map(l=>({...l,want:l.interest,brand:'HQ',origin:'WhatsApp Direct',
      assignee:(ov&&ov.noAssign)?'':'Aso',staff:(ov&&ov.noAssign)?null:{phone:'+60127674828',openId:'x'}})),
    larkWriteLead:async l=>{leads.push(l);return 'recOff';}, notifyStaff:async()=>'d',
    sla:{register:()=>{}}, getUnavailable:async()=>new Set(), log:()=>{}, isStaffPhone:()=>false,
    wooCheckStock:async()=>({matches:[]}),
    inDistHours:()=>false, inOpenHours:()=>false,            // 01:00 MYT, shop shut
    hoursLabel:()=>require('./hours').hoursLabel([1,2,3,4,5,6],9,18),
    nextWindowLabel:()=>'tomorrow morning',
    larkPatchWant:async(rec,w)=>{patched.push({rec,w});}, larkPatchPhone:async()=>{},
    deferStaffNotify:()=>{}, aiClassify:async()=>null });

  const J3='night@s.whatsapp.net'; const n3=leads.length;
  fr.onMessage({jid:J3,phone:'60133333333',kind:'text',text:'Hi'}); await wait(500);
  fr.onMessage({jid:J3,phone:'60133333333',kind:'text',text:'Tm motorworld'}); await wait(500);
  ok(leads.length===n3,'off-hours: nothing written to Lark while intent is unknown');
  ok(sent.some(s=>/beli.*jual|jual.*beli/i.test(s.text)),'off-hours: buy-or-sell asked at night too');
  fr.onMessage({jid:J3,phone:'60133333333',kind:'text',text:'Saya nak jual motor saya'});
  await wait(600);
  ok(leads.length===n3+1,'off-hours: the answer creates the lead');
  ok(leads[leads.length-1] && /TRADE-IN/i.test(String(leads[leads.length-1].want||'')),
     '🚨 off-hours: a night-time trade-in is filed as a trade-in, not as a sales lead');

  // ---- LATE ANSWER. The message that lands seconds after the bot goes quiet used to be dropped.
  const J4='late@s.whatsapp.net';
  fr.onMessage({jid:J4,phone:'60144444444',kind:'text',text:'Nak tanya zontes 368G'});
  await wait(600);
  const before=patched.length;
  fr.onMessage({jid:J4,phone:'60144444444',kind:'text',text:'Sy minat 368G V2.1 High Seat, guna EPP maybank'});
  await wait(600);
  ok(patched.length===before+1,'🚨 late answer is written onto the existing lead, not dropped');
  ok(patched.length>before && /EPP maybank/i.test(patched[patched.length-1].w),
     'late answer: the salesperson actually gets the financing detail');
  const nSent=sent.length;
  fr.onMessage({jid:J4,phone:'60144444444',kind:'text',text:'Ada high seat tak'});
  await wait(600);
  ok(sent.length===nSent,'late answer: still SILENT to the customer (one-touch rule unchanged)');


  // ---- IMAGE THAT IS ACTUALLY A SELL AD (2026-09-16) ----------------------------------------
  // 60163953737 sent back TM's own "NAK JUAL MOTOR TAPI ADA BAKI HUTANG LAGI?!" creative and was
  // filed as a buyer, then waited 105 minutes and wrote "Dia ni takde response".
  let imgVerdict='product', imgSeen=null;
  fr.init({ waSend:async(to,t)=>{sent.push({to,text:t});return 'm';},
    assignLeads:(ls,ov)=>ls.map(l=>({...l,want:l.interest,brand:'HQ',origin:'WhatsApp Direct',
      assignee:(ov&&ov.noAssign)?'':'Aso',staff:(ov&&ov.noAssign)?null:{phone:'+60127674828',openId:'x'}})),
    larkWriteLead:async l=>{leads.push(l);return 'recImg';}, notifyStaff:async()=>'d',
    sla:{register:()=>{}}, getUnavailable:async()=>new Set(), log:()=>{}, isStaffPhone:()=>false,
    wooCheckStock:async()=>({matches:[]}), inDistHours:()=>true, inOpenHours:()=>true,
    hoursLabel:()=>require('./hours').hoursLabel([1,2,3,4,5,6],9,18),
    nextWindowLabel:()=>null, larkPatchWant:async()=>{}, larkPatchPhone:async()=>{},
    deferStaffNotify:()=>{}, aiClassify:async()=>null,
    aiClassifyImage:async(url)=>{ imgSeen=url; return imgVerdict; } });

  const n5=leads.length;
  imgVerdict='sell';
  fr.onMessage({jid:'sellad@s.whatsapp.net',phone:'60163953737',kind:'image',text:'',imageUrl:'https://x/ad.jpg'});
  await wait(700);
  ok(imgSeen==='https://x/ad.jpg','image: the classifier was actually given the picture');
  ok(leads.length===n5+1 && /TRADE-IN/i.test(String(leads[leads.length-1].want||'')),
     '🚨 image: a SELL advert routes to the purchaser, not to a sales rep');

  imgVerdict='product';
  const n6=leads.length;
  fr.onMessage({jid:'buyad@s.whatsapp.net',phone:'60163953738',kind:'image',text:'',imageUrl:'https://x/buy.jpg'});
  await wait(700);
  ok(leads.length===n6+1 && !/TRADE-IN/i.test(String(leads[leads.length-1].want||'')),
     'image: a normal bike/promo picture still goes to a sales rep (behaviour unchanged)');

  // no URL, or a vision failure, must never change today's behaviour
  const n7=leads.length;
  fr.onMessage({jid:'noimg@s.whatsapp.net',phone:'60163953739',kind:'image',text:''});
  await wait(700);
  ok(leads.length===n7+1,'image: no readable URL still produces a lead, exactly as before');

  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
