import { useCallback, useEffect, useState } from 'react';
import { api } from './api/client';
import { navigate, useHashRoute } from './router';
import { AppLayout } from './layouts/AppLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Containers from './pages/Containers';
import ContainerDetail from './pages/ContainerDetail';
import Devices from './pages/Devices';
import DeviceDetail from './pages/DeviceDetail';
import DeviceConsole from './pages/DeviceConsole';
import FleetConsole from './pages/FleetConsole';
import Tasks from './pages/Tasks';
import TaskDetail from './pages/TaskDetail';
import Schedules from './pages/Schedules';
import BatchPlanner from './pages/BatchPlanner';
import BatchMonitor from './pages/BatchMonitor';
import Identities from './pages/Identities';
import IdentityDetail from './pages/IdentityDetail';
import BatchReports from './pages/BatchReports';
import RamGate from './pages/RamGate';
import Settings from './pages/Settings';

const PAGES = {
  dashboard: Dashboard,
  containers: Containers,
  'containers-detail': (props) => <ContainerDetail containerId={props.params.id} />,
  devices: Devices,
  'devices-detail': (props) => <DeviceDetail deviceId={props.params.id} />,
  'devices-console': (props) => <DeviceConsole deviceId={props.params.id} />,
  'devices-fleet': (props) => <FleetConsole user={props.user} />,
  tasks: Tasks,
  'tasks-detail': (props) => <TaskDetail runId={props.params.id} />,
  schedules: Schedules,
  batches: BatchPlanner,
  monitor: BatchMonitor,
  identities: Identities,
  'identities-detail': (props) => <IdentityDetail identityId={props.params.id} user={props.user} />,
  reports: BatchReports,
  'ram-gate': (props) => <RamGate user={props.user} />,
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
      <Page params={params} user={user} />
    </AppLayout>
  );
}

export default App;
