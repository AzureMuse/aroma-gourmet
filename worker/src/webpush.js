// Web Push standard (iPhone iOS 16.4+, Android, ordinateurs) sans dépendance ni service payant.
// - Authentification VAPID (RFC 8292) : jeton ES256 signé avec la clé privée stockée dans Cloudflare.
// - Chiffrement du contenu (RFC 8291, aes128gcm) : seul l'appareil abonné peut lire la notification.
const enc = new TextEncoder();
export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for(const a of arrs){ out.set(a, o); o += a.length; } return out; };

async function hkdf(salt, ikm, info, len){
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

// Chiffre `payload` (texte) pour un abonnement { keys: { p256dh, auth } }.
export async function encryptPayload(sub, payload, saltOverride, serverKeysOverride){
  const uaPublic = fromB64u(sub.keys.p256dh), authSecret = fromB64u(sub.keys.auth);
  const server = serverKeysOverride || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", server.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, server.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = saltOverride || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concat(enc.encode(payload), new Uint8Array([2]));            // 0x02 = dernier bloc
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const rs = new Uint8Array([0, 0, 0x10, 0]);                                 // taille de bloc 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// En-tête Authorization VAPID pour le service de notification (Apple, Google, Mozilla…).
export async function vapidAuth(endpoint, subject, publicKeyB64u, privateJwk){
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${publicKeyB64u}`;
}

// Envoie une notification. Renvoie { ok, status, gone } — gone = abonnement à supprimer (appareil désabonné).
export async function sendPush(env, sub, data, { ttl = 900, urgency = "high" } = {}){
  if(!env.VAPID_PUBLIC || !env.VAPID_PRIVATE_JWK) return { ok: false, status: 0 };
  try {
    const body = await encryptPayload(sub, JSON.stringify(data));
    const r = await fetch(sub.endpoint, { method: "POST", body, headers: {
      "content-type": "application/octet-stream", "content-encoding": "aes128gcm", ttl: String(ttl), urgency,
      authorization: await vapidAuth(sub.endpoint, env.VAPID_SUBJECT || "mailto:admin@azuremuse.ca", env.VAPID_PUBLIC, JSON.parse(env.VAPID_PRIVATE_JWK)) } });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
  } catch(e){ return { ok: false, status: 0, error: String(e) }; }
}
