-- Multiusuário: contas com papéis, links com dono, denúncias de abuso.
-- Compatível com bancos existentes (o admin atual vira conta role=admin e dono dos links).

ALTER TABLE admins RENAME TO accounts;

ALTER TABLE accounts ALTER COLUMN totp_secret_encrypted DROP NOT NULL;
ALTER TABLE accounts ADD COLUMN role text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'user'));
ALTER TABLE accounts ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'suspended'));
ALTER TABLE accounts ADD COLUMN terms_accepted_at timestamptz;
ALTER TABLE accounts ADD COLUMN link_quota integer NOT NULL DEFAULT 25 CHECK (link_quota >= 0);
-- (a conta administradora existente passa a ter limite praticamente ilimitado, ver UPDATE abaixo)
ALTER TABLE accounts ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN created_by uuid;
ALTER TABLE accounts ADD COLUMN signup_source text NOT NULL DEFAULT 'cli' CHECK (signup_source IN ('cli', 'self', 'admin'));

UPDATE accounts SET status = CASE WHEN is_active THEN 'active' ELSE 'suspended' END, link_quota = 1000000, terms_accepted_at = now();
DROP INDEX admins_single_active;
ALTER TABLE accounts DROP COLUMN is_active;
-- Existe no máximo UMA conta administradora (as demais são usuários comuns)
CREATE UNIQUE INDEX accounts_single_admin ON accounts ((true)) WHERE role = 'admin';
-- E-mail único sem diferenciar maiúsculas
CREATE UNIQUE INDEX accounts_email_lower ON accounts (lower(email));

ALTER TABLE admin_recovery_codes RENAME COLUMN admin_id TO account_id;
ALTER TABLE login_challenges RENAME COLUMN admin_id TO account_id;
ALTER TABLE admin_sessions RENAME COLUMN admin_id TO account_id;
ALTER TABLE exports RENAME COLUMN admin_id TO account_id;
ALTER TABLE audit_events RENAME COLUMN admin_id TO account_id;

-- Escopo de exportação: NULL = admin (tudo); caso contrário apenas os links do dono
ALTER TABLE exports ADD COLUMN scope_owner_id uuid;

ALTER TABLE short_links ADD COLUMN owner_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
UPDATE short_links SET owner_id = (SELECT id FROM accounts WHERE role = 'admin' LIMIT 1) WHERE owner_id IS NULL;
ALTER TABLE short_links ALTER COLUMN owner_id SET NOT NULL;
-- Links desativados por moderação não podem ser reativados pelo dono
ALTER TABLE short_links ADD COLUMN moderation_disabled boolean NOT NULL DEFAULT false;
CREATE INDEX short_links_owner ON short_links (owner_id, created_at DESC);

-- Denúncias públicas de abuso (sem IP do denunciante; contato opcional)
CREATE TABLE abuse_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL,
  link_id     uuid REFERENCES short_links(id) ON DELETE SET NULL,
  reason      text NOT NULL CHECK (reason IN ('tracking_without_consent', 'phishing_or_fraud', 'harassment', 'illegal_content', 'other')),
  details     text,
  contact     text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'link_disabled', 'dismissed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX abuse_reports_status ON abuse_reports (status, created_at DESC);

INSERT INTO system_settings (key, value) VALUES ('terms_version', '"2026-10"') ON CONFLICT DO NOTHING;
