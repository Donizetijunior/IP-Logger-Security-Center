/**
 * Motor de risco determinístico, explicável e versionado.
 * O resultado descreve a reputação do ENDEREÇO/atividade de rede, nunca a identidade de uma pessoa.
 */

export const RISK_ENGINE_VERSION = '1.0.0';

export type RiskLevel = 'low' | 'medium' | 'high' | 'not_evaluated';

export type ProviderStatus =
  | 'ok'
  | 'no_data'
  | 'unavailable'
  | 'rate_limited'
  | 'not_queried'
  | 'disabled';

export interface ProviderObservation {
  source: 'abuseipdb' | 'greynoise' | 'tor' | string;
  status: ProviderStatus;
  checkedAt: string | null;
  data?: Record<string, unknown> | null;
}

export interface RateObservation {
  count: number;
  windowMinutes: number;
}

export interface RiskInput {
  abuseipdb?: ProviderObservation | null;
  greynoise?: ProviderObservation | null;
  torExit?: boolean | 'unknown';
  rate?: RateObservation | null;
}

export interface RiskEvidence {
  rule: string;
  points: number;
  observed: string | number | boolean | null;
  source: string;
  at: string | null;
  version: string;
  note?: string;
}

export interface RiskResult {
  score: number | null;
  level: RiskLevel;
  evidence: RiskEvidence[];
  engineVersion: string;
}

export interface RiskConfig {
  version: string;
  /** Limiares de AbuseIPDB (abuseConfidenceScore), do maior ao menor. */
  abuseTiers: Array<{ min: number; points: number }>;
  greynoiseMaliciousPoints: number;
  corroborationPoints: number;
  /** AbuseIPDB mínimo para contar como evidência independente de abuso na corroboração. */
  corroborationAbuseMin: number;
  rateAnomalyPoints: number;
  rateAnomalyThreshold: number;
  levels: { mediumMin: number; highMin: number };
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  version: RISK_ENGINE_VERSION,
  abuseTiers: [
    { min: 75, points: 30 },
    { min: 50, points: 20 },
    { min: 25, points: 10 },
  ],
  greynoiseMaliciousPoints: 35,
  corroborationPoints: 15,
  corroborationAbuseMin: 50,
  rateAnomalyPoints: 20,
  rateAnomalyThreshold: 60,
  levels: { mediumMin: 30, highMin: 70 },
};

export function levelForScore(score: number, cfg: RiskConfig = DEFAULT_RISK_CONFIG): Exclude<RiskLevel, 'not_evaluated'> {
  if (score >= cfg.levels.highMin) return 'high';
  if (score >= cfg.levels.mediumMin) return 'medium';
  return 'low';
}

const USABLE: ProviderStatus[] = ['ok', 'no_data'];

export function isEvaluable(input: RiskInput): boolean {
  return [input.abuseipdb, input.greynoise].some((p) => p && USABLE.includes(p.status));
}

export function computeRisk(input: RiskInput, cfg: RiskConfig = DEFAULT_RISK_CONFIG): RiskResult {
  const evidence: RiskEvidence[] = [];
  const v = cfg.version;

  if (!isEvaluable(input)) {
    return { score: null, level: 'not_evaluated', evidence, engineVersion: v };
  }

  let total = 0;
  let abuseCorroborates = false;
  let greyCorroborates = false;

  const abuse = input.abuseipdb;
  if (abuse && abuse.status === 'ok') {
    const raw = Number((abuse.data as Record<string, unknown> | null | undefined)?.abuseConfidenceScore);
    if (Number.isFinite(raw)) {
      const tier = cfg.abuseTiers.find((t) => raw >= t.min);
      const points = tier?.points ?? 0;
      total += points;
      evidence.push({
        rule: 'ABUSEIPDB_CONFIDENCE', points, observed: raw, source: 'abuseipdb', at: abuse.checkedAt, version: v,
        note: tier ? `Score de confiança de abuso >= ${tier.min}` : 'Abaixo dos limiares configurados',
      });
      abuseCorroborates = raw >= cfg.corroborationAbuseMin;
    }
  } else if (abuse) {
    evidence.push({ rule: 'ABUSEIPDB_STATUS', points: 0, observed: abuse.status, source: 'abuseipdb', at: abuse.checkedAt, version: v });
  }

  const grey = input.greynoise;
  if (grey && grey.status === 'ok') {
    const d = (grey.data ?? {}) as Record<string, unknown>;
    const classification = typeof d.classification === 'string' ? d.classification : null;
    if (classification === 'malicious') {
      total += cfg.greynoiseMaliciousPoints;
      greyCorroborates = true;
      evidence.push({ rule: 'GREYNOISE_MALICIOUS', points: cfg.greynoiseMaliciousPoints, observed: classification, source: 'greynoise', at: grey.checkedAt, version: v });
    } else {
      evidence.push({
        rule: 'GREYNOISE_CONTEXT', points: 0, observed: classification ?? (d.noise === true ? 'noise' : 'none'), source: 'greynoise', at: grey.checkedAt, version: v,
        note: 'Ruído de internet/benigno/desconhecido é contexto; não pontua sem classificação maliciosa',
      });
    }
  } else if (grey) {
    evidence.push({ rule: 'GREYNOISE_STATUS', points: 0, observed: grey.status, source: 'greynoise', at: grey.checkedAt, version: v });
  }

  if (abuseCorroborates && greyCorroborates) {
    total += cfg.corroborationPoints;
    evidence.push({
      rule: 'INDEPENDENT_CORROBORATION', points: cfg.corroborationPoints, observed: 2, source: 'abuseipdb+greynoise', at: null, version: v,
      note: 'Duas fontes independentes indicam abuso',
    });
  }

  if (input.rate && input.rate.count >= cfg.rateAnomalyThreshold) {
    total += cfg.rateAnomalyPoints;
    evidence.push({
      rule: 'RATE_ANOMALY', points: cfg.rateAnomalyPoints, observed: input.rate.count, source: 'local', at: null, version: v,
      note: `${input.rate.count} requisições em ${input.rate.windowMinutes} min (limiar ${cfg.rateAnomalyThreshold})`,
    });
  }

  if (input.torExit === true) {
    evidence.push({
      rule: 'TOR_EXIT_CONTEXT', points: 0, observed: true, source: 'tor', at: null, version: v,
      note: 'Saída Tor é contexto; não indica malícia por si só',
    });
  }

  const score = Math.min(100, total);
  return { score, level: levelForScore(score, cfg), evidence, engineVersion: v };
}
