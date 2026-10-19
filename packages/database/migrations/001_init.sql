-- IP Logger Security Center — esquema inicial

CREATE TABLE admins (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL UNIQUE,
  password_hash         text NOT NULL,
  totp_secret_encrypted text NOT NULL,
  totp_confirmed_at     timestamptz,
  is_active             boolean NOT NULL DEFAULT true,
  failed_logins         integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_totp_step        bigint,
  created_at            timestamptz NOT NULL DEFAULT now()
);
-- Somente uma conta administrativa ativa
CREATE UNIQUE INDEX admins_single_active ON admins ((true)) WHERE is_active;

CREATE TABLE admin_recovery_codes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id  uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at   timestamptz
);
CREATE INDEX admin_recovery_codes_admin ON admin_recovery_codes (admin_id);

-- Desafio de login (senha validada, aguardando TOTP)
CREATE TABLE login_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  attempts   integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  csrf_token   text NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  reauth_at    timestamptz
);

CREATE TABLE short_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  target_url text NOT NULL,
  label      text,
  is_active  boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE access_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_link_id     uuid REFERENCES short_links(id) ON DELETE SET NULL,
  slug              text NOT NULL,
  ip_address        inet NOT NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  method            text NOT NULL,
  http_status       integer NOT NULL,
  user_agent        text,
  accept_language   text,
  referer_origin    text,
  client_class      text NOT NULL DEFAULT 'unknown',
  device_class      text,
  browser           text,
  os                text,
  country           text,
  region            text,
  city              text,
  asn               integer,
  asn_org           text,
  rdns              text,
  tor_exit          text NOT NULL DEFAULT 'unknown',
  enrichment_status text NOT NULL DEFAULT 'pending',
  enriched_at       timestamptz,
  risk_score        integer,
  risk_level        text NOT NULL DEFAULT 'not_evaluated'
);
CREATE INDEX access_events_occurred ON access_events (occurred_at DESC, id);
CREATE INDEX access_events_ip_time ON access_events (ip_address, occurred_at DESC);
CREATE INDEX access_events_link_time ON access_events (short_link_id, occurred_at DESC);
CREATE INDEX access_events_risk ON access_events (risk_level, occurred_at DESC);

CREATE TABLE ip_intelligence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address    inet NOT NULL,
  source        text NOT NULL,
  checked_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  status        text NOT NULL,
  data_redacted jsonb,
  error_code    text,
  UNIQUE (ip_address, source)
);
CREATE INDEX ip_intelligence_expires ON ip_intelligence (expires_at);

CREATE TABLE risk_assessments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_event_id uuid NOT NULL REFERENCES access_events(id) ON DELETE CASCADE,
  score           integer,
  level           text NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '[]',
  engine_version  text NOT NULL,
  assessed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX risk_assessments_event ON risk_assessments (access_event_id);

CREATE TABLE alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL,
  severity      text NOT NULL,
  status        text NOT NULL DEFAULT 'open',
  ip_address    inet,
  short_link_id uuid REFERENCES short_links(id) ON DELETE SET NULL,
  title         text NOT NULL,
  evidence      jsonb NOT NULL DEFAULT '{}',
  dedupe_key    text NOT NULL,
  occurrences   integer NOT NULL DEFAULT 1,
  rule_version  text NOT NULL DEFAULT '1.0.0',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Um alerta aberto/em investigação por chave de deduplicação
CREATE UNIQUE INDEX alerts_open_dedupe ON alerts (dedupe_key) WHERE status <> 'resolved';
CREATE INDEX alerts_status_time ON alerts (status, created_at DESC);

CREATE TABLE audit_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id          uuid,
  action            text NOT NULL,
  resource          text,
  result            text NOT NULL,
  at                timestamptz NOT NULL DEFAULT now(),
  metadata_redacted jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_at ON audit_events (at DESC);

CREATE TABLE outbox_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id   uuid NOT NULL,
  type           text NOT NULL,
  payload_minimal jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unpublished ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_settings (key, value) VALUES ('retention_days', '30');

-- Contadores operacionais sem PII (falhas de captura, bloqueios etc.)
CREATE TABLE telemetry_counters (
  key    text NOT NULL,
  bucket timestamptz NOT NULL,
  value  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (key, bucket)
);

-- Consumo de quota por provedor (janela diária UTC)
CREATE TABLE provider_quota (
  source       text NOT NULL,
  window_start date NOT NULL,
  used         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (source, window_start)
);

-- Estado de provedores / jobs (heartbeat, última execução, circuito)
CREATE TABLE job_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tor_exit_nodes (
  ip_address inet PRIMARY KEY
);

CREATE TABLE exports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  format     text NOT NULL,
  filters    jsonb NOT NULL DEFAULT '{}',
  mask_ip    boolean NOT NULL DEFAULT true,
  status     text NOT NULL DEFAULT 'pending',
  content    text,
  row_count  integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
