import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import Database from 'better-sqlite3';
import Stripe from 'stripe';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const app=express();
const PORT=Number(process.env.PORT||3000);
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'arena43';
const BASE_URL=process.env.BASE_URL||`http://localhost:${PORT}`;
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data');
const OWNER_EMAIL=process.env.OWNER_EMAIL||'virtualarena43@gmail.com';
const EMAIL_FROM=process.env.EMAIL_FROM||'Virtual Arena 43 <onboarding@resend.dev>';
const RESEND_API_KEY=process.env.RESEND_API_KEY||'';
const stripe=process.env.STRIPE_SECRET_KEY?new Stripe(process.env.STRIPE_SECRET_KEY):null;

fs.mkdirSync(DATA_DIR,{recursive:true});
const db=new Database(path.join(DATA_DIR,'arena43.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS bookings(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 booking_code TEXT UNIQUE NOT NULL,
 booking_date TEXT NOT NULL,
 booking_time TEXT NOT NULL,
 players INTEGER NOT NULL CHECK(players BETWEEN 1 AND 4),
 total_cents INTEGER NOT NULL,
 name TEXT NOT NULL,
 phone TEXT NOT NULL,
 email TEXT NOT NULL,
 notes TEXT DEFAULT '',
 payment_method TEXT NOT NULL CHECK(payment_method IN ('arena','online')),
 payment_status TEXT NOT NULL DEFAULT 'pending',
 stripe_session_id TEXT,
 status TEXT NOT NULL DEFAULT 'confirmed',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(booking_date,booking_time,status);
CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocked_slots(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 block_date TEXT NOT NULL,
 block_time TEXT,
 reason TEXT DEFAULT '',
 UNIQUE(block_date,block_time)
);
CREATE TABLE IF NOT EXISTS discounts(
 code TEXT PRIMARY KEY,
 percent INTEGER NOT NULL CHECK(percent BETWEEN 1 AND 100),
 active INTEGER NOT NULL DEFAULT 1
);
`);

const cols=db.prepare(`PRAGMA table_info(bookings)`).all().map(r=>r.name);
for(const [name,sql] of [
 ['email_sent_at',`ALTER TABLE bookings ADD COLUMN email_sent_at TEXT`],
 ['discount_code',`ALTER TABLE bookings ADD COLUMN discount_code TEXT`],
 ['billing_first_name',`ALTER TABLE bookings ADD COLUMN billing_first_name TEXT`],
 ['billing_last_name',`ALTER TABLE bookings ADD COLUMN billing_last_name TEXT`],
 ['billing_address',`ALTER TABLE bookings ADD COLUMN billing_address TEXT`],
 ['billing_tax_code',`ALTER TABLE bookings ADD COLUMN billing_tax_code TEXT`],
 ['internal_notes',`ALTER TABLE bookings ADD COLUMN internal_notes TEXT DEFAULT ''`]
]) if(!cols.includes(name)) db.exec(sql);

const DEFAULT_SCHEDULE={0:['17:30','18:15','19:00','19:45','20:30','21:15'],3:['17:00','17:45','18:30','19:15'],5:['17:30','18:15','19:00','19:45','20:30','21:15'],6:['17:30','18:15','19:00','19:45','20:30','21:15']};
const DEFAULT_PRICES={1:2500,2:4000,3:6000,4:8000};
const ESCAPE_SUNDAY={enabled:true,slots:['19:30','21:00'],prices:{2:5000,3:7500,4:10000},duration:60};
function setSetting(key,val){db.prepare(`INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key,JSON.stringify(val))}
function getSetting(key,fallback){const r=db.prepare(`SELECT value FROM app_settings WHERE key=?`).get(key);if(!r){setSetting(key,fallback);return fallback}try{return JSON.parse(r.value)}catch{return fallback}}
function schedule(){return getSetting('schedule',DEFAULT_SCHEDULE)}
function prices(){return getSetting('prices',DEFAULT_PRICES)}
if(!db.prepare(`SELECT 1 FROM discounts WHERE code='MINU43'`).get())db.prepare(`INSERT INTO discounts(code,percent,active) VALUES('MINU43',10,1)`).run();

function adminOK(req){return(req.headers['x-admin-password']||req.query.password||'')===ADMIN_PASSWORD}
function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function whatsappNumber(v=''){let n=String(v).replace(/\D/g,'');if(n.startsWith('00'))n=n.slice(2);if(n.startsWith('3')&&n.length===10)n='39'+n;return n}
function euros(c){return new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR'}).format(c/100)}
function code(){return'A43-'+Math.random().toString(36).slice(2,7).toUpperCase()+'-'+Date.now().toString().slice(-5)}
function validDate(d){return /^\d{4}-\d{2}-\d{2}$/.test(String(d))&&!Number.isNaN(new Date(`${d}T12:00:00`).getTime())}
function isEscapeSunday(d){return validDate(d)&&ESCAPE_SUNDAY.enabled&&new Date(`${d}T12:00:00`).getDay()===0}
function slotsForDate(d){if(!validDate(d))return[];if(isEscapeSunday(d))return ESCAPE_SUNDAY.slots;const dow=new Date(`${d}T12:00:00`).getDay();return schedule()[dow]||[]}
function isBlocked(d,t){return !!db.prepare(`SELECT 1 FROM blocked_slots WHERE block_date=? AND (block_time IS NULL OR block_time=?) LIMIT 1`).get(d,t)}
function validSlot(d,t){return slotsForDate(d).includes(t)&&!isBlocked(d,t)}
function expire(){db.prepare(`UPDATE bookings SET status='expired' WHERE status='pending_payment' AND datetime(created_at)<datetime('now','-30 minutes')`).run()}
function occupied(d,t,excludeId=null){expire();let q=`SELECT COALESCE(SUM(players),0) used FROM bookings WHERE booking_date=? AND booking_time=? AND status IN ('confirmed','pending_payment')`;const args=[d,t];if(excludeId){q+=` AND id<>?`;args.push(excludeId)}return Number(db.prepare(q).get(...args).used||0)}
function activeBookingsCount(d,t,excludeId=null){expire();let q=`SELECT COUNT(*) n FROM bookings WHERE booking_date=? AND booking_time=? AND status IN ('confirmed','pending_payment')`;const args=[d,t];if(excludeId){q+=` AND id<>?`;args.push(excludeId)}return Number(db.prepare(q).get(...args).n||0)}
function discountInfo(raw=''){const c=String(raw).trim().toUpperCase();if(!c)return null;return db.prepare(`SELECT code,percent FROM discounts WHERE code=? AND active=1`).get(c)||null}
function baseTotal(p,date=''){if(isEscapeSunday(date))return Number(ESCAPE_SUNDAY.prices[p]||0);const pr=prices();return Number(pr[p]??DEFAULT_PRICES[p])}
function discountedTotal(p,raw='',date=''){const d=discountInfo(raw),base=baseTotal(p,date);return{code:d?.code||'',percent:d?.percent||0,total:d?Math.round(base*(100-d.percent)/100):base}}
function bookingByCode(c){return db.prepare(`SELECT * FROM bookings WHERE booking_code=?`).get(c)}

async function sendResendEmail({to,subject,html,replyTo}){if(!RESEND_API_KEY)return{skipped:true};const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:EMAIL_FROM,to:Array.isArray(to)?to:[to],subject,html,reply_to:replyTo})});if(!r.ok)throw new Error(`Resend ${r.status}: ${await r.text()}`);return r.json()}
function customerEmailHtml(b){const escape=isEscapeSunday(b.booking_date);return`<!doctype html><html><body style="margin:0;background:#0b0b0d;color:#fff;font-family:Arial,sans-serif"><div style="max-width:620px;margin:auto;padding:30px"><div style="border:1px solid #2b2b31;border-radius:18px;padding:28px;background:#151519"><div style="font-size:13px;letter-spacing:2px;color:#ffd400;font-weight:700">VIRTUAL ARENA 43</div><h1>Prenotazione confermata</h1><p>Ciao <strong>${esc(b.name)}</strong>, la tua prenotazione è confermata.</p>${escape?'<p><strong>ESCAPE SUNDAY · 60 minuti</strong></p>':''}<table style="width:100%;color:#fff"><tr><td>Data</td><td style="text-align:right"><strong>${esc(b.booking_date)}</strong></td></tr><tr><td>Orario</td><td style="text-align:right"><strong>${esc(b.booking_time)}</strong></td></tr><tr><td>Giocatori</td><td style="text-align:right"><strong>${b.players}</strong></td></tr><tr><td>Totale</td><td style="text-align:right"><strong>${euros(b.total_cents)}</strong></td></tr><tr><td>Codice</td><td style="text-align:right"><strong>${esc(b.booking_code)}</strong></td></tr></table><div style="background:#ffd400;color:#000;border-radius:12px;padding:15px;font-weight:800;text-align:center;margin-top:20px">Presentati 10 minuti prima dell'orario prenotato</div></div></div></body></html>`}
function ownerEmailHtml(b){const wa=whatsappNumber(b.phone),escape=isEscapeSunday(b.booking_date);return`<!doctype html><html><body style="font-family:Arial,sans-serif;background:#111;color:#fff;padding:24px"><div style="max-width:620px;margin:auto;background:#1a1a1e;border-radius:16px;padding:24px"><h2 style="color:#ffd400;margin-top:0">Nuova prenotazione Virtual Arena 43</h2>${escape?'<p style="color:#ffd400"><strong>ESCAPE SUNDAY</strong></p>':''}<p><strong>${esc(b.name)}</strong></p><p>${esc(b.booking_date)} alle ${esc(b.booking_time)} · ${b.players} giocatori</p><p>Totale: <strong>${euros(b.total_cents)}</strong></p><p>Telefono: <strong>${esc(b.phone)}</strong> · <a href="https://wa.me/${wa}" style="color:#25D366">WhatsApp</a></p><p>Email: ${esc(b.email)}</p><p>Codice: <strong>${esc(b.booking_code)}</strong></p></div></body></html>`}
async function sendBookingEmails(c){const b=bookingByCode(c);if(!b||b.email_sent_at||b.status!=='confirmed')return;try{await sendResendEmail({to:b.email,subject:`Prenotazione confermata — Virtual Arena 43 — ${b.booking_date} ${b.booking_time}`,html:customerEmailHtml(b),replyTo:OWNER_EMAIL});await sendResendEmail({to:OWNER_EMAIL,subject:`Nuova prenotazione — ${b.booking_date} ${b.booking_time} — ${b.name}`,html:ownerEmailHtml(b),replyTo:b.email});if(RESEND_API_KEY)db.prepare(`UPDATE bookings SET email_sent_at=CURRENT_TIMESTAMP WHERE booking_code=?`).run(c)}catch(e){console.error('Errore invio email',e)}}

app.post('/api/stripe/webhook',express.raw({type:'application/json'}),async(req,res)=>{if(!stripe||!process.env.STRIPE_WEBHOOK_SECRET)return res.status(503).send('Stripe non configurato');let event;try{event=stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET)}catch(e){return res.status(400).send('Webhook Error: '+e.message)}const s=event.data.object,c=s.metadata?.booking_code;if(c&&event.type==='checkout.session.completed'){db.prepare(`UPDATE bookings SET payment_status='paid',status='confirmed' WHERE booking_code=?`).run(c);await sendBookingEmails(c)}if(c&&event.type==='checkout.session.expired')db.prepare(`UPDATE bookings SET status='expired' WHERE booking_code=? AND payment_status!='paid'`).run(c);res.json({received:true})});

app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

app.get('/api/config',(req,res)=>{res.json({schedule:schedule(),prices:prices(),escapeSunday:ESCAPE_SUNDAY})});
app.get('/api/availability',(req,res)=>{const date=String(req.query.date||'');if(!validDate(date))return res.status(400).json({error:'Data non valida'});const closedDay=db.prepare(`SELECT reason FROM blocked_slots WHERE block_date=? AND block_time IS NULL`).get(date);if(closedDay)return res.json({date,slots:[],escapeSunday:isEscapeSunday(date),closed:true,reason:closedDay.reason||'SOLD OUT'});const escape=isEscapeSunday(date);res.json({date,escapeSunday:escape,slots:slotsForDate(date).map(time=>{const block=db.prepare(`SELECT reason FROM blocked_slots WHERE block_date=? AND block_time=?`).get(date,time);return{time,available:block?0:(escape?(activeBookingsCount(date,time)>0?0:4):Math.max(0,4-occupied(date,time))),blocked:!!block,reason:block?.reason||''}})})});
app.post('/api/discount',(req,res)=>{const d=discountInfo(req.body?.code);if(!d)return res.status(404).json({valid:false,error:'Codice sconto non valido'});res.json({valid:true,code:d.code,percent:d.percent})});

const insert=db.prepare(`INSERT INTO bookings(booking_code,booking_date,booking_time,players,total_cents,name,phone,email,notes,payment_method,payment_status,status,discount_code,billing_first_name,billing_last_name,billing_address,billing_tax_code,internal_notes) VALUES (@booking_code,@booking_date,@booking_time,@players,@total_cents,@name,@phone,@email,@notes,@payment_method,@payment_status,@status,@discount_code,@billing_first_name,@billing_last_name,@billing_address,@billing_tax_code,@internal_notes)`);
const insertTx=db.transaction(b=>{if(isEscapeSunday(b.booking_date)){if(activeBookingsCount(b.booking_date,b.booking_time)>0||isBlocked(b.booking_date,b.booking_time))throw new Error('SLOT_FULL')}else if(occupied(b.booking_date,b.booking_time)+b.players>4||isBlocked(b.booking_date,b.booking_time))throw new Error('SLOT_FULL');insert.run(b)});

app.post('/api/bookings',async(req,res)=>{let booking_code;try{const{date,time,players,name,phone,email,notes='',paymentMethod,discountCode='',billing={}}=req.body||{};const p=Number(players),today=new Date(),chosen=new Date(`${date}T12:00:00`),escape=isEscapeSunday(date);today.setHours(0,0,0,0);if(!validSlot(date,time)||chosen<today)return res.status(400).json({error:'Slot non valido'});if(escape?![2,3,4].includes(p):![1,2,3,4].includes(p))return res.status(400).json({error:escape?'Escape Sunday disponibile per 2, 3 o 4 giocatori':'Numero giocatori non valido'});if(!name||!phone||!email)return res.status(400).json({error:'Compila nome, telefono ed email'});if(!['arena','online'].includes(paymentMethod))return res.status(400).json({error:'Metodo di pagamento non valido'});if(discountCode&&!discountInfo(discountCode))return res.status(400).json({error:'Codice sconto non valido'});if(paymentMethod==='online'){const fn=String(billing.firstName||'').trim(),ln=String(billing.lastName||'').trim(),ad=String(billing.address||'').trim(),cf=String(billing.taxCode||'').trim().toUpperCase();if(!fn||!ln||!ad||!cf)return res.status(400).json({error:'Compila tutti i dati di fatturazione'});if(!/^[A-Z0-9]{16}$/.test(cf))return res.status(400).json({error:'Codice fiscale non valido'});if(!stripe)return res.status(503).json({error:'Pagamento online non ancora collegato a Stripe'})}booking_code=code();const calc=discountedTotal(p,discountCode,date),online=paymentMethod==='online',finalNotes=escape?(`[ESCAPE SUNDAY]${notes?` ${String(notes).trim()}`:''}`):String(notes||'').trim();insertTx({booking_code,booking_date:date,booking_time:time,players:p,total_cents:calc.total,name:String(name).trim(),phone:String(phone).trim(),email:String(email).trim(),notes:finalNotes,payment_method:paymentMethod,payment_status:online?'pending':'pay_at_venue',status:online?'pending_payment':'confirmed',discount_code:calc.code,billing_first_name:online?String(billing.firstName).trim():'',billing_last_name:online?String(billing.lastName).trim():'',billing_address:online?String(billing.address).trim():'',billing_tax_code:online?String(billing.taxCode).trim().toUpperCase():'',internal_notes:''});if(online){try{const session=await stripe.checkout.sessions.create({mode:'payment',success_url:`${BASE_URL}/?paid=1&code=${encodeURIComponent(booking_code)}`,cancel_url:`${BASE_URL}/?cancelled=1&code=${encodeURIComponent(booking_code)}`,customer_email:String(email).trim(),expires_at:Math.floor(Date.now()/1000)+1800,metadata:{booking_code},line_items:[{quantity:1,price_data:{currency:'eur',unit_amount:calc.total,product_data:{name:`Virtual Arena 43 — ${escape?'Escape Sunday — ':''}${p} giocatori — ${date} ${time}`}}}]});db.prepare(`UPDATE bookings SET stripe_session_id=? WHERE booking_code=?`).run(session.id,booking_code);return res.json({ok:true,bookingCode:booking_code,checkoutUrl:session.url,totalCents:calc.total})}catch(e){db.prepare(`UPDATE bookings SET status='expired' WHERE booking_code=?`).run(booking_code);throw e}}await sendBookingEmails(booking_code);res.json({ok:true,bookingCode:booking_code,totalCents:calc.total})}catch(e){if(e.message==='SLOT_FULL')return res.status(409).json({error:'Questo slot non è più disponibile'});console.error(e);res.status(500).json({error:'Errore interno'})}});

app.get('/api/admin/bookings',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});expire();const q=String(req.query.q||'').trim(),date=String(req.query.date||'').trim();let sql=`SELECT * FROM bookings WHERE 1=1`,args=[];if(q){sql+=` AND (name LIKE ? OR phone LIKE ? OR email LIKE ? OR booking_code LIKE ?)`;const x=`%${q}%`;args.push(x,x,x,x)}if(date){sql+=` AND booking_date=?`;args.push(date)}sql+=` ORDER BY booking_date,booking_time,created_at`;res.json(db.prepare(sql).all(...args))});
app.get('/api/admin/stats',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});const from=String(req.query.from||'0000-01-01'),to=String(req.query.to||'9999-12-31');const r=db.prepare(`SELECT COUNT(*) bookings,COALESCE(SUM(players),0) players,COALESCE(SUM(total_cents),0) total_cents,COALESCE(SUM(CASE WHEN payment_status='paid' THEN total_cents ELSE 0 END),0) paid_cents,COALESCE(SUM(CASE WHEN payment_status!='paid' AND status='confirmed' THEN total_cents ELSE 0 END),0) due_cents FROM bookings WHERE booking_date BETWEEN ? AND ? AND status='confirmed'`).get(from,to);res.json(r)});
app.get('/api/admin/config',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});res.json({schedule:schedule(),prices:prices(),escapeSunday:ESCAPE_SUNDAY,blocked:db.prepare(`SELECT * FROM blocked_slots ORDER BY block_date,block_time`).all(),discounts:db.prepare(`SELECT code,percent,active FROM discounts ORDER BY code`).all()})});
app.put('/api/admin/config',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});const s=req.body?.schedule,p=req.body?.prices;if(s){const clean={};for(const [k,v] of Object.entries(s)){const day=Number(k);if(day<0||day>6||!Array.isArray(v))continue;clean[day]=[...new Set(v.map(x=>String(x).trim()).filter(x=>/^\d{2}:\d{2}$/.test(x)))].sort()}setSetting('schedule',clean)}if(p){const clean={};for(let n=1;n<=4;n++){const cents=Math.round(Number(p[n]));if(!Number.isFinite(cents)||cents<0)return res.status(400).json({error:'Prezzi non validi'});clean[n]=cents}setSetting('prices',clean)}res.json({ok:true,schedule:schedule(),prices:prices(),escapeSunday:ESCAPE_SUNDAY})});
app.patch('/api/admin/bookings/:id/cancel',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});db.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`).run(req.params.id);res.json({ok:true})});
app.patch('/api/admin/bookings/:id/players',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});const id=Number(req.params.id),p=Number(req.body?.players);const b=db.prepare(`SELECT * FROM bookings WHERE id=?`).get(id);if(!b)return res.status(404).json({error:'Prenotazione non trovata'});const escape=isEscapeSunday(b.booking_date);if(!Number.isInteger(p)||(escape?(p<2||p>4):(p<1||p>4)))return res.status(400).json({error:'Numero giocatori non valido'});if(!['confirmed','pending_payment'].includes(b.status))return res.status(400).json({error:'Prenotazione non attiva'});if(!escape&&occupied(b.booking_date,b.booking_time,id)+p>4)return res.status(409).json({error:'Non ci sono abbastanza posti nello slot'});const total=b.payment_status==='paid'?b.total_cents:discountedTotal(p,b.discount_code,b.booking_date).total;db.prepare(`UPDATE bookings SET players=?,total_cents=? WHERE id=?`).run(p,total,id);res.json({ok:true})});
app.patch('/api/admin/bookings/:id/move',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});const id=Number(req.params.id),date=String(req.body?.date||''),time=String(req.body?.time||'');const b=db.prepare(`SELECT * FROM bookings WHERE id=?`).get(id);if(!b)return res.status(404).json({error:'Prenotazione non trovata'});if(!validSlot(date,time))return res.status(400).json({error:'Nuovo slot non valido o bloccato'});const escape=isEscapeSunday(date);if(escape&&b.players<2)return res.status(400).json({error:'Escape Sunday richiede almeno 2 giocatori'});if(escape?activeBookingsCount(date,time,id)>0:occupied(date,time,id)+b.players>4)return res.status(409).json({error:'Non ci sono abbastanza posti nel nuovo slot'});const total=b.payment_status==='paid'?b.total_cents:discountedTotal(b.players,b.discount_code,date).total;db.prepare(`UPDATE bookings SET booking_date=?,booking_time=?,total_cents=? WHERE id=?`).run(date,time,total,id);res.json({ok:true})});
app.patch('/api/admin/bookings/:id/paid',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});db.prepare(`UPDATE bookings SET payment_status='paid' WHERE id=?`).run(req.params.id);res.json({ok:true})});
app.patch('/api/admin/bookings/:id/internal-notes',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});db.prepare(`UPDATE bookings SET internal_notes=? WHERE id=?`).run(String(req.body?.internalNotes||''),req.params.id);res.json({ok:true})});
app.post('/api/admin/bookings/manual',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});const{date,time,players,name,phone='',email='',notes='',paid=false}=req.body||{},p=Number(players),escape=isEscapeSunday(date);if(!validSlot(date,time)||(escape?![2,3,4].includes(p):![1,2,3,4].includes(p))||!name)return res.status(400).json({error:'Dati prenotazione non validi'});const c=code(),calc=discountedTotal(p,'',date);try{insertTx({booking_code:c,booking_date:date,booking_time:time,players:p,total_cents:calc.total,name:String(name).trim(),phone:String(phone).trim()||'-',email:String(email).trim()||'manuale@virtualarena43.it',notes:escape?`[ESCAPE SUNDAY] ${String(notes).trim()}`:String(notes).trim(),payment_method:'arena',payment_status:paid?'paid':'pay_at_venue',status:'confirmed',discount_code:'',billing_first_name:'',billing_last_name:'',billing_address:'',billing_tax_code:'',internal_notes:'Inserita manualmente'});res.json({ok:true,bookingCode:c})}catch(e){if(e.message==='SLOT_FULL')return res.status(409).json({error:'Slot pieno'});throw e}});
app.post('/api/admin/blocks',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});const date=String(req.body?.date||''),time=req.body?.time?String(req.body.time):null,reason=String(req.body?.reason||'').trim().slice(0,50)||'SOLD OUT';if(!validDate(date))return res.status(400).json({error:'Data non valida'});if(time&&!slotsForDate(date).includes(time))return res.status(400).json({error:'Orario non previsto per questa data'});if(time)db.prepare(`DELETE FROM blocked_slots WHERE block_date=? AND block_time=?`).run(date,time);else db.prepare(`DELETE FROM blocked_slots WHERE block_date=?`).run(date);db.prepare(`INSERT INTO blocked_slots(block_date,block_time,reason) VALUES(?,?,?)`).run(date,time,reason);res.json({ok:true})});
app.delete('/api/admin/blocks/:id',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});db.prepare(`DELETE FROM blocked_slots WHERE id=?`).run(req.params.id);res.json({ok:true})});
app.post('/api/admin/discounts',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});const code=String(req.body?.code||'').trim().toUpperCase(),percent=Number(req.body?.percent);if(!/^[A-Z0-9_-]{2,20}$/.test(code)||!Number.isInteger(percent)||percent<1||percent>100)return res.status(400).json({error:'Codice o percentuale non validi'});db.prepare(`INSERT INTO discounts(code,percent,active) VALUES(?,?,1) ON CONFLICT(code) DO UPDATE SET percent=excluded.percent,active=1`).run(code,percent);res.json({ok:true})});
app.patch('/api/admin/discounts/:code',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});const active=req.body?.active?1:0;db.prepare(`UPDATE discounts SET active=? WHERE code=?`).run(active,String(req.params.code).toUpperCase());res.json({ok:true})});

app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.listen(PORT,'0.0.0.0',()=>console.log(`Virtual Arena 43 attiva su ${BASE_URL}`));
