-- Mais de um administrador: remove a trava de "conta admin única".
-- Contas admin continuam exigindo MFA (TOTP) e são criadas apenas por outro admin (com reautenticação) ou pelo CLI.
DROP INDEX IF EXISTS accounts_single_admin;
CREATE INDEX accounts_role_status ON accounts (role, status);
