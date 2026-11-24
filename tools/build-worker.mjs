// Assemble le serveur en un seul fichier (deploy/worker.js) pour le déploiement par l'API Cloudflare.
// Usage : cd worker && npx wrangler deploy --dry-run --outdir dist && node ../tools/build-worker.mjs
import fs from "node:fs";
const dir = new URL("../worker/dist/", import.meta.url);
let js = fs.readFileSync(new URL("index.js", dir), "utf8");
for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".html"))) {
  const html = fs.readFileSync(new URL(f, dir), "utf8");
  const re = new RegExp(`import (\\w+) from "\\./${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}";`);
  // Remplacement par fonction : aucun « $1 » du HTML n'est interprété.
  js = js.replace(re, (_, name) => `const ${name} = ${JSON.stringify(html)};`);
}
js = js.replace(/\n\/\/# sourceMappingURL=.*$/, "");
if (/^import /m.test(js)) throw new Error("import restant dans le paquet");
fs.writeFileSync(new URL("../deploy/worker.js", import.meta.url), js);
console.log("deploy/worker.js", js.length, "octets");
