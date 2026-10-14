import { useCallback, useEffect, useState } from 'react';
import { api } from './api/client';
import { navigate, useHashRoute } from './router';
import { AppLayout } from './layouts/AppLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Containers from './pages/Containers';
import ContainerDetail from './pages/ContainerDetail';
import Devices from './pages/Devices';
import Tasks from './pages/Tasks';
import Schedules from './pages/Schedules';
import Settings from './pages/Settings';

const PAGES = {
  dashboard: Dashboard,
  containers: Containers,
  'containers-detail': (props) => <ContainerDetail containerId={props.params.id} />,
  devices: Devices,
  tasks: Tasks,
  schedules: Schedules,
  settings: Settings,
};

export function App() {
  const { page, params } = useHashRoute();
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);

  // Restore session from the HttpOnly cookie via /api/auth/me (real API).
  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/auth/me')
      .then((res) => {
        if (!cancelled) setUser(res.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // session may already be gone — local state still resets
    }
    setUser(null);
    navigate('/');
  }, []);

  if (booting) {
    return (
      <div className="login-screen">
        <div className="card">Loading…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <Login
        onLogin={(nextUser) => {
          setUser(nextUser);
          navigate('/');
        }}
      />
    );
  }

  const Page = PAGES[page] ?? Dashboard;
  return (
    <AppLayout user={user} onLogout={handleLogout}>
      <Page params={params} />
    </AppLayout>
  );
}

export default App;
