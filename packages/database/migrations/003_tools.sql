-- Ferramentas: notas privadas autodestrutivas (o servidor guarda só o texto CIFRADO no navegador;
-- a chave fica no fragmento da URL e nunca chega ao servidor).
CREATE TABLE private_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  iv         text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX private_notes_account ON private_notes (account_id, created_at DESC);
CREATE INDEX private_notes_expires ON private_notes (expires_at);
