// Extrait le MENU de index.html vers worker/src/menu.json (source unique des prix).
// Usage : node tools/sync-menu.mjs   (à relancer après chaque changement de prix)
import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const m = html.match(/const MENU = (\[[\s\S]*?\n\]);/);
if (!m) throw new Error("MENU introuvable dans index.html");
const MENU = Function('"use strict";return (' + m[1] + ")")();
const out = MENU.map(c => ({ id: c.id, name: c.name, items: c.items.map(([name, price]) => ({ name, price })) }));
writeFileSync(new URL("../worker/src/menu.json", import.meta.url), JSON.stringify(out, null, 1));
console.log("menu.json :", out.reduce((n, c) => n + c.items.length, 0), "articles");
