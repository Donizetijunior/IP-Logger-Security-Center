-- Versão dos Termos de Uso aceita por cada conta (permite avisar e coletar novo aceite quando os Termos mudam).
ALTER TABLE accounts ADD COLUMN terms_version text;
UPDATE accounts SET terms_version = '2026-10' WHERE terms_accepted_at IS NOT NULL;
