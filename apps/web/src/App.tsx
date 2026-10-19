import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { ApiError, api, setCsrf } from './api';
import { SessionContext } from './session';
import { Spinner } from './ui';
import type { Me, PublicConfig } from './types';
import { AbusePage } from './pages/Abuse';
import { AccountPage } from './pages/Account';
import { AlertsPage } from './pages/Alerts';
import { EventDetailPage } from './pages/EventDetail';
import { EventsPage } from './pages/Events';
import { IpPage } from './pages/Ip';
import { LinksPage } from './pages/Links';
import { LoginPage } from './pages/Login';
import { NotePage } from './pages/Note';
import { ToolsPage } from './pages/Tools';
import { OverviewPage } from './pages/Overview';
import { ReportsPage } from './pages/Reports';
import { SettingsPage } from './pages/Settings';
import { SignupPage } from './pages/Signup';
import { TermsPage } from './pages/Terms';
import { UsersPage } from './pages/Users';

const NAV_USER = [
  { to: '/', label: 'Visão geral', end: true },
  { to: '/links', label: 'Links' },
  { to: '/eventos', label: 'Eventos' },
  { to: '/alertas', label: 'Alertas' },
  { to: '/ferramentas', label: 'Ferramentas' },
  { to: '/conta', label: 'Minha conta' },
];
const NAV_ADMIN = [
  { to: '/', label: 'Visão geral', end: true },
  { to: '/links', label: 'Links' },
  { to: '/eventos', label: 'Eventos' },
  { to: '/alertas', label: 'Alertas' },
  { to: '/ferramentas', label: 'Ferramentas' },
  { to: '/usuarios', label: 'Usuários' },
  { to: '/denuncias', label: 'Denúncias' },
  { to: '/configuracoes', label: 'Configurações e saúde' },
  { to: '/conta', label: 'Minha conta' },
];

function Footer({ config }: { config: PublicConfig | null }) {
  return (
    <footer className="mt-8 flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
      <Link to="/termos">Termos de Uso</Link>
      {config && <a href={config.privacyUrl} target="_blank" rel="noreferrer">Privacidade</a>}
      <Link to="/denunciar">Denunciar abuso</Link>
      {config && <a href={config.openSourceUrl} target="_blank" rel="noreferrer">Código aberto</a>}
    </footer>
  );
}

function PublicShell({ children, config }: { children: ReactNode; config: PublicConfig | null }) {
  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col px-4 py-6">
      <header className="mb-6">
        <Link to="/" className="text-lg font-bold" style={{ color: 'var(--text)', textDecoration: 'none' }}>IP Logger Security Center</Link>
      </header>
      <main className="flex-1">{children}</main>
      <Footer config={config} />
    </div>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [checking, setChecking] = useState(true);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<Me & { csrfToken: string }>('/auth/me');
      setCsrf(r.csrfToken);
      setMe({ email: r.email, role: r.role, mustChangePassword: r.mustChangePassword, linkQuota: r.linkQuota });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) console.error('Falha ao verificar sessão');
      setCsrf(null);
      setMe(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    api.get<PublicConfig>('/public/config').then(setConfig).catch(() => undefined);
    const onUnauth = () => {
      setCsrf(null);
      setMe(null);
    };
    window.addEventListener('ipl:unauthenticated', onUnauth);
    return () => window.removeEventListener('ipl:unauthenticated', onUnauth);
  }, [refresh]);

  if (checking) return <Spinner />;

  // ---- Visitante sem sessão
  if (!me) {
    return (
      <PublicShell config={config}>
        <Routes>
          <Route path="/cadastro" element={<SignupPage config={config} />} />
          <Route path="/termos" element={<TermsPage />} />
          <Route path="/denunciar" element={<AbusePage />} />
          <Route path="/nota/:id" element={<NotePage />} />
          <Route path="*" element={<LoginPage onLoggedIn={refresh} config={config} />} />
        </Routes>
      </PublicShell>
    );
  }

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setCsrf(null);
      setMe(null);
      navigate('/');
    }
  };

  // ---- Senha temporária: troca obrigatória antes de qualquer outra tela
  if (me.mustChangePassword) {
    return (
      <SessionContext.Provider value={{ me, config }}>
        <PublicShell config={config}>
          <AccountPage forced onChanged={refresh} onLogout={logout} />
        </PublicShell>
      </SessionContext.Provider>
    );
  }

  const nav = me.role === 'admin' ? NAV_ADMIN : NAV_USER;
  const admin = me.role === 'admin';

  return (
    <SessionContext.Provider value={{ me, config }}>
      <div className="flex min-h-full flex-col md:flex-row">
        <a href="#conteudo" className="skip-link">Ir para o conteúdo</a>
        <aside className="border-b p-3 md:w-60 md:shrink-0 md:border-b-0 md:border-r md:p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div className="mb-3 md:mb-6">
            <div className="text-base font-bold">IP Logger</div>
            <div className="text-xs" style={{ color: 'var(--muted)' }}>Security Center</div>
          </div>
          <nav aria-label="Principal" className="flex flex-wrap gap-1 md:flex-col">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className="rounded-lg px-3 py-2 text-sm font-medium"
                style={({ isActive }) => ({ background: isActive ? 'var(--surface-2)' : 'transparent', color: isActive ? 'var(--accent)' : 'var(--text)', textDecoration: 'none' })}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="mt-4 border-t pt-3 text-xs md:mt-8" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
            <div className="mb-1 break-all">{me.email}</div>
            <div className="mb-2">{admin ? 'Administrador' : 'Usuário'}</div>
            <button onClick={logout} className="underline">Sair</button>
          </div>
        </aside>
        <main id="conteudo" className="min-w-0 flex-1 p-4 md:p-8">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/links" element={<LinksPage />} />
            <Route path="/eventos" element={<EventsPage />} />
            <Route path="/eventos/:id" element={<EventDetailPage />} />
            <Route path="/ips/:ip" element={<IpPage />} />
            <Route path="/alertas" element={<AlertsPage />} />
            <Route path="/conta" element={<AccountPage onChanged={refresh} onLogout={logout} />} />
            <Route path="/ferramentas" element={<ToolsPage />} />
            <Route path="/nota/:id" element={<NotePage />} />
            <Route path="/termos" element={<TermsPage />} />
            <Route path="/denunciar" element={<AbusePage />} />
            {admin && <Route path="/usuarios" element={<UsersPage />} />}
            {admin && <Route path="/denuncias" element={<ReportsPage />} />}
            {admin && <Route path="/configuracoes" element={<SettingsPage />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <Footer config={config} />
        </main>
      </div>
    </SessionContext.Provider>
  );
}
