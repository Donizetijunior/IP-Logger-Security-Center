-- Domínios personalizados: cada link pode ficar em um domínio verificado do dono.
CREATE TABLE custom_domains (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  hostname           text NOT NULL,
  verification_token text NOT NULL,
  -- pending_dns: aguardando TXT · pending_approval: TXT ok, aguardando o admin · active · disabled
  status             text NOT NULL DEFAULT 'pending_dns' CHECK (status IN ('pending_dns', 'pending_approval', 'active', 'disabled')),
  verified_at        timestamptz,
  approved_at        timestamptz,
  -- Para onde "/" do domínio redireciona (opcional; sem isso responde 404)
  root_redirect_url  text,
  routing_ok         boolean,
  last_check_at      timestamptz,
  last_check_error   text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX custom_domains_hostname ON custom_domains (lower(hostname));
CREATE INDEX custom_domains_owner ON custom_domains (owner_id);

-- NO ACTION (e não RESTRICT): ao excluir uma conta, links e domínios saem no mesmo comando.
ALTER TABLE short_links ADD COLUMN domain_id uuid REFERENCES custom_domains(id);

-- O slug deixa de ser único globalmente: é único por domínio (domain_id nulo = domínio principal).
ALTER TABLE short_links DROP CONSTRAINT short_links_slug_key;
CREATE UNIQUE INDEX short_links_domain_slug
  ON short_links ((COALESCE(domain_id, '00000000-0000-0000-0000-000000000000'::uuid)), slug);
CREATE INDEX short_links_domain ON short_links (domain_id) WHERE domain_id IS NOT NULL;
