// TM Motor Lead Intake — foundation receiver
// Captures everything dropped in the WhatsApp intake group (text + media metadata),
// logs it (Render logs) + keeps a recent list at GET /. Phase 2 adds AI parse → Lark.
const http = require('http');
const recent = [];
function summarize(p){
  try { return JSON.stringify(p, (k,v)=> (typeof v==='string' && v.length>400)?`[${v.length} chars omitted]`:v).slice(0,4000); }
  catch { return String(p).slice(0,2000); }
}
http.createServer((req,res)=>{
  if(req.method==='POST'){
    let body=''; req.on('data',c=>body+=c);
    req.on('end',()=>{
      let p; try{p=JSON.parse(body)}catch{p={raw:body.slice(0,1500)}}
      const s=summarize(p);
      recent.unshift({at:new Date().toISOString(),summary:s}); if(recent.length>50) recent.pop();
      console.log('=== CAPTURE',new Date().toISOString(),'===\n'+s+'\n');
      res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}');
    });
  } else if(req.url==='/health'){ res.writeHead(200); res.end('ok'); }
  else {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end('<h2>TM Motor Lead Intake — foundation ✅</h2><p>Captures so far: '+recent.length+'</p>'+
      recent.map(e=>'<hr><b>'+e.at+'</b><pre>'+e.summary.replace(/[<>]/g,m=>m=='<'?'&lt;':'&gt;')+'</pre>').join(''));
  }
}).listen(process.env.PORT||3000,()=>console.log('TM lead-intake foundation listening'));
