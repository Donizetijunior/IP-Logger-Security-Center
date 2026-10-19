import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isValidSlug, sanitizeText } from '@ipl/shared';
import { EMAIL_REGEX, hashPassword, validatePasswordStrength } from '../auth.ts';
import { audit } from '../audit.ts';
import type { Ctx } from '../context.ts';
import { HttpError } from '../util.ts';

const signupBody = z.object({
  email: z.string().max(254).regex(EMAIL_REGEX, 'E-mail inválido'),
  password: z.string().min(1).max(256),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'É necessário aceitar os Termos de Uso' }) }),
});

const REASONS = ['tracking_without_consent', 'phishing_or_fraud', 'harassment', 'illegal_content', 'other'] as const;
const abuseBody = z.object({
  slug: z.string().min(1).max(64),
  reason: z.enum(REASONS),
  details: z.string().max(2000).optional(),
  contact: z.string().max(200).optional(),
});

/** Rotas públicas do painel: configuração, cadastro e denúncia de abuso. */
export function registerPublicAccount(app: FastifyInstance, ctx: Ctx, checkOrigin: (req: FastifyRequest) => void): void {
  const { config, pool } = ctx;

  app.get('/public/config', async () => ({
    signupMode: config.SIGNUP_MODE,
    openSourceUrl: config.OPEN_SOURCE_URL,
    shortBaseUrl: config.PUBLIC_SHORT_BASE_URL,
    privacyUrl: `${config.PUBLIC_SHORT_BASE_URL.replace(/\/$/, '')}/privacy`,
    termsVersion: '2026-10',
    defaultLinkQuota: config.DEFAULT_LINK_QUOTA,
  }));

  app.post('/auth/signup', { config: { rateLimit: { max: config.SIGNUP_RATE_PER_HOUR, timeWindow: '1 hour' } } }, async (req, reply) => {
    checkOrigin(req);
    if (config.SIGNUP_MODE === 'closed') throw new HttpError(403, 'signup_closed', 'O cadastro está fechado no momento');
    const body = signupBody.parse(req.body);
    const weak = validatePasswordStrength(body.password);
    if (weak) throw new HttpError(400, 'weak_password', weak);
    const status = config.SIGNUP_MODE === 'open' ? 'active' : 'pending';
    try {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO accounts (email, password_hash, role, status, terms_accepted_at, link_quota, signup_source)
         VALUES ($1, $2, 'user', $3, now(), $4, 'self') RETURNING id`,
        [body.email.trim(), await hashPassword(body.password), status, config.DEFAULT_LINK_QUOTA],
      );
      await audit(pool, { accountId: rows[0]!.id, action: 'account.signup', result: 'success', metadata: { status } });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'email_taken', 'Este e-mail já está cadastrado');
      throw err;
    }
    return reply.code(201).send({ status });
  });

  app.post('/public/abuse-report', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    checkOrigin(req);
    const body = abuseBody.parse(req.body);
    // Aceita o slug ou a URL curta completa
    const raw = body.slug.trim();
    const slug = raw.includes('/') ? (raw.split('/').filter(Boolean).pop() ?? '') : raw;
    if (!isValidSlug(slug)) throw new HttpError(400, 'invalid_slug', 'Informe o código do link (a parte depois da barra)');
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM short_links WHERE slug = $1 AND deleted_at IS NULL', [slug]);
    await pool.query(
      'INSERT INTO abuse_reports (slug, link_id, reason, details, contact) VALUES ($1, $2, $3, $4, $5)',
      [slug, rows[0]?.id ?? null, body.reason, sanitizeText(body.details, 2000), sanitizeText(body.contact, 200)],
    );
    return reply.code(201).send({ ok: true });
  });
}
