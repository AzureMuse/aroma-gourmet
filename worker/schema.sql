-- Base D1 du système de commande (une base par restaurant client).
CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  num           TEXT NOT NULL UNIQUE,          -- numéro lisible, ex. A-4821
  token         TEXT NOT NULL UNIQUE,          -- jeton secret du suivi client
  idem          TEXT NOT NULL UNIQUE,          -- anti-doublon (même envoi répété)
  status        TEXT NOT NULL DEFAULT 'recue', -- recue|acceptee|refusee|prete|recuperee|absente|expiree
  created_at    INTEGER NOT NULL,              -- ms epoch
  notify_from   INTEGER NOT NULL,              -- à partir de quand le resto doit réagir (ouverture si précommande)
  slot          TEXT NOT NULL,                 -- 'asap' ou 'AAAA-MM-JJTHH:MM' (heure de Montréal)
  slot_label    TEXT NOT NULL,
  preorder      INTEGER NOT NULL DEFAULT 0,
  mode          TEXT NOT NULL,                 -- Sur place | À emporter
  name          TEXT,
  phone         TEXT,                          -- 10 chiffres, effacé après la durée de conservation
  note          TEXT,
  items_json    TEXT NOT NULL,
  subtotal      REAL NOT NULL,
  prep_min      INTEGER,
  refuse_reason TEXT,
  paid_amount   REAL,                          -- montant encaissé saisi par le resto (facultatif)
  accepted_at   INTEGER,
  ready_at      INTEGER,
  closed_at     INTEGER,
  alert_level   INTEGER NOT NULL DEFAULT 0,    -- 0 rien, 1 alerte sonore, 2 relance, 3 agence prévenue
  notify_ok     INTEGER NOT NULL DEFAULT 0,
  tg_msg_id     INTEGER,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
  fbclid TEXT, gclid TEXT, fbp TEXT, fbc TEXT, user_agent TEXT,
  consent       INTEGER NOT NULL DEFAULT 0,    -- consentement mesure publicitaire (Loi 25)
  ip_hash       TEXT,
  device_id     TEXT,
  anonymized    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_phone   ON orders(phone, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_device  ON orders(device_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_ip      ON orders(ip_hash, created_at);

CREATE TABLE IF NOT EXISTS blocked_phones (phone TEXT PRIMARY KEY, reason TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS login_attempts (ip_hash TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, detail TEXT);

-- Appareils abonnés aux notifications Web Push (app installée), par rôle : resto | agence.
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL, label TEXT, created_at INTEGER, last_ok INTEGER, fails INTEGER NOT NULL DEFAULT 0, last_ack INTEGER
);
