# Système de commande en ligne — documentation technique (Azure Muse)

Propriété d'Azure Muse. Premier client : Aroma Gourmet. Conçu pour être réutilisé par d'autres restaurants.

## 1. Architecture

```
Client (page GitHub Pages, index.html)
   │  POST /api/orders  (Turnstile + panier + heure + coordonnées + UTM)
   ▼
Cloudflare Worker (worker/src/index.js)  ── vérifie tout côté serveur
   │  ├─ D1 : enregistre la commande (worker/schema.sql)
   │  ├─ ntfy : alerte « une commande attend » (aucun détail) + lien vers le tableau de bord
   │  └─ Meta Conversions API : Lead (envoi) / Purchase (acceptée), seulement avec consentement
   ▼
Tableau de bord /admin (même Worker, session HttpOnly)   ←→  Koussaya (téléphone ou tablette)
Cron chaque minute : rappel resto 5 min → alerte Azure Muse 8 min → « non confirmée » 20 min ; purge 90 jours
```

Tout est gratuit dans les quotas Cloudflare (Workers Free : 100 000 requêtes/jour ; D1 Free ; Turnstile gratuit) et ntfy.sh.

**Limite ntfy.sh gratuit :** 250 messages/jour et 60 envois d'un coup puis 1 toutes les 5 s, comptés **par adresse IP**. Les serveurs Cloudflare partagent leurs IP : si la limite est atteinte (HTTP 429), l'échec est noté, le tableau de bord affiche « Notification en échec ! », la cron renvoie l'alerte et Azure Muse est prévenue. Si ça se produit souvent : forfait ntfy payant (jeton `NTFY_TOKEN`) ou Telegram (déjà codé, voir section 5), avec l'accord de Souad.

## 1 bis. App restaurateur (PWA) et notifications
- `/admin` est une app installable (iPhone : Safari → Partager → « Sur l'écran d'accueil » ; Android : « Installer l'application »).
- **Web Push** (VAPID + chiffrement RFC 8291, `worker/src/webpush.js`) vers chaque appareil abonné, par rôle (`resto`, `agence`). Gratuit, aucun compte tiers. Secrets : `VAPID_PRIVATE_JWK` (secret) et `VAPID_PUBLIC` (variable).
- Canaux : Web Push (principal) + ntfy (complément) + Telegram (facultatif, code conservé) + son du tableau de bord ouvert.
- **iPhone : le son des notifications web n'est pas garanti** (limite d'iOS) → garder ntfy et/ou une tablette au comptoir avec le tableau de bord ouvert.
- **Mode sécurisé** : les commandes en ligne ne sont acceptées que si un appareil du resto est joignable (abonnement Web Push valide ou tableau de bord ouvert depuis < 3 min). Sinon la page affiche « Appeler » et Azure Muse est alertée (une fois par jour, heures d'ouverture).
- Alertes Azure Muse : Web Push sur les appareils « agence » + ntfy. Courriel : possible avec Cloudflare Email Routing seulement si le domaine d'envoi utilise les DNS Cloudflare (non activé pour ne pas toucher au courrier d'azuremuse.ca).

## 2. Ce que le serveur contrôle (rien n'est fait confiance au navigateur)
- **Turnstile** validé côté serveur (`siteverify`) ; aucune clé secrète dans GitHub.
- **Prix et promotions** recalculés depuis `worker/src/menu.json` ; le trio 13,99 $ n'est accepté que pour un retrait dans son créneau.
- **Horaires** à l'heure de Montréal, jours fermés (`closedDates`), délai minimum, précommande ≤ 7 jours.
- **Anti-doublon** (clé `idem`), **numéro unique** `A-1234`, **jeton de suivi** secret pour le client.
- **Limites** : 4 commandes/jour et 2 en attente par numéro, 4/jour par appareil, 6/heure par IP (hachée), alerte après 2 absences, blocage du numéro décidé par le resto.
- **Repli automatique** : si le Worker est en panne, en pause, ou si le téléphone du resto n'est pas relié à Telegram, la page publique repasse seule en « menu + Appeler ».

## 3. Statuts
`recue` → `acceptee` (temps de préparation) / `refusee` (motif) → `prete` → `recuperee` (montant encaissé facultatif) ou `absente`. Sans réponse : `expiree` (le client est invité à appeler ; le resto peut encore accepter).

## 4. Fichiers
| Fichier | Rôle |
|---|---|
| `index.html` | Page publique. Réglages en haut : `ordersEnabled`, `api`, `turnstileSiteKey`, `metaPixelId`. |
| `worker/src/restaurant.js` | **Seul fichier à adapter par restaurant** : heures, jours fermés, promos, limites, relances, conservation. |
| `worker/src/menu.json` | Prix serveur. Générer avec `node tools/sync-menu.mjs` après tout changement de prix dans `index.html`. |
| `worker/src/admin.html` | Tableau de bord restaurateur. |
| `worker/schema.sql` | Base D1. |
| `tools/hash-password.mjs` | Crée l'empreinte du mot de passe du tableau de bord. |

## 5. Secrets (Cloudflare → Worker → Settings → Variables, ou `npx wrangler secret put NOM`)
| Nom | Contenu |
|---|---|
| `TURNSTILE_SECRET` | Clé secrète Turnstile |
| `SESSION_SECRET` | 32+ caractères aléatoires (signature des sessions) |
| `HASH_SALT` | 32+ caractères aléatoires (hachage des IP) |
| `ADMIN_PASSWORD_HASH` | `node tools/hash-password.mjs "<mot de passe resto>"` |
| `AGENCY_PASSWORD_HASH` | idem, mot de passe Azure Muse |
| `NTFY_TOPIC_RESTO` | Nom secret du canal ntfy du resto (40+ caractères aléatoires). **Pour le remplacer** : nouveau secret, puis s'abonner au nouveau nom dans l'appli ntfy |
| `NTFY_TOPIC_AGENCY` | Nom secret du canal d'alerte Azure Muse |
| `NTFY_SERVER` / `NTFY_TOKEN` | Facultatifs : autre serveur ntfy, ou jeton d'un compte payant |
| `TG_BOT_TOKEN` | Facultatif (Telegram, non utilisé pour l'instant) : jeton du bot |
| `TG_WEBHOOK_SECRET` | Aléatoire ; vérifie que les appels viennent bien de Telegram |
| `TG_LINK_RESTO` / `TG_LINK_AGENCY` | Codes de liaison à usage interne (aléatoires) |
| `META_PIXEL_ID` / `META_CAPI_TOKEN` | Pixel et jeton Conversions API (facultatif) |

## 6. Déploiement (une fois par restaurant)
```bash
cd worker && npm i
npx wrangler login
npx wrangler d1 create aroma-gourmet-commandes            # copier l'id dans wrangler.toml
npx wrangler d1 execute aroma-gourmet-commandes --remote --file schema.sql
npx wrangler secret put ...                                # chaque secret de la section 5
npx wrangler deploy
# Webhook Telegram :
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<worker>/api/tg&secret_token=<TG_WEBHOOK_SECRET>&allowed_updates=[\"message\",\"callback_query\"]"
```
Variable `DASHBOARD_URL` (wrangler.toml) = adresse du tableau de bord, ouverte en touchant une notification.
Abonner le téléphone du resto : appli ntfy → « + » → nom du canal `NTFY_TOPIC_RESTO` → réglages du canal : priorité urgente avec son, autoriser les notifications sur l'écran verrouillé. Même chose pour Azure Muse avec `NTFY_TOPIC_AGENCY`.
(Telegram, si un jour activé) Relier le téléphone : ouvrir `https://t.me/<nom_du_bot>?start=<TG_LINK_RESTO>` sur son téléphone, appuyer sur Démarrer. Même chose pour Azure Muse avec `TG_LINK_AGENCY`.
Puis dans `index.html` : `api`, `turnstileSiteKey`, et `ordersEnabled: true` seulement après la checklist.

Environnement de test séparé : `npx wrangler deploy --env test` (base `-test`, aucun vrai client).

## 7. Procédure de secours
1. **Notification non reçue** : bouton « Test notification » dans l'Historique ; le tableau de bord sonne aussi (laisser la tablette ouverte, « Activer le son »). Rappel automatique à 5 min, alerte Azure Muse à 8 min.
2. **ntfy en panne / téléphone perdu / canal découvert** : bouton **Pause** → la page affiche « Appeler pour commander ». Changer `NTFY_TOPIC_RESTO` et réabonner le téléphone.
3. **Worker en panne** : la page repasse automatiquement en mode menu + appel. Sinon : `ordersEnabled: false` dans `index.html`.
4. **Fausses commandes** : bouton « Client absent », puis « Bloquer ce numéro » (décision du resto), ou baisser les limites dans `restaurant.js`.

## 8. Loi 25 (à valider par Azure Muse — pas un avis juridique)
- Données minimales : nom, téléphone, note. Aucune donnée de paiement.
- Conservation 90 jours puis anonymisation automatique (les montants et la provenance sont gardés sans identité). Motif : traiter réclamations et absences ; ajustable dans `restaurant.js`.
- Accès : resto et Azure Muse seulement (mot de passe, session HttpOnly, 5 essais / 15 min).
- Hébergement Cloudflare (hors Québec) : une **évaluation des facteurs relatifs à la vie privée (EFVP)** est requise avant de communiquer des renseignements hors Québec ; un responsable de la protection des renseignements doit être désigné (par défaut, la personne ayant la plus haute autorité de l'entreprise, donc Koussaya pour Aroma). Une politique de confidentialité doit être publiée.
- Témoins Meta : chargés seulement après « J'accepte ».

## 9. Nouveau restaurant
1. Copier le dépôt, remplacer le menu et l'habillage de `index.html`.
2. Adapter `worker/src/restaurant.js` et `wrangler.toml` (`name`, base D1).
3. `node tools/sync-menu.mjs`, puis section 6.
