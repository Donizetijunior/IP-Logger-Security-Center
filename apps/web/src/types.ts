export type RiskLevel = 'low' | 'medium' | 'high' | 'not_evaluated';

export interface Link {
  id: string;
  slug: string;
  publicUrl: string;
  targetUrl: string;
  label: string | null;
  isActive: boolean;
  expiresAt: string | null;
  createdAt: string;
  status: 'active' | 'inactive' | 'expired' | 'deleted';
  metrics?: { requests: number; uniqueIps: number; lastAccessAt: string | null };
}

export interface EventItem {
  id: string;
  shortLinkId: string | null;
  slug: string;
  occurredAt: string;
  ipAddress: string;
  method: string;
  httpStatus: number;
  userAgent: string | null;
  acceptLanguage: string | null;
  refererOrigin: string | null;
  clientClass: string;
  device: { class: string | null; browser: string | null; os: string | null };
  geo: { country: string | null; region: string | null; city: string | null; asn: number | null; asnOrg: string | null };
  rdns: string | null;
  torExit: string;
  enrichmentStatus: string;
  enrichedAt: string | null;
  risk: { score: number | null; level: RiskLevel };
}

export interface Evidence {
  rule: string;
  points: number;
  observed: string | number | boolean | null;
  source: string;
  at: string | null;
  version: string;
  note?: string;
}

export interface IntelRow {
  source: string;
  status: string;
  checkedAt: string;
  expiresAt: string;
  data: Record<string, unknown> | null;
  errorCode: string | null;
}

export interface EventDetail extends EventItem {
  link: { label: string | null; targetUrl: string | null };
  assessment: { score: number | null; level: RiskLevel; evidence: Evidence[]; engineVersion: string; assessedAt: string } | null;
  intelligence: IntelRow[];
  notice: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Summary {
  period: string;
  requestsTotal: number;
  uniqueIps: number;
  estimatedVisits: number;
  estimatedVisitsNote: string;
  breakdown: { bots: number; previews: number; headProbes: number };
  activeLinks: number;
  highRiskEvents: number;
  enrichmentFailures: number;
  enrichmentPending: number;
  captureFailures: number;
  openAlerts: Record<string, number>;
  workerHeartbeatAt: string | null;
}

export interface SeriesPoint {
  at: string;
  total: number;
  estimatedVisits: number;
  bots: number;
  previews: number;
}

export interface AlertItem {
  id: string;
  type: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'investigating' | 'resolved';
  ipAddress: string | null;
  shortLinkId: string | null;
  slug: string | null;
  title: string;
  evidence: Record<string, unknown>;
  occurrences: number;
  ruleVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface IpProfile {
  ip: string;
  summary: {
    totalEvents: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    maxRiskScore: number | null;
    latestRiskLevel: RiskLevel;
    geo: EventItem['geo'] | null;
    rdns: string | null;
    torExit: string;
  };
  links: Array<{ id: string; slug: string; label: string | null; hits: number; lastAt: string }>;
  intelligence: IntelRow[];
  rdap: Record<string, unknown> | null;
  timeline: EventItem[];
  notice: string;
}

export interface ExportItem {
  id: string;
  format: string;
  status: string;
  rowCount: number | null;
  maskedIp: boolean;
  createdAt: string;
  expiresAt: string;
}
