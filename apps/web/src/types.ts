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
  owner?: { id: string; email: string | null };
  domain?: { id: string; hostname: string | null } | null;
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

export interface DomainItem {
  id: string;
  hostname: string;
  status: 'pending_dns' | 'pending_approval' | 'active' | 'disabled';
  owner?: { id: string; email: string | null };
  verifiedAt: string | null;
  approvedAt: string | null;
  rootRedirectUrl: string | null;
  routingOk: boolean | null;
  lastCheckAt: string | null;
  lastCheckError: string | null;
  createdAt: string;
  links: number;
  dns: { txtName: string; txtValue: string };
  routing: { serviceUrl: string; hostname: string };
}

export interface DomainPolicy {
  mode: 'admin' | 'approval' | 'open';
  canCreate: boolean;
  max: number | null;
  used: number;
}

export type Role = 'admin' | 'user';

export interface Me {
  email: string;
  role: Role;
  mustChangePassword: boolean;
  linkQuota?: number;
}

export interface PublicConfig {
  geoAttribution?: string | null;
  signupMode: 'open' | 'approval' | 'closed';
  openSourceUrl: string;
  shortBaseUrl: string;
  privacyUrl: string;
  termsVersion: string;
  defaultLinkQuota: number;
}

export interface UserItem {
  id: string;
  email: string;
  role: Role;
  status: 'active' | 'pending' | 'suspended';
  linkQuota: number;
  signupSource: string;
  mustChangePassword: boolean;
  createdAt: string;
  links: number;
  events: number;
}

export interface ReportItem {
  id: string;
  slug: string;
  linkId: string | null;
  reason: string;
  details: string | null;
  contact: string | null;
  status: 'open' | 'reviewing' | 'link_disabled' | 'dismissed';
  createdAt: string;
  targetUrl: string | null;
  owner: { id: string; email: string; status: string } | null;
}
