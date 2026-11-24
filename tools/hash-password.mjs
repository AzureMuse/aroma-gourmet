// Crée l'empreinte d'un mot de passe pour le tableau de bord (jamais le mot de passe en clair).
// Usage : node tools/hash-password.mjs "mot de passe"  -> coller le résultat dans
//   npx wrangler secret put ADMIN_PASSWORD_HASH
import { webcrypto as c } from "node:crypto";
const pw = process.argv[2]; if(!pw || pw.length < 10) { console.error("Mot de passe de 10 caractères minimum."); process.exit(1); }
const b64u = b => Buffer.from(b).toString("base64url");
const salt = c.getRandomValues(new Uint8Array(16)), it = 100000;
const key = await c.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
const bits = await c.subtle.deriveBits({ name:"PBKDF2", hash:"SHA-256", salt, iterations: it }, key, 256);
console.log(`pbkdf2$${it}$${b64u(salt)}$${b64u(bits)}`);
