/**
 * W2 (ADR-026) — device app lifecycle + UI-tree routes.
 *
 *   GET    /api/devices/redroid/:id/apps               viewer+   pm list packages
 *   GET    /api/devices/redroid/:id/apps/:package      viewer+   version/existence
 *   GET    /api/devices/redroid/:id/foreground         viewer+   focus probe (proxy metric)
 *   POST   /api/devices/redroid/:id/apps/install       operator  managed-dir APK install
 *   DELETE /api/devices/redroid/:id/apps/:package      operator  pm uninstall
 *   POST   /api/devices/redroid/:id/ui/dump            operator  uiautomator dump + parse
 *   POST   /api/devices/redroid/:id/ui/tap             operator  dump → selector → tap
 *
 * RBAC follows the devices matrix (reads = viewer+, mutations = operator+).
 * Audit lives in the service (action prefix app.device.*).
 *
 * The whole surface fails closed with 503 APP_OPS_DISABLED until
 * WA_APP_OPS_ENABLED is on (W1 lesson: new behaviour ships OFF-by-default;
 * real-device evidence matrix pending — ADR-026 §5).
 *
 * Login-state scope honesty: `foreground` returns package+activity ONLY —
 * never a login verdict (ADR-026 §3).
 */

const DEVICE_ID = { type: 'string', minLength: 1, maxLength: 64 };
const PACKAGE_PARAM = { type: 'string', pattern: '^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$', maxLength: 128 };

const PARAMS = {
  params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: DEVICE_ID } },
};
const PARAMS_PKG = {
  params: { type: 'object', additionalProperties: false, required: ['id', 'package'], properties: { id: DEVICE_ID, package: PACKAGE_PARAM } },
};

const INSTALL_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['fileName'],
  properties: {
    // flat managed-dir file name — no separators, no '..', .apk suffix
    fileName: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\\.apk$', maxLength: 104 },
  },
};

const SELECTOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    resourceId: { type: 'string', minLength: 1, maxLength: 256 },
    text: { type: 'string', minLength: 1, maxLength: 256 },
    textContains: { type: 'string', minLength: 1, maxLength: 256 },
    contentDesc: { type: 'string', minLength: 1, maxLength: 256 },
    contentDescContains: { type: 'string', minLength: 1, maxLength: 256 },
    className: { type: 'string', minLength: 1, maxLength: 256 },
    clickable: { type: 'boolean' },
  },
};

const TAP_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['selector'],
  properties: { selector: SELECTOR_SCHEMA },
};

const LIST_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: { filter: PACKAGE_PARAM },
};

const actorOf = (req) => ({ actorUserId: req.user.id, requestId: req.id, ip: req.ip });

/** Fail-closed switch guard (503 until WA_APP_OPS_ENABLED — ADR-026). */
function requireAppOpsEnabled(app, req, reply) {
  if (app.config?.waAppOpsEnabled !== true) {
    reply.code(503).send({
      error: { code: 'APP_OPS_DISABLED', message: 'app-layer ops (W2) are disabled on this host — set WA_APP_OPS_ENABLED=true after reviewing ADR-026 (real-device matrix NOT VERIFIED)' },
    });
    return false;
  }
  return true;
}

export function deviceAppRoutes(app) {
  app.get(
    '/api/devices/redroid/:id/apps',
    { preHandler: app.requireRole('viewer'), schema: { params: PARAMS.params, querystring: LIST_QUERY } },
    async (req, reply) => {
      if (!requireAppOpsEnabled(app, req, reply)) return undefined;
      return app.appService.listPackages(req.params.id, { filter: req.query.filter, actor: actorOf(req) });
    },
  );

  app.get(
    '/api/devices/redroid/:id/apps/:package',
    { preHandler: app.requireRole('viewer'), schema: PARAMS_PKG },
    async (req, reply) => {
      if (!requireAppOpsEnabled(app, req, reply)) return undefined;
      return app.appService.packageInfo(req.params.id, req.params.package, { actor: actorOf(req) });
    },
  );

  app.get(
    '/api/devices/redroid/:id/foreground',
    { preHandler: app.requireRole('viewer'), schema: PARAMS },
    async (req, reply) => {
      if (!requireAppOpsEnabled(app, req, reply)) return undefined;
      return app.appService.foregroundApp(req.params.id, { actor: actorOf(req) });
    },
  );

  app.post(
    '/api/devices/redroid/:id/apps/install',
    { preHandler: app.requireRole('operator'), schema: { params: PARAMS.params, body: INSTALL_BODY } },
    async (req, reply) => {
      if (!requireAppOpsEnabled(app, req, reply)) return undefined;
      return app.appService.installApk(req.params.id, { fileName: req.body.fileName, actor: actorOf(req) });
    },
  );

  app.delete(
    '/api/devices/redroid/:id/apps/:package',
    { preHandler: app.requireRole('operator'), schema: PARAMS_PKG },
    async (req, reply) => {
      if (!requireAppOpsEnabled(app, req, reply)) return undefined;
      return app.appService.uninstallApp(req.params.id, { packageName: req.params.package, actor: actorOf(req) });
    },
  );

  app.post(
    '/api/devices/redroid/:id/ui/dump',
    { preHandler: app.requireRole('operator'), schema: PARAMS },
    async (req, reply) => {
      if (!requireAppOpsEnabled(app, req, reply)) return undefined;
      return app.appService.dumpUi(req.params.id, { actor: actorOf(req) });
    },
  );

  app.post(
    '/api/devices/redroid/:id/ui/tap',
    { preHandler: app.requireRole('operator'), schema: { params: PARAMS.params, body: TAP_BODY } },
    async (req, reply) => {
      if (!requireAppOpsEnabled(app, req, reply)) return undefined;
      return app.appService.tapBySelector(req.params.id, { selector: req.body.selector, actor: actorOf(req) });
    },
  );
}
