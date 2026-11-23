// Relais de commandes Aroma Gourmet — Cloudflare Worker
// La page de commande envoie la commande ici ; le relais la vérifie
// puis la transmet aux canaux ntfy du restaurant.
// Les noms des canaux ne sont jamais dans la page publique :
// ils sont dans le secret TOPICS du Worker (séparés par des virgules).

const ALLOWED_ORIGINS = [
  "https://azuremuse.github.io",
  "https://commander.aromagourmet.ca",
];

// Limite anti-abus : 4 commandes par adresse IP toutes les 10 minutes.
const LIMIT = 4;
const WINDOW_MS = 10 * 60 * 1000;
const hits = new Map();

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function reply(status, data, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > LIMIT;
}

// Une vraie commande de la page a toujours cette forme.
function valid(o) {
  if (!o || typeof o.title !== "string" || typeof o.body !== "string") return false;
  if (o.title.length > 160 || o.body.length > 4000) return false;
  if (!/^Commande AG\d{8} - /.test(o.title)) return false;
  if (!o.body.startsWith("NOUVELLE COMMANDE  AG")) return false;
  const tel = (o.body.match(/^Tel : (.+)$/m) || [])[1] || "";
  const digits = tel.replace(/\D/g, "");
  if (!(digits.length === 10 || (digits.length === 11 && digits[0] === "1"))) return false;
  if (!/^Nom : .{2,}$/m.test(o.body)) return false;
  return true;
}

// Les en-têtes HTTP n'acceptent pas les accents.
function ascii(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E]/g, "");
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const okOrigin = ALLOWED_ORIGINS.includes(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: okOrigin ? 204 : 403, headers: okOrigin ? cors(origin) : {} });
    }
    if (request.method !== "POST" || !okOrigin) {
      return new Response("Non autorisé", { status: 403 });
    }

    const ip = request.headers.get("CF-Connecting-IP") || "inconnue";
    if (tooMany(ip)) return reply(429, { ok: false, error: "trop de commandes" }, origin);

    let o;
    try { o = await request.json(); } catch { return reply(400, { ok: false }, origin); }
    if (!valid(o)) return reply(400, { ok: false, error: "commande invalide" }, origin);

    const topics = String(env.TOPICS || "").split(",").map((t) => t.trim()).filter(Boolean);
    if (!topics.length) return reply(500, { ok: false, error: "relais non configuré" }, origin);

    const results = await Promise.allSettled(
      topics.map((t) =>
        fetch("https://ntfy.sh/" + t, {
          method: "POST",
          headers: { Title: ascii(o.title), Priority: "urgent", Tags: "hamburger" },
          body: o.body,
        }).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); })
      )
    );
    const ok = results.some((r) => r.status === "fulfilled");
    return reply(ok ? 200 : 502, { ok }, origin);
  },
};
