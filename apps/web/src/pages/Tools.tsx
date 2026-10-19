import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { encryptNote } from '../notecrypto';
import { Badge, Button, Card, Empty, ErrorBox, Field, PageHeader, Spinner, Time } from '../ui';

const TABS = [
  { id: 'whoami', label: 'Meu IP e User-Agent' },
  { id: 'ip', label: 'Consulta de IP' },
  { id: 'whois', label: 'WHOIS / RDAP' },
  { id: 'mac', label: 'Fabricante (MAC)' },
  { id: 'url', label: 'Verificador de URL' },
  { id: 'note', label: 'Nota privada' },
  { id: 'ua', label: 'Gerador de User-Agent' },
  { id: 'rndip', label: 'Gerador de IP' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function KV({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="mt-3">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-3 gap-2 border-b py-2 text-sm last:border-b-0" style={{ borderColor: 'var(--border)' }}>
          <dt style={{ color: 'var(--muted)' }}>{k}</dt>
          <dd className="col-span-2 break-words">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

const yesNo = (v: boolean | 'unknown' | null | undefined) => (v === true ? 'Sim' : v === false ? 'Não' : 'Desconhecido');
const Notice = ({ children }: { children: ReactNode }) => (
  <p className="mt-3 rounded-lg p-3 text-sm" style={{ background: 'var(--info-bg)', color: 'var(--info-fg)' }}>{children}</p>
);

/** Hook de consulta sob demanda. */
function useRun<T>() {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<T>) => {
    setBusy(true);
    setError(null);
    try {
      setData(await fn());
    } catch (e) {
      setData(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { data, error, busy, run };
}

// ---------- Meu IP
interface WhoAmI { ip: string | null; version: string | null; label: string; tor: boolean | 'unknown'; userAgent: string | null; browser: string | null; os: string | null; deviceClass: string | null; acceptLanguage: string | null; note: string }
function WhoAmITool() {
  const { data, error, busy, run } = useRun<WhoAmI>();
  useEffect(() => { void run(() => api.get<WhoAmI>('/tools/whoami')); }, []);
  return (
    <>
      {busy && <Spinner />}
      {error ? <ErrorBox error={error} /> : null}
      {data && (
        <>
          <KV rows={[
            ['Seu IP (visto pelo servidor)', <span className="mono text-base font-semibold">{data.ip ?? 'indisponível'}</span>],
            ['Versão / tipo', `${data.version ?? '—'} · ${data.label}`],
            ['Saída Tor', yesNo(data.tor)],
            ['Navegador / sistema', [data.browser, data.os, data.deviceClass].filter(Boolean).join(' · ') || '—'],
            ['User-Agent', <span className="mono text-xs">{data.userAgent}</span>],
            ['Idioma', data.acceptLanguage],
          ]} />
          <Notice>{data.note}</Notice>
        </>
      )}
    </>
  );
}

// ---------- Consulta de IP
interface IpInfo { ip: string; version: string; label: string; public: boolean; geo?: { available: boolean; country: string | null; region: string | null; city: string | null; asn: number | null; asnOrg: string | null }; rdns?: string | null; tor?: boolean | 'unknown'; rdap?: Record<string, string | null> | null; notice: string }
function IpTool({ initial = '' }: { initial?: string }) {
  const [ip, setIp] = useState(initial);
  const [rdap, setRdap] = useState(false);
  const { data, error, busy, run } = useRun<IpInfo>();
  const submit = (e: FormEvent) => { e.preventDefault(); void run(() => api.get<IpInfo>(`/tools/ip/${encodeURIComponent(ip.trim())}${qs({ rdap: rdap ? 'true' : undefined })}`)); };
  return (
    <>
      <form onSubmit={submit} className="flex max-w-xl flex-wrap items-end gap-3">
        <Field label="Endereço IP (IPv4 ou IPv6)" className="min-w-56 flex-1"><input required value={ip} onChange={(e) => setIp(e.target.value)} placeholder="8.8.8.8" className="mono w-full" /></Field>
        <label className="flex items-center gap-2 pb-2 text-sm" style={{ color: 'var(--text)' }}><input type="checkbox" checked={rdap} onChange={(e) => setRdap(e.target.checked)} /> incluir RDAP</label>
        <Button type="submit" disabled={busy}>{busy ? 'Consultando…' : 'Consultar'}</Button>
      </form>
      {error ? <div className="mt-3"><ErrorBox error={error} /></div> : null}
      {data && (
        <>
          <KV rows={[
            ['IP', <span className="mono">{data.ip}</span>],
            ['Tipo', `${data.version} · ${data.label}`],
            ...(data.public ? ([
              ['País / região / cidade (aprox.)', data.geo?.available ? [data.geo.city, data.geo.region, data.geo.country].filter(Boolean).join(', ') || '—' : 'Base GeoLite2 não habilitada neste servidor'],
              ['ASN', data.geo?.asn ? `AS${data.geo.asn} ${data.geo.asnOrg ?? ''}` : '—'],
              ['DNS reverso', data.rdns],
              ['Saída Tor', yesNo(data.tor)],
            ] as Array<[string, ReactNode]>) : []),
            ...(data.rdap ? ([['RDAP', <span className="mono text-xs">{JSON.stringify(data.rdap)}</span>]] as Array<[string, ReactNode]>) : []),
          ]} />
          <Notice>{data.notice}</Notice>
        </>
      )}
    </>
  );
}

// ---------- WHOIS
interface WhoisOut { kind: 'ip' | 'domain'; query: string; result: Record<string, unknown> | null; notice?: string }
function WhoisTool() {
  const [q, setQ] = useState('');
  const { data, error, busy, run } = useRun<WhoisOut>();
  const submit = (e: FormEvent) => { e.preventDefault(); void run(() => api.get<WhoisOut>(`/tools/whois${qs({ q: q.trim() })}`)); };
  const r = data?.result as Record<string, unknown> | null | undefined;
  return (
    <>
      <form onSubmit={submit} className="flex max-w-xl flex-wrap items-end gap-3">
        <Field label="Domínio ou IP público" className="min-w-56 flex-1"><input required value={q} onChange={(e) => setQ(e.target.value)} placeholder="exemplo.com.br" className="w-full" /></Field>
        <Button type="submit" disabled={busy}>{busy ? 'Consultando…' : 'Consultar'}</Button>
      </form>
      {error ? <div className="mt-3"><ErrorBox error={error} /></div> : null}
      {data && (r ? (
        <KV rows={data.kind === 'domain' ? [
          ['Domínio', <span className="mono">{String(r.domain)}</span>],
          ['Situação', (r.status as string[] | undefined)?.join(', ')],
          ['Registrador', r.registrar as string | null],
          ['Registrado em', r.registeredAt ? <Time iso={r.registeredAt as string} /> : null],
          ['Expira em', r.expiresAt ? <Time iso={r.expiresAt as string} /> : null],
          ['Alterado em', r.changedAt ? <Time iso={r.changedAt as string} /> : null],
          ['Servidores DNS', (r.nameservers as string[] | undefined)?.join(', ')],
        ] : Object.entries(r).map(([k, v]) => [k, String(v ?? '—')] as [string, ReactNode])} />
      ) : <Notice>{data.notice ?? 'Sem resultado.'}</Notice>)}
      {data && r && <Notice>Dados do registro público (RDAP). Contatos pessoais não são exibidos.</Notice>}
    </>
  );
}

// ---------- MAC
interface MacOut { normalized: string; vendor: string | null; matchedPrefix: string | null; locallyAdministered: boolean; multicast: boolean; notice: string }
function MacTool() {
  const [q, setQ] = useState('');
  const { data, error, busy, run } = useRun<MacOut>();
  const submit = (e: FormEvent) => { e.preventDefault(); void run(() => api.get<MacOut>(`/tools/mac${qs({ q: q.trim() })}`)); };
  return (
    <>
      <form onSubmit={submit} className="flex max-w-xl flex-wrap items-end gap-3">
        <Field label="Endereço MAC ou prefixo (OUI)" className="min-w-56 flex-1"><input required value={q} onChange={(e) => setQ(e.target.value)} placeholder="28:6F:B9:11:22:33" className="mono w-full" /></Field>
        <Button type="submit" disabled={busy}>{busy ? 'Consultando…' : 'Consultar'}</Button>
      </form>
      {error ? <div className="mt-3"><ErrorBox error={error} /></div> : null}
      {data && (
        <>
          <KV rows={[
            ['MAC normalizado', <span className="mono">{data.normalized}</span>],
            ['Fabricante', data.vendor ?? 'Não encontrado'],
            ['Prefixo encontrado', data.matchedPrefix],
            ['Administrado localmente', yesNo(data.locallyAdministered)],
            ['Multicast', yesNo(data.multicast)],
          ]} />
          <Notice>{data.notice}</Notice>
        </>
      )}
    </>
  );
}

// ---------- Verificador de URL
interface UrlHop { url: string; status: number | null; location: string | null; ms: number | null; tls: boolean; server: string | null; error?: { message: string } }
interface UrlOut { hops: UrlHop[]; finalUrl: string | null; finalStatus: number | null; redirects: number; warnings: string[]; error?: { code: string; message: string } }
function UrlTool() {
  const [url, setUrl] = useState('');
  const { data, error, busy, run } = useRun<UrlOut>();
  const submit = (e: FormEvent) => { e.preventDefault(); void run(() => api.post<UrlOut>('/tools/url-check', { url: url.trim() })); };
  return (
    <>
      <form onSubmit={submit} className="flex max-w-2xl flex-wrap items-end gap-3">
        <Field label="URL (o conteúdo da página NÃO é baixado nem executado)" className="min-w-64 flex-1"><input required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://exemplo.org/link-curto" className="w-full" /></Field>
        <Button type="submit" disabled={busy}>{busy ? 'Verificando…' : 'Verificar'}</Button>
      </form>
      {error ? <div className="mt-3"><ErrorBox error={error} /></div> : null}
      {data && (
        <div className="mt-4">
          <p className="mb-2 text-sm">{data.redirects} redirecionamento(s) · resposta final: <strong>{data.finalStatus ?? '—'}</strong></p>
          {data.error && <ErrorBox error={new Error(data.error.message)} />}
          {data.warnings.map((w) => <p key={w} className="mb-1 rounded-lg p-2 text-sm" style={{ background: 'var(--warn-bg)', color: 'var(--warn-fg)' }}>⚠ {w}</p>)}
          <ol className="mt-3 flex flex-col gap-2">
            {data.hops.map((h, i) => (
              <li key={`${h.url}-${i}`} className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--border)' }}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge kind={h.status && h.status < 300 ? 'ok' : h.status && h.status < 400 ? 'info' : 'bad'}>{h.status ?? 'erro'}</Badge>
                  {h.tls ? <Badge kind="ok">HTTPS</Badge> : <Badge kind="warn">HTTP</Badge>}
                  {h.ms !== null && <span className="text-xs" style={{ color: 'var(--muted)' }}>{h.ms} ms</span>}
                  {h.server && <span className="text-xs" style={{ color: 'var(--muted)' }}>{h.server}</span>}
                </div>
                <div className="mono mt-1 break-all text-xs">{h.url}</div>
                {h.error && <div className="mt-1 text-xs" style={{ color: 'var(--bad-fg)' }}>{h.error.message}</div>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}

// ---------- Nota privada
interface NoteItem { id: string; createdAt: string; expiresAt: string }
function NoteTool() {
  const [text, setText] = useState('');
  const [ttl, setTtl] = useState(24);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<NoteItem[]>([]);

  const load = useCallback(async () => {
    try {
      setItems((await api.get<{ items: NoteItem[] }>('/tools/notes')).items);
    } catch {
      /* lista é opcional */
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setLink(null);
    try {
      const enc = await encryptNote(text);
      const r = await api.post<{ id: string }>('/tools/notes', { ciphertext: enc.ciphertext, iv: enc.iv, ttlHours: ttl });
      setLink(`${window.location.origin}/nota/${r.id}#${enc.key}`);
      setText('');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form onSubmit={create} className="flex max-w-2xl flex-col gap-3">
        <Field label="Mensagem (cifrada no seu navegador; máx. ~20 mil caracteres)"><textarea required rows={6} maxLength={20000} value={text} onChange={(e) => setText(e.target.value)} className="w-full" /></Field>
        <Field label="Validade">
          <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
            <option value={1}>1 hora</option><option value={24}>24 horas</option><option value={72}>3 dias</option><option value={168}>7 dias</option>
          </select>
        </Field>
        {error ? <ErrorBox error={error} /> : null}
        <div><Button type="submit" disabled={busy}>{busy ? 'Cifrando…' : 'Criar nota'}</Button></div>
      </form>
      {link && (
        <div className="mt-4 max-w-2xl rounded-lg p-4 text-sm" style={{ background: 'var(--ok-bg)', color: 'var(--ok-fg)' }}>
          <div className="mb-1 font-semibold">Link da nota (válido para UMA leitura):</div>
          <code className="select-all break-all">{link}</code>
          <div className="mt-2"><Button variant="secondary" onClick={() => void navigator.clipboard.writeText(link)}>Copiar link</Button></div>
          <p className="mt-2 text-xs">A chave de decifragem está depois do “#” e nunca é enviada ao servidor. Quem perder o link perde a nota.</p>
        </div>
      )}
      <h3 className="mb-2 mt-6 font-semibold">Minhas notas pendentes</h3>
      {items.length === 0 ? <Empty>Nenhuma nota pendente.</Empty> : (
        <ul className="flex max-w-2xl flex-col gap-2">
          {items.map((n) => (
            <li key={n.id} className="flex items-center justify-between gap-2 rounded-lg border p-2 text-sm" style={{ borderColor: 'var(--border)' }}>
              <span>Criada <Time iso={n.createdAt} /> · expira <Time iso={n.expiresAt} /></span>
              <Button variant="danger" onClick={async () => { await api.del(`/tools/notes/${n.id}`); await load(); }}>Apagar</Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------- Gerador de User-Agent (somente no navegador)
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!;
const rnd = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const UA_MAKERS: Record<string, () => string> = {
  'Chrome (Windows)': () => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${rnd(118, 130)}.0.0.0 Safari/537.36`,
  'Chrome (Linux)': () => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${rnd(118, 130)}.0.0.0 Safari/537.36`,
  'Edge (Windows)': () => { const v = rnd(118, 130); return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36 Edg/${v}.0.0.0`; },
  'Firefox (Windows)': () => { const v = rnd(118, 131); return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`; },
  'Safari (macOS)': () => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${rnd(16, 18)}.${rnd(0, 5)} Safari/605.1.15`,
  'Chrome (Android)': () => `Mozilla/5.0 (Linux; Android ${rnd(11, 15)}; ${pick(['Pixel 7', 'Pixel 8', 'SM-S918B', 'SM-A546E', 'Moto G84'])}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${rnd(118, 130)}.0.0.0 Mobile Safari/537.36`,
  'Safari (iPhone)': () => { const v = rnd(16, 18); return `Mozilla/5.0 (iPhone; CPU iPhone OS ${v}_${rnd(0, 5)} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v}.0 Mobile/15E148 Safari/604.1`; },
};
function UaTool() {
  const [kind, setKind] = useState('Chrome (Windows)');
  const [n, setN] = useState(5);
  const [list, setList] = useState<string[]>(() => Array.from({ length: 5 }, () => UA_MAKERS['Chrome (Windows)']!()));
  const gen = () => setList(Array.from({ length: n }, () => UA_MAKERS[kind]!()));
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Navegador / sistema"><select value={kind} onChange={(e) => setKind(e.target.value)}>{Object.keys(UA_MAKERS).map((k) => <option key={k}>{k}</option>)}</select></Field>
        <Field label="Quantidade"><input type="number" min={1} max={50} value={n} onChange={(e) => setN(Math.min(50, Math.max(1, Number(e.target.value) || 1)))} className="w-24" /></Field>
        <Button onClick={gen}>Gerar</Button>
      </div>
      <ul className="mt-4 flex flex-col gap-1">{list.map((u, i) => <li key={`${u}-${i}`} className="mono select-all break-all rounded border p-2 text-xs" style={{ borderColor: 'var(--border)' }}>{u}</li>)}</ul>
      <Notice>Gerado no seu navegador, sem enviar nada ao servidor. Útil para testes de compatibilidade e de regras de classificação.</Notice>
    </>
  );
}

// ---------- Gerador de IP (somente no navegador)
const isPublicV4 = (o: number[]) => {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
};
function genIp(kind: string): string {
  if (kind === 'doc4') return pick(['192.0.2', '198.51.100', '203.0.113']) + `.${rnd(1, 254)}`;
  if (kind === 'public6') return `2${rnd(0, 0xfff).toString(16)}:${Array.from({ length: 7 }, () => rnd(0, 0xffff).toString(16)).join(':')}`;
  for (;;) {
    const o = [rnd(1, 223), rnd(0, 255), rnd(0, 255), rnd(1, 254)];
    if (isPublicV4(o)) return o.join('.');
  }
}
function RandIpTool() {
  const [kind, setKind] = useState('public4');
  const [n, setN] = useState(10);
  const [list, setList] = useState<string[]>([]);
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Tipo"><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="public4">IPv4 público (roteável)</option><option value="public6">IPv6 público</option><option value="doc4">IPv4 de documentação (192.0.2/24 etc.)</option></select></Field>
        <Field label="Quantidade"><input type="number" min={1} max={100} value={n} onChange={(e) => setN(Math.min(100, Math.max(1, Number(e.target.value) || 1)))} className="w-24" /></Field>
        <Button onClick={() => setList(Array.from({ length: n }, () => genIp(kind)))}>Gerar</Button>
      </div>
      {list.length > 0 && <textarea readOnly rows={Math.min(12, list.length + 1)} value={list.join('\n')} className="mono mt-4 w-full max-w-md text-sm" onFocus={(e) => e.currentTarget.select()} />}
      <Notice>Endereços aleatórios gerados no navegador, para dados de teste. Um IP público aleatório pode pertencer a alguém: não o use para varrer, acessar ou atacar sistemas. Para fixtures de testes, prefira os de documentação.</Notice>
    </>
  );
}

export function ToolsPage() {
  const [tab, setTab] = useState<TabId>('whoami');
  return (
    <>
      <PageHeader title="Ferramentas" subtitle="Utilitários de rede e segurança para investigação autorizada. Consultas externas passam por um cliente protegido contra SSRF." />
      <div role="tablist" aria-label="Ferramentas" className="mb-4 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className="rounded-lg border px-3 py-1.5 text-sm"
            style={{ borderColor: 'var(--border)', background: tab === t.id ? 'var(--accent)' : 'var(--surface)', color: tab === t.id ? 'var(--accent-contrast)' : 'var(--text)' }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Card title={TABS.find((t) => t.id === tab)!.label}>
        {tab === 'whoami' && <WhoAmITool />}
        {tab === 'ip' && <IpTool />}
        {tab === 'whois' && <WhoisTool />}
        {tab === 'mac' && <MacTool />}
        {tab === 'url' && <UrlTool />}
        {tab === 'note' && <NoteTool />}
        {tab === 'ua' && <UaTool />}
        {tab === 'rndip' && <RandIpTool />}
      </Card>
      <p className="mt-4 text-xs" style={{ color: 'var(--muted)' }}>
        Não oferecemos localização de pessoas por telefone, foto ou GPS, nem pixels de rastreamento ocultos. Veja os <Link to="/termos">Termos de Uso</Link>.
      </p>
    </>
  );
}
