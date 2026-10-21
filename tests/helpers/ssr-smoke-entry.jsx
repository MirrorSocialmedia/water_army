/**
 * BR-B5 S4 — SSR render smoke entry.
 *
 * Rendered by tests/integration/web-ssr-render.test.js through vite's
 * ssrLoadModule (the repo has no frontend test toolchain — the P0 ADR
 * keeps the lockfile minimal, so this reuses vite + react-dom/server,
 * both already in the web workspace). Effects do NOT run in SSR, so every
 * page renders its real initial state (loading frame) with zero network.
 */
import { renderToStaticMarkup } from 'react-dom/server';

import { App } from '../../apps/web/src/App.jsx';
import BatchPlanner from '../../apps/web/src/pages/BatchPlanner.jsx';
import BatchMonitor from '../../apps/web/src/pages/BatchMonitor.jsx';
import Identities from '../../apps/web/src/pages/Identities.jsx';
import IdentityDetail from '../../apps/web/src/pages/IdentityDetail.jsx';
import BatchReports from '../../apps/web/src/pages/BatchReports.jsx';

const user = { username: 'smoke', role: 'admin' };

export const renders = {
  app: renderToStaticMarkup(<App />),
  planner: renderToStaticMarkup(<BatchPlanner user={user} />),
  monitor: renderToStaticMarkup(<BatchMonitor user={user} />),
  identities: renderToStaticMarkup(<Identities user={user} />),
  identityDetail: renderToStaticMarkup(<IdentityDetail identityId='0123456789abcdef01234567' user={user} />),
  reports: renderToStaticMarkup(<BatchReports user={user} />),
};
