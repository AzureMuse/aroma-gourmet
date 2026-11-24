// Système de commande en ligne Azure Muse — Cloudflare Worker + D1.
// Public : POST /api/orders, GET /api/track/:token, GET /api/status
// Restaurant : /admin (tableau de bord), /api/admin/*  (session sécurisée côté serveur)
// Telegram : POST /api/tg (webhook signé) — notifications privées + boutons Accepter/Refuser
// Cron (chaque minute) : relances, expiration, nouvel envoi des notifications ratées, purge Loi 25.
import { R } from "./restaurant.js";
import ADMIN_HTML from "./admin.html";
import { sendPush } from "./webpush.js";
import { ICONS, MANIFEST, SW } from "./assets.js";

const MIN = 60000, DAY = 86400000;
const STATUS_FR = { recue:"Reçue", acceptee:"Acceptée", refusee:"Refusée", prete:"Prête",
                    recuperee:"Récupérée", absente:"Client absent", expiree:"Non confirmée" };

/* ---------------------------------------------------------------- utilitaires */
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const fromB64 = s => Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
const rand = n => b64u(crypto.getRandomValues(new Uint8Array(n)));
async function sha256hex(s){ const h = await crypto.subtle.digest("SHA-256", enc.encode(s)); return [...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,"0")).join(""); }
async function hmac(secret, data){
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), {name:"HMAC", hash:"SHA-256"}, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
function safeEq(a, b){ if(a.length !== b.length) return false; let r = 0; for(let i=0;i<a.length;i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const money = n => n.toFixed(2).replace(".", ",") + " $";
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function json(data, status = 200, headers = {}){
  return new Response(JSON.stringify(data), { status, headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store", ...headers } });
}
const fail = (code, message, status = 400, extra = {}) => json({ ok:false, code, message, ...extra }, status);

/* ---------------------------------------------------------------- heure de Montréal */
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: R.timeZone, year:"numeric", month:"2-digit", day:"2-digit",
  hour:"2-digit", minute:"2-digit", weekday:"short", hourCycle:"h23" });
const DOW = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
function mtl(ms){
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, dow: DOW[p.weekday], min: (+p.hour) * 60 + (+p.minute), hhmm: `${p.hour}:${p.minute}` };
}
function mtlToMs(date, hhmm){                 // « 2026-11-24 », « 12:30 » (heure locale) -> epoch ms
  const [y, mo, d] = date.split("-").map(Number), [h, mi] = hhmm.split(":").map(Number);
  for(const off of [240, 300, 180, 360]){     // décalages possibles (HAE / HNE)
    const ms = Date.UTC(y, mo - 1, d, h, mi) + off * MIN;
    const p = mtl(ms);
    if(p.date === date && p.hhmm === hhmm) return ms;
  }
  return NaN;
}
const toMin = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
function windowOf(date, dow){
  if(R.closedDates.includes(date)) return null;
  const w = R.hours[dow]; return w ? { open: toMin(w[0]), close: toMin(w[1]) } : null;
}
function isOpenAt(ms){ const p = mtl(ms), w = windowOf(p.date, p.dow); return !!w && p.min >= w.open && p.min <= w.close - R.lastOrderMin; }
function nextOpening(now){
  for(let d = 0; d <= 8; d++){
    const p = mtl(now + d * DAY), w = windowOf(p.date, p.dow);
    if(!w) continue;
    const ms = mtlToMs(p.date, `${String(Math.floor(w.open/60)).padStart(2,"0")}:${String(w.open%60).padStart(2,"0")}`);
    if(ms > now) return ms;
  }
  return now;
}
const JOURS = ["dim.","lun.","mar.","mer.","jeu.","ven.","sam."], MOIS = ["janv.","févr.","mars","avr.","mai","juin","juil.","août","sept.","oct.","nov.","déc."];
function labelOf(ms, now){
  const p = mtl(ms), t = mtl(now), h = `${Math.floor(p.min/60)} h${p.min%60 ? " " + String(p.min%60).padStart(2,"0") : ""}`;
  if(p.date === t.date) return `Aujourd'hui ${h}`;
  const [, mo, d] = p.date.split("-").map(Number);
  return `${p.date === mtl(now + DAY).date ? "Demain, " : ""}${JOURS[p.dow]} ${d} ${MOIS[mo-1]} ${h}`;
}

// Valide l'heure choisie par le client. Renvoie { slotMs, preorder, label } ou une erreur.
function checkSlot(slot, now){
  if(slot === "asap"){
    if(!isOpenAt(now + R.leadMin * MIN) && !isOpenAt(now)) return { error: "Le restaurant est fermé : choisissez une heure de précommande." };
    const t = mtl(now), w = windowOf(t.date, t.dow);
    if(!w || t.min + R.leadMin > w.close - R.lastOrderMin) return { error: "Les commandes en ligne sont terminées pour aujourd'hui." };
    return { slotMs: now + R.leadMin * MIN, preorder: false, label: "Dès que possible" };
  }
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(String(slot));
  if(!m) return { error: "Heure invalide." };
  const slotMs = mtlToMs(m[1], m[2]);
  if(!Number.isFinite(slotMs)) return { error: "Heure invalide." };
  if(slotMs < now + (R.leadMin - 3) * MIN) return { error: "Cette heure est trop proche. Choisissez une heure plus tard." };
  if(slotMs > now + R.maxDaysAhead * DAY) return { error: "Cette heure est trop éloignée." };
  const p = mtl(slotMs), w = windowOf(p.date, p.dow);
  if(!w || p.min < w.open || p.min > w.close - R.lastOrderMin) return { error: "Le restaurant est fermé à cette heure-là." };
  const preorder = !isOpenAt(now) || p.date !== mtl(now).date;
  return { slotMs, preorder, label: labelOf(slotMs, now) };
}

/* ---------------------------------------------------------------- prix (serveur = seule vérité) */
function priceCart(items, pickupMs){
  if(!Array.isArray(items) || !items.length) return { error: "Le panier est vide." };
  const lines = []; let total = 0, n = 0;
  const p = mtl(pickupMs);
  for(const it of items){
    const [cid, idx] = String(it?.key ?? "").split(":");
    const cat = R.menu.find(c => c.id === cid), art = cat?.items[+idx];
    const qty = Math.floor(Number(it?.qty));
    if(!art || !Number.isInteger(qty) || qty < 1 || qty > R.limits.maxQtyPerLine) return { error: "Un article du panier n'est plus valide. Rechargez la page." , code: "menu_changed" };
    if(it.name && it.name !== art.name) return { error: "Le menu a été mis à jour. Rechargez la page.", code: "menu_changed" };
    const promo = R.promos.find(x => x.category === cid);
    if(promo && (!promo.days.includes(p.dow) || p.min < toMin(promo.from) || p.min >= toMin(promo.to)))
      return { error: `« ${art.name} » est offert seulement de ${promo.from.replace(":"," h ")} à ${promo.to.replace(":"," h ")}. Choisissez une heure dans ce créneau ou retirez-le.`, code: "promo_hours" };
    lines.push({ key: `${cid}:${idx}`, name: art.name, price: art.price, qty });
    total += art.price * qty; n += qty;
  }
  total = Math.round(total * 100) / 100;
  if(n > R.limits.maxItems || total > R.limits.maxSubtotal)
    return { error: `Pour une grosse commande, appelez le restaurant au ${R.tel}.`, code: "too_big" };
  return { lines, total };
}

/* ---------------------------------------------------------------- réglages en base */
async function getSetting(env, key){ return (await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first())?.value ?? null; }
async function setSetting(env, key, value){ await env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, String(value)).run(); }
async function logEvent(env, kind, detail){ try { await env.DB.prepare("INSERT INTO events(ts,kind,detail) VALUES(?,?,?)").bind(Date.now(), kind, String(detail).slice(0,500)).run(); } catch {} }

/* ---------------------------------------------------------------- Telegram (canal privé, authentifié par le jeton du bot) */
async function tg(env, method, body){
  if(env.TG_FAKE === "1"){ await logEvent(env, "tg_fake", method + " " + JSON.stringify(body).slice(0,300)); return { ok:true, result:{ message_id: 1 } }; }
  if(!env.TG_BOT_TOKEN) return { ok:false, description:"TG_BOT_TOKEN manquant" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch(e){ return { ok:false, description: String(e) }; }
}
const chatResto = env => getSetting(env, "tg_resto");
const chatAgency = env => getSetting(env, "tg_agency");

// ntfy : le nom des canaux est un secret Cloudflare (NTFY_TOPIC_RESTO / NTFY_TOPIC_AGENCY), jamais dans GitHub.
// Un canal ntfy reste techniquement public : on n'y envoie AUCUN détail de commande ni donnée client,
// seulement « une commande attend » + un lien vers le tableau de bord protégé.
// Pour remplacer un canal : changer le secret, puis s'abonner au nouveau nom dans l'appli ntfy.
async function ntfy(env, target, { title, message, priority = 5, tags = ["bell"] }){
  const topic = target === "resto" ? env.NTFY_TOPIC_RESTO : env.NTFY_TOPIC_AGENCY;
  if(!topic) return false;
  const until = +(await getSetting(env, "ntfy_pause_until") || 0);
  if(Date.now() < until) return false;                 // ntfy a demandé d'attendre : Telegram prend le relais
  const body = { topic, title, message, priority, tags };
  if(env.DASHBOARD_URL){ body.click = env.DASHBOARD_URL; body.actions = [{ action: "view", label: "Ouvrir le tableau de bord", url: env.DASHBOARD_URL, clear: true }]; }
  if(env.NTFY_FAKE === "1"){ await logEvent(env, "ntfy_fake", target + " " + JSON.stringify(body)); return true; }
  try {
    const headers = { "content-type": "application/json" };
    if(env.NTFY_TOKEN) headers.authorization = "Bearer " + env.NTFY_TOKEN;
    const r = await fetch((env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, ""), { method: "POST", headers, body: JSON.stringify(body) });
    if(r.ok) return true;
    if(r.status === 429){
      const ra = parseInt(r.headers.get("retry-after") || "", 10);
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : 300;   // par défaut 5 min
      await setSetting(env, "ntfy_pause_until", Date.now() + wait * 1000);
    }
    await logEvent(env, "ntfy_error", `${target} HTTP ${r.status}${r.status === 429 ? " (limite ntfy atteinte)" : ""}`);
  } catch(e){ await logEvent(env, "ntfy_error", `${target} ${e}`); }
  return false;
}
const restoConfigured = async env => !!env.NTFY_TOPIC_RESTO || !!(await chatResto(env));

// Web Push vers les appareils où l'app est installée (rôle resto ou agence). Renvoie le nombre d'appareils atteints.
async function pushTo(env, role, data){
  const { results } = await env.DB.prepare("SELECT * FROM push_subs WHERE role=?").bind(role).all();
  let n = 0;
  for(const s of results){
    const r = await sendPush(env, { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data);
    if(r.ok){ n++; await env.DB.prepare("UPDATE push_subs SET last_ok=?, fails=0 WHERE id=?").bind(Date.now(), s.id).run(); }
    else if(r.gone) await env.DB.prepare("DELETE FROM push_subs WHERE id=?").bind(s.id).run();
    else { await env.DB.prepare("UPDATE push_subs SET fails=fails+1 WHERE id=?").bind(s.id).run(); await logEvent(env, "push_error", `${role} HTTP ${r.status} ${r.error || ""}`); }
  }
  return n;
}
const pendingCount = async env => (await env.DB.prepare("SELECT COUNT(*) n FROM orders WHERE status='recue'").first()).n;

// Mode sécurisé : on n'accepte des commandes en ligne que si au moins un appareil du restaurant peut les recevoir
// Un appareil simplement abonné ne suffit pas : il doit avoir CONFIRMÉ la réception d'une notification (accusé envoyé par
// l'app) dans les 26 dernières heures — vérification chaque jour à l'ouverture — ou avoir le tableau de bord ouvert (< 3 min).
async function restoReachable(env){
  const subs = (await env.DB.prepare("SELECT COUNT(*) n FROM push_subs WHERE role='resto' AND fails=0 AND last_ack>?").bind(Date.now() - 26 * 3600000).first()).n;
  const seen = +(await getSetting(env, "seen_resto") || 0);
  return subs > 0 || Date.now() - seen < 3 * MIN;
}

// Aucune donnée personnelle dans la notification : numéro, service, heure, articles, total.
function orderMessage(o){
  const items = JSON.parse(o.items_json).map(l => `${l.qty} × ${l.name}`).join("\n");
  const head = o.preorder ? "🕒 PRÉCOMMANDE" : "🍔 NOUVELLE COMMANDE";
  return `${head} ${o.num}\n${o.mode} · ${o.slot_label}\n\n${items}\n\nSous-total : ${money(o.subtotal)} (taxes au comptoir)` +
         (o.note ? "\n📝 Note du client : voir le tableau de bord" : "") +
         `\n\nStatut : ${STATUS_FR[o.status]}${o.prep_min && !o.preorder ? ` · prête dans ${o.prep_min} min` : ""}`;
}
function keyboard(o){
  if((o.status === "recue" || o.status === "expiree") && o.preorder)
    return { inline_keyboard: [[{ text: `✅ Confirmer pour ${o.slot_label}`, callback_data: `a:${o.id}:20` }], [{ text: "❌ Refuser", callback_data: `r:${o.id}` }]] };
  if(o.status === "recue" || o.status === "expiree")
    return { inline_keyboard: [
      [15, 20, 30].map(m => ({ text: `✅ ${m} min`, callback_data: `a:${o.id}:${m}` })),
      [{ text: "❌ Refuser", callback_data: `r:${o.id}` }] ] };
  if(o.status === "acceptee") return { inline_keyboard: [[{ text: "🔔 Prête", callback_data: `p:${o.id}` }, { text: "✔️ Récupérée", callback_data: `c:${o.id}` }]] };
  if(o.status === "prete") return { inline_keyboard: [[{ text: "✔️ Récupérée", callback_data: `c:${o.id}` }, { text: "🚫 Client absent", callback_data: `n:${o.id}` }]] };
  return { inline_keyboard: [] };
}
async function notifyResto(env, o, { silent = false } = {}){
  const nItems = JSON.parse(o.items_json).reduce((t, l) => t + l.qty, 0);
  let ok = silent ? false : (await pushTo(env, "resto", { title: `${R.name} : ${o.preorder ? "nouvelle précommande" : "nouvelle commande"}`,
    body: `${o.num} · ${nItems} article${nItems > 1 ? "s" : ""} · ${money(o.subtotal)} — touchez pour répondre`, tag: "cmd-" + o.id, url: "/admin", pending: await pendingCount(env) })) > 0;
  ok = await ntfy(env, "resto", {
    title: `${R.name} : ${o.preorder ? "nouvelle précommande" : "nouvelle commande"}`,
    message: `${o.preorder ? "Une précommande attend votre confirmation." : "Une commande attend votre réponse."} Ouvrez le tableau de bord pour l'accepter ou la refuser.`,
    priority: silent ? 2 : 5, tags: ["hamburger"] }) || ok;
  const chat = await chatResto(env);
  if(chat){
    const r = await tg(env, "sendMessage", { chat_id: chat, text: orderMessage(o), reply_markup: keyboard(o), disable_notification: silent });
    if(r.ok){ await env.DB.prepare("UPDATE orders SET tg_msg_id=? WHERE id=?").bind(r.result.message_id, o.id).run(); ok = true; }
    else await logEvent(env, "tg_error", r.description);
  }
  if(ok) await env.DB.prepare("UPDATE orders SET notify_ok=1 WHERE id=?").bind(o.id).run();
  return ok;
}
async function remindResto(env, o){
  let ok = (await pushTo(env, "resto", { title: `${R.name} : RAPPEL`, body: `La commande ${o.num} attend votre réponse depuis ${R.escalation.remindRestoMin} minutes.`,
    tag: "cmd-" + o.id, url: "/admin", pending: await pendingCount(env) })) > 0;
  ok = await ntfy(env, "resto", { title: `${R.name} : RAPPEL`, message: `Une commande attend votre réponse depuis ${R.escalation.remindRestoMin} minutes. Ouvrez le tableau de bord.`, priority: 5, tags: ["warning"] }) || ok;
  const chat = await chatResto(env);
  if(chat) ok = (await tg(env, "sendMessage", { chat_id: chat, text: `⏰ RAPPEL : la commande ${o.num} attend votre réponse depuis ${R.escalation.remindRestoMin} min.`, reply_to_message_id: o.tg_msg_id || undefined })).ok || ok;
  return ok;
}
async function refreshRestoMessage(env, o){
  const chat = await chatResto(env);
  if(chat && o.tg_msg_id) await tg(env, "editMessageText", { chat_id: chat, message_id: o.tg_msg_id, text: orderMessage(o), reply_markup: keyboard(o) });
}
async function notifyAgency(env, text){
  let ok = (await pushTo(env, "agence", { title: `Azure Muse : alerte ${R.name}`, body: text, tag: "alerte", url: "/admin" })) > 0;
  ok = await ntfy(env, "agency", { title: `Azure Muse : alerte ${R.name}`, message: text, priority: 4, tags: ["rotating_light"] }) || ok;
  const chat = await chatAgency(env);
  if(chat) ok = (await tg(env, "sendMessage", { chat_id: chat, text })).ok || ok;   // canal de secours indépendant de ntfy
  return ok;
}

/* ---------------------------------------------------------------- Meta Conversions API (seulement avec consentement) */
async function metaEvent(env, o, eventName, eventId, sourceUrl){
  if(!o.consent || !env.META_PIXEL_ID || !env.META_CAPI_TOKEN) return;
  const user_data = {};
  if(o.phone) user_data.ph = [await sha256hex("1" + o.phone)];
  if(o.name) user_data.fn = [await sha256hex(o.name.split(/\s+/)[0].toLowerCase())];
  if(o.fbp) user_data.fbp = o.fbp;
  if(o.fbc) user_data.fbc = o.fbc;
  if(o.user_agent) user_data.client_user_agent = o.user_agent;
  const body = { data: [{ event_name: eventName, event_time: Math.floor(Date.now()/1000), event_id: eventId, action_source: "website",
    event_source_url: sourceUrl || R.origins[0], user_data,
    custom_data: { currency: "CAD", value: o.subtotal, order_id: o.num, content_type: "product" } }] };
  if(env.META_TEST_CODE) body.test_event_code = env.META_TEST_CODE;
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${env.META_PIXEL_ID}/events?access_token=${env.META_CAPI_TOKEN}`,
      { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
    if(!r.ok) await logEvent(env, "meta_error", await r.text());
  } catch(e){ await logEvent(env, "meta_error", String(e)); }
}

/* ---------------------------------------------------------------- changements de statut (communs tableau de bord + Telegram) */
const TRANSITIONS = {
  accept: { from: ["recue","expiree"], to: "acceptee" },
  refuse: { from: ["recue","expiree","acceptee"], to: "refusee" },
  ready:  { from: ["acceptee"], to: "prete" },
  picked: { from: ["acceptee","prete"], to: "recuperee" },
  noshow: { from: ["acceptee","prete"], to: "absente" },
};
const REFUSE_FR = { rupture: "Un produit de votre commande n'est plus disponible.", complet: "Le restaurant a trop de commandes en ce moment.",
                    ferme: "Le restaurant ne peut pas préparer votre commande à cette heure-là." };

async function applyAction(env, ctx, id, action, opts = {}){
  const t = TRANSITIONS[action]; if(!t) return { error: "Action inconnue." };
  const o = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first();
  if(!o) return { error: "Commande introuvable." };
  if(!t.from.includes(o.status)) return { error: `Impossible : la commande est déjà « ${STATUS_FR[o.status]} ».`, order: o };
  const now = Date.now();
  let sql, args;
  if(action === "accept"){
    const prep = R.prepChoices.includes(+opts.prepMin) || [15,20,30].includes(+opts.prepMin) ? +opts.prepMin : 20;
    sql = "UPDATE orders SET status='acceptee', prep_min=?, accepted_at=? WHERE id=? AND status=?"; args = [prep, now, id, o.status];
  } else if(action === "refuse"){
    const reason = REFUSE_FR[opts.reason] || clean(opts.reasonText, 160) || REFUSE_FR.complet;
    sql = "UPDATE orders SET status='refusee', refuse_reason=?, closed_at=? WHERE id=? AND status=?"; args = [reason, now, id, o.status];
  } else if(action === "ready"){
    sql = "UPDATE orders SET status='prete', ready_at=? WHERE id=? AND status=?"; args = [now, id, o.status];
  } else {
    const paid = Number(opts.paid); const paidOk = Number.isFinite(paid) && paid > 0 && paid < 2000 ? Math.round(paid*100)/100 : null;
    sql = `UPDATE orders SET status='${t.to}', closed_at=?, paid_amount=COALESCE(?, paid_amount) WHERE id=? AND status=?`; args = [now, action === "picked" ? paidOk : null, id, o.status];
  }
  const res = await env.DB.prepare(sql).bind(...args).run();
  if(!res.meta.changes) return { error: "La commande vient d'être modifiée ailleurs. Rafraîchissez." };
  const updated = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first();
  ctx.waitUntil(refreshRestoMessage(env, updated));
  if(action === "accept") ctx.waitUntil(metaEvent(env, updated, "Purchase", "purchase-" + updated.num));
  return { order: updated };
}

/* ---------------------------------------------------------------- session du tableau de bord */
async function verifyPassword(password, stored){
  // format : pbkdf2$<itérations>$<sel b64url>$<hash b64url>   (créé par tools/hash-password.mjs)
  if(!stored) return false;
  const [kind, iter, salt, hash] = stored.split("$");
  if(kind !== "pbkdf2") return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name:"PBKDF2", hash:"SHA-256", salt: fromB64(salt), iterations: +iter }, key, 256);
  return safeEq(b64u(bits), hash);
}
async function makeSession(env, role){
  const exp = Date.now() + 30 * DAY;
  return `${role}.${exp}.${await hmac(env.SESSION_SECRET, role + "." + exp)}`;
}
async function readSession(env, req){
  const m = /(?:^|;\s*)ag_s=([^;]+)/.exec(req.headers.get("cookie") || "");
  const tok = m ? m[1] : (req.headers.get("x-ag-session") || "");
  if(!tok || !env.SESSION_SECRET) return null;
  const [role, exp, sig] = tok.split(".");
  if(!role || !exp || !sig || +exp < Date.now()) return null;
  return safeEq(sig, await hmac(env.SESSION_SECRET, role + "." + exp)) ? role : null;
}
const sessionCookie = (v, maxAge) => `ag_s=${v}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

/* ---------------------------------------------------------------- routes publiques */
function corsHeaders(env, req){
  const o = req.headers.get("origin");
  const allowed = R.origins.includes(o) || (env.ENV === "dev" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o || ""));
  return allowed ? { "access-control-allow-origin": o, "access-control-allow-methods": "GET,POST,OPTIONS",
                     "access-control-allow-headers": "content-type", "vary": "origin" } : {};
}
async function ipHash(env, req){ return (await sha256hex((req.headers.get("cf-connecting-ip") || "local") + (env.HASH_SALT || ""))).slice(0, 32); }

async function verifyTurnstile(env, token, ip){
  if(env.ENV === "dev" && env.TURNSTILE_SECRET === "DEV_BYPASS") return true;
  if(!token || !env.TURNSTILE_SECRET) return false;
  const f = new FormData(); f.append("secret", env.TURNSTILE_SECRET); f.append("response", token); if(ip) f.append("remoteip", ip);
  try {
    const r = await (await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method:"POST", body:f })).json();
    return r.success === true;
  } catch { return false; }
}

async function createOrder(env, ctx, req){
  if(await getSetting(env, "paused") === "1") return fail("paused", `Le restaurant ne prend pas de commande en ligne pour le moment. Appelez le ${R.tel}.`, 503);
  if(!(await restoReachable(env))) return fail("unreachable", `Le restaurant ne peut pas recevoir de commande en ligne pour le moment. Appelez le ${R.tel}.`, 503);
  let b; try { b = await req.json(); } catch { return fail("bad_json", "Requête invalide."); }
  const now = Date.now(), ip = req.headers.get("cf-connecting-ip");

  if(!await verifyTurnstile(env, b.turnstile, ip)) return fail("captcha", "La vérification anti-robot a échoué. Réessayez.", 403);

  const idem = clean(b.idem, 64);
  if(idem.length < 16) return fail("bad_idem", "Requête invalide.");
  const dup = await env.DB.prepare("SELECT num, token, status FROM orders WHERE idem=?").bind(idem).first();
  if(dup) return json({ ok:true, duplicate:true, num: dup.num, token: dup.token, status: dup.status });

  const mode = ["Sur place", "À emporter"].includes(b.mode) ? b.mode : null;
  if(!mode) return fail("mode", "Choisissez sur place ou à emporter.");
  const name = clean(b.name, 60); if(name.length < 2) return fail("name", "Entrez votre nom.");
  let phone = String(b.phone || "").replace(/\D/g, ""); if(phone.length === 11 && phone[0] === "1") phone = phone.slice(1);
  if(!/^[2-9]\d{2}[2-9]\d{6}$/.test(phone)) return fail("phone", "Entrez un numéro de téléphone valide à 10 chiffres.");
  const note = clean(b.note, 300);

  const slot = checkSlot(b.slot, now); if(slot.error) return fail("slot", slot.error);
  const cart = priceCart(b.items, slot.slotMs); if(cart.error) return fail(cart.code || "cart", cart.error);

  // Anti-abus
  const L = R.limits, ih = await ipHash(env, req), device = clean(b.device, 40) || null;
  if(await env.DB.prepare("SELECT 1 FROM blocked_phones WHERE phone=?").bind(phone).first())
    return fail("blocked", `Pour commander, appelez le restaurant au ${R.tel}.`, 403);
  const [byPhone, pending, byDevice, byIp] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) n FROM orders WHERE phone=? AND created_at>?").bind(phone, now - DAY),
    env.DB.prepare("SELECT COUNT(*) n FROM orders WHERE phone=? AND status IN ('recue','acceptee','prete')").bind(phone),
    env.DB.prepare("SELECT COUNT(*) n FROM orders WHERE device_id=? AND created_at>?").bind(device, now - DAY),
    env.DB.prepare("SELECT COUNT(*) n FROM orders WHERE ip_hash=? AND created_at>?").bind(ih, now - 60 * MIN),
  ]);
  if(byPhone.results[0].n >= L.phonePerDay || pending.results[0].n >= L.phonePending ||
     (device && byDevice.results[0].n >= L.devicePerDay) || byIp.results[0].n >= L.ipPerHour){
    await logEvent(env, "rate_limited", `${phone.slice(-4)} ${ih.slice(0,6)}`);
    return fail("limit", `Vous avez déjà des commandes en cours. Pour en ajouter, appelez le restaurant au ${R.tel}.`, 429);
  }

  const utm = b.utm && typeof b.utm === "object" ? b.utm : {};
  const u = k => clean(utm[k], 120) || null;
  const consent = b.consent === true ? 1 : 0;
  const notifyFrom = isOpenAt(now) ? now : nextOpening(now);
  const token = rand(18);
  let row;
  for(let attempt = 0; attempt < 5 && !row; attempt++){
    const num = "A-" + String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000));
    try {
      row = await env.DB.prepare(`INSERT INTO orders (num, token, idem, created_at, notify_from, slot, slot_label, preorder, mode, name, phone, note,
          items_json, subtotal, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid, fbp, fbc, user_agent, consent, ip_hash, device_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`).bind(
          num, token, idem, now, notifyFrom, b.slot, slot.label, slot.preorder ? 1 : 0, mode, name, phone, note || null,
          JSON.stringify(cart.lines), cart.total, u("utm_source"), u("utm_medium"), u("utm_campaign"), u("utm_content"), u("utm_term"),
          u("fbclid"), u("gclid"), consent ? clean(b.fbp, 120) || null : null, consent ? clean(b.fbc, 200) || null : null,
          consent ? clean(req.headers.get("user-agent"), 300) : null, consent, ih, device).first();
    } catch(e){
      if(!String(e).includes("UNIQUE")) throw e;
      const again = await env.DB.prepare("SELECT num, token, status FROM orders WHERE idem=?").bind(idem).first();
      if(again) return json({ ok:true, duplicate:true, num: again.num, token: again.token, status: again.status });
    }
  }
  if(!row) return fail("server", `Erreur, réessayez ou appelez le ${R.tel}.`, 500);

  // Notification : sonore si le resto est ouvert, silencieuse la nuit (l'alerte sonore partira à l'ouverture).
  const loud = notifyFrom <= now;
  const sent = await notifyResto(env, row, { silent: !loud });
  if(sent && loud) await env.DB.prepare("UPDATE orders SET alert_level=1 WHERE id=?").bind(row.id).run();
  ctx.waitUntil(metaEvent(env, row, "Lead", "lead-" + row.num, clean(b.page, 300)));
  return json({ ok:true, num: row.num, token, preorder: !!row.preorder, slotLabel: row.slot_label, subtotal: row.subtotal, notified: sent });
}

async function trackOrder(env, token){
  const o = await env.DB.prepare("SELECT num, status, slot_label, mode, prep_min, accepted_at, refuse_reason, items_json, subtotal, preorder FROM orders WHERE token=?").bind(token).first();
  if(!o) return fail("not_found", "Commande introuvable.", 404);
  return json({ ok:true, num:o.num, status:o.status, statusLabel: STATUS_FR[o.status], slotLabel:o.slot_label, mode:o.mode,
    readyAt: o.accepted_at && o.prep_min && !o.preorder ? o.accepted_at + o.prep_min * MIN : null,
    refuseReason:o.refuse_reason, items: JSON.parse(o.items_json), subtotal:o.subtotal, tel: R.tel });
}

/* ---------------------------------------------------------------- routes restaurant */
async function adminRoutes(env, ctx, req, url){
  const p = url.pathname;
  if(p === "/api/admin/login" && req.method === "POST"){
    const ih = await ipHash(env, req), now = Date.now();
    const c = await env.DB.prepare("SELECT COUNT(*) n FROM login_attempts WHERE ip_hash=? AND ts>?").bind(ih, now - 15 * MIN).first();
    if(c.n >= 5) return fail("locked", "Trop d'essais. Réessayez dans 15 minutes.", 429);
    let b; try { b = await req.json(); } catch { b = {}; }
    const pw = String(b.password || "").slice(0, 200);
    const role = await verifyPassword(pw, env.ADMIN_PASSWORD_HASH) ? "resto" : await verifyPassword(pw, env.AGENCY_PASSWORD_HASH) ? "agence" : null;
    if(!role){ await env.DB.prepare("INSERT INTO login_attempts VALUES(?,?)").bind(ih, now).run(); return fail("bad_password", "Mot de passe incorrect.", 401); }
    const session = await makeSession(env, role);
    return json({ ok:true, role, session }, 200, { "set-cookie": sessionCookie(session, 30 * 86400) });
  }
  if(p === "/api/admin/logout") return json({ ok:true }, 200, { "set-cookie": sessionCookie("", 0) });

  // Accusé de réception envoyé par l'app (service worker) : authentifié par l'adresse d'abonnement elle-même,
  // secrète et propre à l'appareil — fonctionne même si le téléphone a perdu son cookie de session.
  if(p === "/api/admin/push-ack" && req.method === "POST"){
    let b; try { b = await req.json(); } catch { b = {}; }
    const ep = String(b.endpoint || "");
    if(ep.length > 40) await env.DB.prepare("UPDATE push_subs SET last_ack=?, fails=0 WHERE endpoint=?").bind(Date.now(), ep).run();
    return json({ ok: true });
  }
  const role = await readSession(env, req);
  if(!role) return fail("auth", "Session expirée. Reconnectez-vous.", 401);
  if(req.method === "POST"){                        // protection CSRF : même origine obligatoire
    const o = req.headers.get("origin");
    if(o && o !== url.origin) return fail("origin", "Origine refusée.", 403);
  }

  if(p === "/api/admin/orders" && req.method === "GET"){
    const seenKey = "seen_" + role, lastSeen = +(await getSetting(env, seenKey) || 0);
    if(Date.now() - lastSeen > 60000) await setSetting(env, seenKey, Date.now());
    const scope = url.searchParams.get("scope") || "active";
    const now = Date.now();
    const q = scope === "active"
      ? env.DB.prepare("SELECT * FROM orders WHERE status IN ('recue','acceptee','prete','expiree') OR (closed_at>?) ORDER BY created_at DESC LIMIT 200").bind(now - 3 * 3600000)
      : env.DB.prepare("SELECT * FROM orders WHERE created_at>? ORDER BY created_at DESC LIMIT 500").bind(now - Math.min(+url.searchParams.get("days") || 7, 90) * DAY);
    const { results } = await q.all();
    for(const o of results) if(o.phone){
      const a = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM orders WHERE phone=? AND status='absente') n, EXISTS(SELECT 1 FROM blocked_phones WHERE phone=?) b").bind(o.phone, o.phone).first();
      o.absences = a.n; o.blocked = !!a.b;
    }
    return json({ ok:true, role, paused: await getSetting(env, "paused") === "1", now,
      reachable: await restoReachable(env),
      devices: Object.fromEntries((await env.DB.prepare("SELECT role, COUNT(*) n FROM push_subs WHERE fails=0 AND last_ack>? GROUP BY role").bind(Date.now() - 26 * 3600000).all()).results.map(r => [r.role, r.n])),
      subscribed: Object.fromEntries((await env.DB.prepare("SELECT role, COUNT(*) n FROM push_subs GROUP BY role").all()).results.map(r => [r.role, r.n])),
      notif: { resto: await restoConfigured(env), agency: !!env.NTFY_TOPIC_AGENCY || !!(await chatAgency(env)),
               lastError: (await env.DB.prepare("SELECT ts, detail FROM events WHERE kind IN ('ntfy_error','tg_error') AND ts>? ORDER BY ts DESC LIMIT 1").bind(now - DAY).first()) || null },
      orders: results.map(o => ({ ...o, items: JSON.parse(o.items_json), items_json: undefined, ip_hash: undefined, device_id: undefined, user_agent: undefined, fbp: undefined, fbc: undefined, token: undefined, idem: undefined })) });
  }
  const m = /^\/api\/admin\/orders\/(\d+)\/(accept|refuse|ready|picked|noshow)$/.exec(p);
  if(m && req.method === "POST"){
    let b; try { b = await req.json(); } catch { b = {}; }
    const r = await applyAction(env, ctx, +m[1], m[2], b);
    return r.error ? fail("action", r.error, 409) : json({ ok:true, status: r.order.status });
  }
  // Blocage d'un numéro : décidé à la main par le restaurant (jamais automatique).
  const bl = /^\/api\/admin\/orders\/(\d+)\/(block|unblock)$/.exec(p);
  if(bl && req.method === "POST"){
    const o = await env.DB.prepare("SELECT phone FROM orders WHERE id=?").bind(+bl[1]).first();
    if(!o?.phone) return fail("action", "Numéro introuvable.", 404);
    if(bl[2] === "block") await env.DB.prepare("INSERT OR IGNORE INTO blocked_phones(phone,reason,created_at) VALUES(?,?,?)").bind(o.phone, `bloqué par ${role}`, Date.now()).run();
    else await env.DB.prepare("DELETE FROM blocked_phones WHERE phone=?").bind(o.phone).run();
    await logEvent(env, bl[2], `${role} …${o.phone.slice(-4)}`);
    return json({ ok:true });
  }
  if(p === "/api/admin/pause" && req.method === "POST"){
    let b; try { b = await req.json(); } catch { b = {}; }
    await setSetting(env, "paused", b.paused ? "1" : "0");
    await logEvent(env, "pause", `${role} ${b.paused ? "pause" : "reprise"}`);
    if(b.paused) ctx.waitUntil(notifyAgency(env, `⏸️ ${R.name} a mis la commande en ligne en pause.`));
    return json({ ok:true, paused: !!b.paused });
  }
  if(p === "/api/admin/stats" && req.method === "GET"){
    const days = Math.min(+url.searchParams.get("days") || 30, 90), since = Date.now() - days * DAY;
    const by = await env.DB.prepare(`SELECT COALESCE(utm_source,'direct') source, status, COUNT(*) n, SUM(subtotal) sub, SUM(paid_amount) paid
      FROM orders WHERE created_at>? GROUP BY source, status`).bind(since).all();
    return json({ ok:true, days, rows: by.results });
  }
  if(p === "/api/admin/push-key" && req.method === "GET") return json({ ok: !!env.VAPID_PUBLIC, key: env.VAPID_PUBLIC || null });
  if(p === "/api/admin/push-subscribe" && req.method === "POST"){
    let b; try { b = await req.json(); } catch { b = {}; }
    const s = b.subscription || {};
    if(!/^https:\/\//.test(s.endpoint || "") || !s.keys?.p256dh || !s.keys?.auth) return fail("sub", "Abonnement invalide.");
    await env.DB.prepare(`INSERT INTO push_subs(role, endpoint, p256dh, auth, label, created_at, fails) VALUES(?,?,?,?,?,?,0)
      ON CONFLICT(endpoint) DO UPDATE SET role=excluded.role, p256dh=excluded.p256dh, auth=excluded.auth, label=excluded.label, fails=0`)
      .bind(role, s.endpoint, s.keys.p256dh, s.keys.auth, clean(b.label, 80), Date.now()).run();
    await logEvent(env, "push_subscribe", `${role} ${clean(b.label, 80)}`);
    // Notification de confirmation : l'appareil ne devient opérationnel qu'après l'avoir réellement reçue (accusé).
    ctx.waitUntil(sendPush(env, s, { title: `${R.name} : notifications activées`, body: "Cet appareil recevra les nouvelles commandes.", tag: "check", url: "/admin" }));
    return json({ ok: true });
  }
  if(p === "/api/admin/push-unsubscribe" && req.method === "POST"){
    let b; try { b = await req.json(); } catch { b = {}; }
    await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(String(b.endpoint || "")).run();
    return json({ ok: true });
  }
  if(p === "/api/admin/telegram-setup" && req.method === "POST"){
    if(role !== "agence") return fail("role", "Réservé à Azure Muse.", 403);
    if(!env.TG_BOT_TOKEN || !env.TG_WEBHOOK_SECRET) return fail("tg", "Secrets Telegram manquants dans Cloudflare.");
    const me = await tg(env, "getMe", {});
    const hook = await tg(env, "setWebhook", { url: url.origin + "/api/tg", secret_token: env.TG_WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
    return json({ ok: !!(me.ok && hook.ok), bot: me.result?.username || null, webhook: hook.ok, error: me.description || hook.description || null,
                  linked: { resto: !!(await chatResto(env)), agency: !!(await chatAgency(env)) } });
  }
  if(p === "/api/admin/test-notification" && req.method === "POST"){
    let b; try { b = await req.json(); } catch { b = {}; }
    const target = b.target === "agency" ? "agency" : "resto";
    const text = "Test de notification. Si vous l'entendez téléphone verrouillé, tout fonctionne.";
    const viaPush = await pushTo(env, target === "agency" ? "agence" : "resto", { title: `${R.name} : test`, body: text, tag: "test", url: "/admin" });
    const viaNtfy = await ntfy(env, target, { title: `${R.name} : test`, message: text, priority: 5 });
    const chat = target === "agency" ? await chatAgency(env) : await chatResto(env);
    const viaTg = chat ? (await tg(env, "sendMessage", { chat_id: chat, text: "🔔 " + text })).ok : null;
    return (viaPush || viaNtfy || viaTg) ? json({ ok:true, push: viaPush, ntfy: viaNtfy, telegram: viaTg }) : fail("notif", "Échec sur tous les canaux (voir le journal).", 502);
  }
  return fail("not_found", "Introuvable.", 404);
}

/* ---------------------------------------------------------------- webhook Telegram */
async function telegramWebhook(env, ctx, req){
  const secret = req.headers.get("x-telegram-bot-api-secret-token") || "";
  if(!env.TG_WEBHOOK_SECRET || !safeEq(secret, env.TG_WEBHOOK_SECRET)) return new Response("forbidden", { status: 403 });
  const u = await req.json().catch(() => ({}));
  const resto = await chatResto(env), agency = await chatAgency(env);

  if(u.message?.text?.startsWith("/start")){
    const code = u.message.text.split(/\s+/)[1] || "", chat = String(u.message.chat.id), from = String(u.message.from?.id || "");
    const addUser = async () => { const l = JSON.parse(await getSetting(env, "tg_users") || "[]"); if(from && !l.includes(from)){ l.push(from); await setSetting(env, "tg_users", JSON.stringify(l)); } };
    if(env.TG_LINK_RESTO && safeEq(code, env.TG_LINK_RESTO)){ await setSetting(env, "tg_resto", chat); await addUser();
      await tg(env, "sendMessage", { chat_id: chat, text: `✅ Ce téléphone recevra les commandes en ligne de ${R.name}.\nGardez la sonnerie activée et les notifications Telegram autorisées.` }); }
    else if(env.TG_LINK_AGENCY && safeEq(code, env.TG_LINK_AGENCY)){ await setSetting(env, "tg_agency", chat); await addUser();
      await tg(env, "sendMessage", { chat_id: chat, text: `✅ Azure Muse recevra les alertes de ${R.name} (commandes non confirmées, pannes).` }); }
    return new Response("ok");
  }
  const cq = u.callback_query;
  if(cq){
    const chat = String(cq.message?.chat?.id || "");
    const users = JSON.parse(await getSetting(env, "tg_users") || "[]");
    if((chat !== resto && chat !== agency) || !users.includes(String(cq.from?.id || ""))){ await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Non autorisé." }); return new Response("ok"); }
    const [k, id, extra] = String(cq.data || "").split(":");
    if(k === "r"){   // choix du motif de refus
      await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [
        [{ text: "Produit en rupture", callback_data: `x:${id}:rupture` }], [{ text: "Trop de commandes", callback_data: `x:${id}:complet` }],
        [{ text: "Fermé / autre", callback_data: `x:${id}:ferme` }], [{ text: "↩️ Annuler", callback_data: `u:${id}` }] ] } });
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id }); return new Response("ok");
    }
    if(k === "u"){ const o = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(+id).first(); if(o) await refreshRestoMessage(env, o);
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id }); return new Response("ok"); }
    const action = { a:"accept", x:"refuse", p:"ready", c:"picked", n:"noshow" }[k];
    const r = action ? await applyAction(env, ctx, +id, action, { prepMin: extra, reason: extra }) : { error: "?" };
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: r.error || `Commande ${r.order.num} : ${STATUS_FR[r.order.status]}` });
  }
  return new Response("ok");
}

/* ---------------------------------------------------------------- tâches planifiées */
async function cron(env){
  const now = Date.now(), E = R.escalation;
  const { results } = await env.DB.prepare("SELECT * FROM orders WHERE status='recue' AND notify_from<=? ORDER BY created_at LIMIT 50").bind(now).all();
  for(const o of results){
    const age = now - o.notify_from;
    if(o.alert_level === 0){                                     // notification ratée ou envoyée en silence la nuit
      if(await notifyResto(env, o)) await env.DB.prepare("UPDATE orders SET alert_level=1 WHERE id=?").bind(o.id).run();
      else if(age >= E.alertAgencyMin * MIN && !(await getSetting(env, "agency_warned_" + o.id)) &&
              await notifyAgency(env, `${R.name} : la notification de la commande ${o.num} n'a pas pu être envoyée au restaurant. Appelez le resto : ${R.tel}.`))
        await setSetting(env, "agency_warned_" + o.id, "1");
    } else {
      let lvl = o.alert_level;
      if(lvl === 1 && age >= E.remindRestoMin * MIN && await remindResto(env, o)){
        lvl = 2; await env.DB.prepare("UPDATE orders SET alert_level=2 WHERE id=?").bind(o.id).run();
      }
      if((lvl === 1 || lvl === 2) && age >= E.alertAgencyMin * MIN &&
         await notifyAgency(env, `${R.name} : la commande ${o.num} n'est pas confirmée depuis ${Math.round(age / MIN)} min. Appelez le resto : ${R.tel}.`)){
        await env.DB.prepare("UPDATE orders SET alert_level=3 WHERE id=?").bind(o.id).run();
      }
    }
    if(o.alert_level >= 1 && age >= E.expireMin * MIN){
      await env.DB.prepare("UPDATE orders SET status='expiree' WHERE id=? AND status='recue'").bind(o.id).run();
      const upd = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(o.id).first();
      await refreshRestoMessage(env, upd);
    }
  }
  // Vérification quotidienne à l'ouverture : chaque appareil du resto doit confirmer qu'il reçoit (accusé de réception).
  if(isOpenAt(now) && await getSetting(env, "daily_check") !== mtl(now).date){
    await setSetting(env, "daily_check", mtl(now).date);
    await pushTo(env, "resto", { title: `${R.name} : prêt pour aujourd'hui`, body: "Vérification automatique : cet appareil reçoit bien les commandes.", tag: "check", url: "/admin" });
  }
  // Mode sécurisé : les commandes sont suspendues automatiquement (restoReachable) ; Azure Muse est prévenue une fois par jour.
  if(isOpenAt(now) && await getSetting(env, "paused") !== "1" && !(await restoReachable(env))){
    const d = mtl(now).date;
    if(await getSetting(env, "unreach_alert") !== d &&
       await notifyAgency(env, `${R.name} : aucun appareil du restaurant ne peut recevoir les commandes. Commandes en ligne suspendues automatiquement (la page affiche « Appeler »).`))
      await setSetting(env, "unreach_alert", d);
  }
  // Purge Loi 25 : une fois par jour.
  const today = mtl(now).date;
  if(await getSetting(env, "last_purge") !== today){
    const cutoff = now - R.retentionDays * DAY;
    await env.DB.batch([
      env.DB.prepare(`UPDATE orders SET name=NULL, phone=NULL, note=NULL, ip_hash=NULL, device_id=NULL, fbp=NULL, fbc=NULL, fbclid=NULL, gclid=NULL,
        user_agent=NULL, anonymized=1 WHERE created_at<? AND anonymized=0`).bind(cutoff),
      env.DB.prepare("DELETE FROM blocked_phones WHERE created_at<?").bind(now - 2 * R.retentionDays * DAY),
      env.DB.prepare("DELETE FROM login_attempts WHERE ts<?").bind(now - DAY),
      env.DB.prepare("DELETE FROM events WHERE ts<?").bind(now - R.retentionDays * DAY),
    ]);
    await setSetting(env, "last_purge", today);
  }
}

/* ---------------------------------------------------------------- aiguillage */
const SEC_HEADERS = { "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" };

export default {
  async fetch(req, env, ctx){
    const url = new URL(req.url), p = url.pathname;
    try {
      if(p === "/manifest.webmanifest") return new Response(MANIFEST, { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" } });
      if(p === "/sw.js") return new Response(SW, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/" } });
      const icon = { "/icon-192.png": 192, "/icon-512.png": 512, "/apple-touch-icon.png": 180 }[p];
      if(icon) return new Response(Uint8Array.from(atob(ICONS[icon]), c => c.charCodeAt(0)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
      if(p === "/" || p === "/admin") return new Response(ADMIN_HTML, { headers: { "content-type":"text/html; charset=utf-8", "cache-control":"no-store", ...SEC_HEADERS } });
      if(p === "/api/tg" && req.method === "POST") return await telegramWebhook(env, ctx, req);
      if(p.startsWith("/api/admin/")) return await adminRoutes(env, ctx, req, url);

      const cors = corsHeaders(env, req);
      if(req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      let res;
      if(p === "/api/orders" && req.method === "POST"){
        if(!cors["access-control-allow-origin"]) return fail("origin", "Origine refusée.", 403);
        res = await createOrder(env, ctx, req);
      } else if(p.startsWith("/api/track/") && req.method === "GET") res = await trackOrder(env, p.slice(11));
      else if(p === "/api/status" && req.method === "GET"){
        const paused = await getSetting(env, "paused") === "1";
        res = json({ ok:true, accepting: !paused && await restoReachable(env), paused, openNow: isOpenAt(Date.now()) });
      } else res = fail("not_found", "Introuvable.", 404);
      for(const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch(e){
      await logEvent(env, "error", `${p} ${e?.stack || e}`);
      return fail("server", `Erreur du serveur. Appelez le restaurant au ${R.tel}.`, 500);
    }
  },
  async scheduled(event, env, ctx){ ctx.waitUntil(cron(env)); },
};

// Exportés pour les tests.
export const _test = { checkSlot, priceCart, mtl, mtlToMs, isOpenAt, nextOpening };
