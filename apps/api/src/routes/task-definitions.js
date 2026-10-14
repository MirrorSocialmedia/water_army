/**
 * Task definitions — READ-ONLY list (施工 MD §8 `GET /api/tasks/definitions`).
 *
 * P4 adds the GET (needed by the Schedules UI to pick the task a schedule
 * fires). POST/PATCH for definitions are out of P4 scope (MD §8 lists them;
 * they remain for a later phase).
 */

export function taskDefinitionRoutes(app) {
  const db = () => app.db;

  function publicDefinition(d, provider) {
    return {
      id: d.id,
      title: d.title,
      description: d.description ?? null,
      taskType: d.taskType,
      mode: d.mode,
      provider: provider?.name ?? null,
      providerEnabled: provider?.isEnabled ?? false,
      promptTemplate: d.promptTemplate,
      timeoutMs: d.timeoutMs,
      maxAttempts: d.maxAttempts,
      concurrencyKey: d.concurrencyKey ?? null,
      requiresApproval: d.requiresApproval,
      createdAt: d.createdAt ?? null,
      updatedAt: d.updatedAt ?? null,
    };
  }

  app.get(
    '/api/tasks/definitions',
    { preHandler: app.requireRole('viewer') },
    async () => {
      const defs = await db().taskDefinition.findMany({ orderBy: { createdAt: 'asc' } });
      const items = [];
      for (const d of defs) {
        const provider = await db().providerConfig.findUnique({ where: { id: d.providerConfigId } });
        items.push(publicDefinition(d, provider));
      }
      return { items, total: items.length };
    },
  );
}
