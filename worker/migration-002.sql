-- Accusé de réception des notifications (appareil réellement opérationnel)
ALTER TABLE push_subs ADD COLUMN last_ack INTEGER;
