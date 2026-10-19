import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { ApiError, api, setCsrf } from './api';
import { Spinner } from './ui';
import { AlertsPage } from './pages/Alerts';
import { EventDetailPage } from './pages/EventDetail';
import { EventsPage } from './pages/Events';
import { IpPage } from './pages/Ip';
import { LinksPage } from './pages/Links';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { SettingsPage } from './pages/Settings';

interface Me {
  email: string;
}

const NAV = [
  { to: '/', label: 'Visão geral', end: true },
  { to: '/links', label: 'Links' },
  { to: '/eventos', label: 'Eventos' },
  { to: '/alertas', label: 'Alertas' },
  { to: '/configuracoes', label: 'Configurações e saúde' },
];

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ email: string; csrfToken: string }>('/auth/me');
      setCsrf(r.csrfToken);
      setMe({ email: r.email });
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
    const onUnauth = () => {
      setCsrf(null);
      setMe(null);
    };
    window.addEventListener('ipl:unauthenticated', onUnauth);
    return () => window.removeEventListener('ipl:unauthenticated', onUnauth);
  }, [refresh]);

  if (checking) return <Spinner />;
  if (!me) return <LoginPage onLoggedIn={refresh} />;

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setCsrf(null);
      setMe(null);
      navigate('/');
    }
  };

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <a href="#conteudo" className="skip-link">Ir para o conteúdo</a>
      <aside className="border-b p-3 md:w-60 md:shrink-0 md:border-b-0 md:border-r md:p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="mb-3 flex items-center justify-between md:mb-6 md:block">
          <div>
            <div className="text-base font-bold">IP Logger</div>
            <div className="text-xs" style={{ color: 'var(--muted)' }}>Security Center</div>
          </div>
        </div>
        <nav aria-label="Principal" className="flex flex-wrap gap-1 md:flex-col">
          {NAV.map((n) => (
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
          <div className="mb-2 break-all">{me.email}</div>
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
          <Route path="/configuracoes" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
