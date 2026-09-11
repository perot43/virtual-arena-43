import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import Database from 'better-sqlite3';
import Stripe from 'stripe';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'arena43';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'virtualarena43@gmail.com';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Virtual Arena 43 <onboarding@resend.dev>';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'arena43.db'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS bookings(
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
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(booking_date,booking_time,status);`);
const cols = db.prepare(`PRAGMA table_info(bookings)`).all().map(r => r.name);
if (!cols.includes('email_sent_at')) db.exec(`ALTER TABLE bookings ADD COLUMN email_sent_at TEXT`);
if (!cols.includes('discount_code')) db.exec(`ALTER TABLE bookings ADD COLUMN discount_code TEXT`);

const schedule={3:['17:00','17:45','18:30','19:15'],5:['17:30','18:15','19:00','19:45','20:30','21:15'],6:['17:30','18:15','19:00','19:45','20:30','21:15'],0:['17:30','18:15','19:00','19:45','20:30','21:15']};
const discounts={MINU43:10};
function validSlot(d,t){const x=new Date(`${d}T12:00:00`);return !Number.isNaN(x.getTime())&&(schedule[x.getDay()]||[]).includes(t)}
function baseTotal(p){return p===1?2500:p*2000}
function discountedTotal(p,raw=''){const c=String(raw).trim().toUpperCase(),pct=discounts[c]||0,base=baseTotal(p);return {code:pct?c:'',percent:pct,total:pct?Math.round(base*(100-pct)/100):base}}
function code(){return 'A43-'+Math.random().toString(36).slice(2,7).toUpperCase()+'-'+Date.now().toString().slice(-5)}
function expire(){db.prepare(`UPDATE bookings SET status='expired' WHERE status='pending_payment' AND datetime(created_at)<datetime('now','-30 minutes')`).run()}
function occupied(d,t){expire();return Number(db.prepare(`SELECT COALESCE(SUM(players),0) used FROM bookings WHERE booking_date=? AND booking_time=? AND status IN ('confirmed','pending_payment')`).get(d,t).used||0)}
function euros(c){return new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR'}).format(c/100)}
function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function whatsappNumber(v=''){let n=String(v).replace(/\D/g,'');if(n.startsWith('00'))n=n.slice(2);if(n.startsWith('3')&&n.length===10)n='39'+n;return n}
function bookingByCode(c){return db.prepare(`SELECT * FROM bookings WHERE booking_code=?`).get(c)}
async function sendResendEmail({to,subject,html,replyTo}){if(!RESEND_API_KEY){console.log('Email non inviata: RESEND_API_KEY non configurata');return {skipped:true}}const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:EMAIL_FROM,to:Array.isArray(to)?to:[to],subject,html,reply_to:replyTo})});if(!r.ok)throw new Error(`Resend ${r.status}: ${await r.text()}`);return r.json()}
function customerEmailHtml(b){const payment=b.payment_method==='online'?'Pagamento online':'Pagamento in arena',status=b.payment_status==='paid'?'Pagato':'Da pagare in arena',disc=b.discount_code?`<tr><td style="padding:9px 0;color:#aaa">Codice sconto</td><td style="text-align:right"><strong>${esc(b.discount_code)} · -10%</strong></td></tr>`:'';return `<!doctype html><html><body style="margin:0;background:#0b0b0d;color:#fff;font-family:Arial,sans-serif"><div style="max-width:620px;margin:auto;padding:30px"><div style="border:1px solid #2b2b31;border-radius:18px;padding:28px;background:#151519"><div style="font-size:13px;letter-spacing:2px;color:#ffd400;font-weight:700">VIRTUAL ARENA 43</div><h1>Prenotazione confermata</h1><p>Ciao <strong>${esc(b.name)}</strong>, la tua prenotazione è confermata.</p><table style="width:100%;color:#fff"><tr><td>Data</td><td style="text-align:right"><strong>${esc(b.booking_date)}</strong></td></tr><tr><td>Orario</td><td style="text-align:right"><strong>${esc(b.booking_time)}</strong></td></tr><tr><td>Giocatori</td><td style="text-align:right"><strong>${b.players}</strong></td></tr>${disc}<tr><td>Totale</td><td style="text-align:right"><strong>${euros(b.total_cents)}</strong></td></tr><tr><td>Pagamento</td><td style="text-align:right"><strong>${payment} · ${status}</strong></td></tr><tr><td>Codice prenotazione</td><td style="text-align:right"><strong>${esc(b.booking_code)}</strong></td></tr></table><div style="background:#ffd400;color:#000;border-radius:12px;padding:15px;font-weight:800;text-align:center;margin-top:20px">Presentati 10 minuti prima dell'orario prenotato</div></div></div></body></html>`}
function ownerEmailHtml(b){const payment=b.payment_method==='online'?'ONLINE':'IN ARENA',status=b.payment_status==='paid'?'PAGATO':'DA PAGARE',disc=b.discount_code?`<p>Sconto: <strong>${esc(b.discount_code)} · -10%</strong></p>`:'',wa=whatsappNumber(b.phone);return `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#111;color:#fff;padding:24px"><div style="max-width:620px;margin:auto;background:#1a1a1e;border-radius:16px;padding:24px"><h2 style="color:#ffd400;margin-top:0">Nuova prenotazione Virtual Arena 43</h2><p><strong>${esc(b.name)}</strong></p><p>Telefono: <strong>${esc(b.phone)}</strong></p><p style="margin:14px 0"><a href="https://wa.me/${wa}" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;font-weight:800;padding:12px 18px;border-radius:10px">Apri WhatsApp</a></p><p>Email: <a href="mailto:${esc(b.email)}" style="color:#5da9ff">${esc(b.email)}</a></p><p><strong>${esc(b.booking_date)} alle ${esc(b.booking_time)}</strong> · ${b.players} giocatori</p>${disc}<p>Totale: <strong>${euros(b.total_cents)}</strong></p><p>Pagamento: <strong>${payment} · ${status}</strong></p><p>Codice: <strong>${esc(b.booking_code)}</strong></p>${b.notes?`<p>Note: ${esc(b.notes)}</p>`:''}</div></body></html>`}
async function sendBookingEmails(c){const b=bookingByCode(c);if(!b||b.email_sent_at||b.status!=='confirmed')return;try{await sendResendEmail({to:b.email,subject:`Prenotazione confermata — Virtual Arena 43 — ${b.booking_date} ${b.booking_time}`,html:customerEmailHtml(b),replyTo:OWNER_EMAIL});await sendResendEmail({to:OWNER_EMAIL,subject:`Nuova prenotazione — ${b.booking_date} ${b.booking_time} — ${b.name}`,html:ownerEmailHtml(b),replyTo:b.email});if(RESEND_API_KEY)db.prepare(`UPDATE bookings SET email_sent_at=CURRENT_TIMESTAMP WHERE booking_code=?`).run(c)}catch(e){console.error('Errore invio email',c,e)}}
app.post('/api/stripe/webhook',express.raw({type:'application/json'}),async(req,res)=>{if(!stripe||!process.env.STRIPE_WEBHOOK_SECRET)return res.status(503).send('Stripe non configurato');let event;try{event=stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET)}catch(e){return res.status(400).send('Webhook Error: '+e.message)}const s=event.data.object,c=s.metadata?.booking_code;if(c&&event.type==='checkout.session.completed'){db.prepare(`UPDATE bookings SET payment_status='paid',status='confirmed' WHERE booking_code=?`).run(c);await sendBookingEmails(c)}if(c&&event.type==='checkout.session.expired')db.prepare(`UPDATE bookings SET status='expired' WHERE booking_code=? AND payment_status!='paid'`).run(c);res.json({received:true})});
app.use(helmet({contentSecurityPolicy:false}));app.use(express.json());app.use(express.static(path.join(__dirname,'public')));
app.get('/api/availability',(req,res)=>{const date=String(req.query.date||''),d=new Date(`${date}T12:00:00`);if(Number.isNaN(d.getTime()))return res.status(400).json({error:'Data non valida'});res.json({date,slots:(schedule[d.getDay()]||[]).map(time=>({time,available:Math.max(0,4-occupied(date,time))}))})});
app.post('/api/discount',(req,res)=>{const c=String(req.body?.code||'').trim().toUpperCase();if(!discounts[c])return res.status(404).json({valid:false,error:'Codice sconto non valido'});res.json({valid:true,code:c,percent:discounts[c]})});
const insert=db.prepare(`INSERT INTO bookings(booking_code,booking_date,booking_time,players,total_cents,name,phone,email,notes,payment_method,payment_status,status,discount_code) VALUES (@booking_code,@booking_date,@booking_time,@players,@total_cents,@name,@phone,@email,@notes,@payment_method,@payment_status,@status,@discount_code)`);
const tx=db.transaction(b=>{if(occupied(b.booking_date,b.booking_time)+b.players>4)throw new Error('SLOT_FULL');insert.run(b)});
app.post('/api/bookings',async(req,res)=>{let booking_code;try{const{date,time,players,name,phone,email,notes='',paymentMethod,discountCode=''}=req.body||{};const p=Number(players),today=new Date(),chosen=new Date(`${date}T12:00:00`);today.setHours(0,0,0,0);if(!validSlot(date,time)||chosen<today)return res.status(400).json({error:'Slot non valido'});if(![1,2,3,4].includes(p))return res.status(400).json({error:'Numero giocatori non valido'});if(!name||!phone||!email)return res.status(400).json({error:'Compila nome, telefono ed email'});if(!['arena','online'].includes(paymentMethod))return res.status(400).json({error:'Metodo di pagamento non valido'});if(paymentMethod==='online'&&!stripe)return res.status(503).json({error:'Pagamento online non ancora collegato a Stripe'});const rawDiscount=String(discountCode||'').trim();if(rawDiscount&&!discounts[rawDiscount.toUpperCase()])return res.status(400).json({error:'Codice sconto non valido'});booking_code=code();const calc=discountedTotal(p,rawDiscount),total_cents=calc.total,online=paymentMethod==='online';tx({booking_code,booking_date:date,booking_time:time,players:p,total_cents,name:String(name).trim(),phone:String(phone).trim(),email:String(email).trim(),notes:String(notes||'').trim(),payment_method:paymentMethod,payment_status:online?'pending':'pay_at_venue',status:online?'pending_payment':'confirmed',discount_code:calc.code});if(online){try{const session=await stripe.checkout.sessions.create({mode:'payment',success_url:`${BASE_URL}/?paid=1&code=${encodeURIComponent(booking_code)}`,cancel_url:`${BASE_URL}/?cancelled=1&code=${encodeURIComponent(booking_code)}`,customer_email:String(email).trim(),expires_at:Math.floor(Date.now()/1000)+1800,metadata:{booking_code},line_items:[{quantity:1,price_data:{currency:'eur',unit_amount:total_cents,product_data:{name:`Virtual Arena 43 — ${p} giocatori — ${date} ${time}`}}}]});db.prepare(`UPDATE bookings SET stripe_session_id=? WHERE booking_code=?`).run(session.id,booking_code);return res.json({ok:true,bookingCode:booking_code,checkoutUrl:session.url,totalCents:total_cents,discountCode:calc.code})}catch(e){db.prepare(`UPDATE bookings SET status='expired' WHERE booking_code=?`).run(booking_code);throw e}}await sendBookingEmails(booking_code);res.json({ok:true,bookingCode:booking_code,totalCents:total_cents,discountCode:calc.code})}catch(e){if(e.message==='SLOT_FULL')return res.status(409).json({error:'Non ci sono abbastanza posti disponibili in questo slot'});console.error(e);res.status(500).json({error:'Errore interno'})}});
function adminOK(req){return(req.headers['x-admin-password']||req.query.password||'')===ADMIN_PASSWORD}
app.get('/api/admin/bookings',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});expire();res.json(db.prepare(`SELECT * FROM bookings ORDER BY booking_date,booking_time,created_at`).all())});
app.patch('/api/admin/bookings/:id/cancel',(req,res)=>{if(!adminOK(req))return res.status(401).json({error:'Password admin errata'});db.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`).run(req.params.id);res.json({ok:true})});
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.listen(PORT,'0.0.0.0',()=>console.log(`Virtual Arena 43 attiva su ${BASE_URL}`));
