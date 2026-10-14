/**
 * Task execution engine — the agentic loop that turns one BullMQ job into a
 * finished TaskRun (施工 MD §11.2-§11.8).
 *
 * Responsibilities (all state in the DB — the queue is transport only):
 *   - start guards (stale / pre-start cancel) via TaskRunService.startAttempt
 *   - provider chat rounds with an abort signal (cancel + timeout = REAL stop)
 *   - tool loop: validate → safety-class gate → (approval wait) → execute
 *   - auto-retry on transient provider errors (bounded, backoff, new attempt)
 *   - terminal writes: finishRun / markCancelled (idempotent)
 *   - event stream: provider_request/response, tool_call/result, retry, ...
 *
 * The engine NEVER touches Docker. Tool handlers are injected (they call the
 * API over HTTP with a service token; the API enforces RBAC + managed gate).
 */
import {
  TASK_EVENT,
  TASK_DEFAULTS,
  PROVIDER_ERROR,
  ProviderError,
  TOOL_REGISTRY,
  findTool,
  validateToolArgs,
  scrubObject,
  safeStringify,
  truncateText,
  backoffDelay,
} from '@water-army/shared';

import { toolGate } from './tool-helpers.js';

const SYSTEM_PROMPT = (tools) =>
  [
    'You are the ops assistant for water_army, a Docker fleet management system.',
    'Answer with a short, factual summary. Use the provided tools when they help; never invent data.',
    'If a tool fails or a human rejects an action, report that honestly and stop.',
    tools.length
      ? `Available tools: ${tools.map((t) => t.name).join(', ')}.`
      : 'No tools are available for this task; answer from the prompt alone.',
  ].join(' ');

/**
 * @param {object} deps
 * @param {object} deps.db prisma client (or fake)
 * @param {object} deps.taskSvc TaskRunService (createTaskRunService result)
 * @param {object} [deps.config] { taskDefaultTimeoutMs, taskMaxTimeoutMs, taskDefaultAttempts, approvalPollMs, cancelPollMs }
 * @param {object} [deps.log]
 * @param {Function} deps.providerResolver ({db, run, env}) => provider (may throw ProviderError)
 * @param {Object<string,Function>} deps.toolHandlers name → async (args) => result
 * @param {object} [deps.env] process env (provider selection)
 */
export function createTaskEngine({ db, taskSvc, config = {}, log = console, providerResolver, toolHandlers, env = process.env }) {
  const taskDefaultTimeoutMs = config.taskDefaultTimeoutMs ?? 120_000;
  const taskMaxTimeoutMs = config.taskMaxTimeoutMs ?? 900_000;
  const taskDefaultAttempts = config.taskDefaultAttempts ?? 3;
  const approvalPollMs = config.approvalPollMs ?? 1_000;
  const cancelPollMs = config.cancelPollMs ?? 1_000;

  /**
   * Process one BullMQ job { runId, attempt }. Returns an outcome descriptor
   * (for worker metrics/logging) — the DB is the source of truth either way.
   */
  async function handleJob(job) {
    const { runId, attempt } = job.data;
    const started = await taskSvc.startAttempt(runId, attempt);
    if (started.status === 'stale') {
      log.info?.({ runId, jobAttempt: attempt, reason: started.reason }, 'engine: job stale, no-op');
      return { outcome: 'stale', runId };
    }
    if (started.status === 'cancelled') {
      return { outcome: 'cancelled', runId };
    }

    const run = started.run;
    const input = run.inputJson ?? {};
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    const maxAttempts = Math.min(Math.max(input.maxAttempts ?? taskDefaultAttempts, 1), TASK_DEFAULTS.MAX_ATTEMPTS_CAP);
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? taskDefaultTimeoutMs, 1_000), taskMaxTimeoutMs);

    // ---- abort plumbing: cancel + timeout are BOTH real stops ------------
    const ac = new AbortController();
    let cancelRequested = false;
    let deadlineHit = false;
    const deadlineTimer = setTimeout(() => {
      deadlineHit = true;
      ac.abort(new Error('run deadline reached'));
    }, timeoutMs);

    // NOTE: sleep RESOLVES (never rejects) when the run is aborted — callers
    // re-check `ac.signal.aborted` (loop tops / waitForApproval) and steer to
    // the terminal path. A rejecting sleep would leak raw 'aborted' errors
    // out of handleJob (regression caught in P3 gen2: cancel-while-waiting-approval).
    const sleep = (ms) =>
      new Promise((resolve) => {
        if (ac.signal.aborted) return resolve();
        const t = setTimeout(() => {
          ac.signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clearTimeout(t);
          resolve();
        };
        ac.signal.addEventListener('abort', onAbort, { once: true });
      });

    async function pollCancel() {
      // MD §11.3: cancel 要真停 — the API only sets cancel_requested in the DB;
      // the worker observes it (job-entry check + periodic poll + per-round)
      // and aborts the in-flight work.
      try {
        const row = await db.taskRun.findUnique({ where: { id: runId }, select: { status: true } });
        if (row?.status === 'cancel_requested' && !cancelRequested) {
          cancelRequested = true;
          ac.abort(new Error('cancel requested'));
        }
      } catch {
        /* DB blip: keep polling on the next tick */
      }
    }
    const cancelTimer = setInterval(pollCancel, cancelPollMs);

    const finish = async (what) => {
      try {
        return await what;
      } catch (err) {
        // Terminal writes must not throw back into the queue (a failed write
        // is logged; the run stays where it is — reconcile/ops can repair).
        log.error?.({ err, runId }, 'engine: terminal write failed');
        return null;
      }
    };

    /**
     * Poll the approval row until a human decides, or the run is cancelled /
     * hits its deadline (which expires the pending approvals).
     * @returns {Promise<{type:'approved'|'rejected'|'cancelled'|'timeout', reason?:string|null}>}
     */
    async function waitForApproval(approvalId) {
      while (true) {
        if (ac.signal.aborted) {
          const type = cancelRequested ? 'cancelled' : 'timeout';
          await finish(taskSvc.expirePendingApprovals(runId));
          return { type };
        }
        let row = null;
        try {
          row = await db.approvalRequest.findUnique({ where: { id: approvalId } });
        } catch {
          /* DB blip: poll again */
        }
        if (row && row.status === 'approved') return { type: 'approved' };
        if (row && row.status === 'rejected') return { type: 'rejected', reason: row.reviewNote };
        if (row && row.status === 'expired') return { type: 'timeout' };
        await sleep(approvalPollMs);
      }
    }

    // Outer try/finally guarantees the abort timer/interval are ALWAYS released
    // — including early-return paths. Regression (P3 gen2): the resolver-failure
    // early return skipped cleanup, leaking a 1s cancel interval + 120s timer
    // that kept the worker process alive forever.
    try {
      let provider;
      try {
        provider = await providerResolver({ db, run, env, log });
      } catch (err) {
        const code = err instanceof ProviderError ? err.apiCode : 'PROVIDER_NOT_CONFIGURED';
        await finish(
          taskSvc.finishRun(runId, {
            status: 'failed',
            errorCode: code,
            errorMessage: err.message?.slice(0, 1000) ?? 'provider unavailable',
            attempt,
          }),
        );
        return { outcome: 'failed', runId, code };
      }

    // ---- tool selection (input.tools allowlist, else all enabled) --------
    let toolDefs;
    const requested = Array.isArray(input.tools) && input.tools.length > 0 ? input.tools : null;
    if (requested) {
      toolDefs = requested.map((n) => findTool(n)).filter(Boolean);
      const dropped = requested.filter((n) => !findTool(n));
      if (dropped.length) {
        log.warn?.({ runId, dropped }, 'engine: unknown tools in allowlist dropped');
        await taskSvc
          .recordEvent(runId, TASK_EVENT.TOOL_CALL, {
            message: `tools unavailable, dropped: ${dropped.join(', ')}`,
            payload: { dropped },
            attempt,
          })
          .catch(() => {});
      }
    } else {
      toolDefs = TOOL_REGISTRY.filter((t) => toolGate(t).allowed);
    }
    const openAITools = toolDefs.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT(toolDefs) },
      { role: 'user', content: prompt },
    ];
    const usageTotals = {};
    const addUsage = (u) => {
      if (!u || typeof u !== 'object') return;
      for (const [k, v] of Object.entries(u)) {
        if (Number.isFinite(v)) usageTotals[k] = (usageTotals[k] ?? 0) + v;
      }
    };

    let currentAttempt = attempt;
    let rounds = 0;
    let toolCallCount = 0;

    const abortedBecause = () => (cancelRequested ? 'cancelled' : deadlineHit ? 'timed_out' : 'aborted');

      // ============================================================ main loop
      while (true) {
        if (rounds >= TASK_DEFAULTS.MAX_TOOL_ROUNDS) {
          await finish(
            taskSvc.finishRun(runId, {
              status: 'failed',
              errorCode: 'TOOL_LOOP_LIMIT',
              errorMessage: `no stop after ${TASK_DEFAULTS.MAX_TOOL_ROUNDS} tool rounds`,
              attempt: currentAttempt,
              usage: usageTotals,
            }),
          );
          return { outcome: 'failed', runId, code: 'TOOL_LOOP_LIMIT' };
        }
        rounds += 1;
        await pollCancel();
        if (ac.signal.aborted) break;

        // ---------------- provider round ----------------
        await taskSvc.recordEvent(runId, TASK_EVENT.PROVIDER_REQUEST, {
          message: `round ${rounds} (attempt ${currentAttempt})`,
          payload: { round: rounds, attempt: currentAttempt, messages: messages.length, tools: openAITools.length },
          attempt: currentAttempt,
        });
        let result;
        try {
          result = await provider.chat({
            messages,
            tools: openAITools,
            signal: ac.signal,
            onEvent: (e) => {
              if (e.type === 'provider_retry') {
                log.info?.({ runId, round: rounds, delayMs: e.delayMs }, 'provider-level retry (inside adapter)');
              }
            },
          });
        } catch (err) {
          if (err instanceof ProviderError && err.apiCode === PROVIDER_ERROR.ABORTED) {
            break; // cancel/timeout → terminal handling below
          }
          if (err instanceof ProviderError && err.retryable && currentAttempt < maxAttempts) {
            const delayMs = backoffDelay(currentAttempt);
            // bumpAttempt writes the single authoritative retry event
            // (the engine must not double-record the attempt bump).
            const bumped = await taskSvc.bumpAttempt(runId, {
              expectedAttempt: currentAttempt,
              code: err.apiCode,
              delayMs,
              reason: err.message?.slice(0, 300) ?? null,
            });
            currentAttempt = bumped.attempt;
            try {
              await sleep(delayMs);
            } catch {
              break; // aborted during backoff
            }
            continue; // next round, same job, new attempt number
          }
          const code = err instanceof ProviderError ? err.apiCode : PROVIDER_ERROR.GENERIC;
          await finish(
            taskSvc.finishRun(runId, {
              status: 'failed',
              errorCode: code,
              errorMessage: err.message?.slice(0, 1000) ?? 'provider error',
              attempt: currentAttempt,
              usage: usageTotals,
            }),
          );
          return { outcome: 'failed', runId, code };
        }

        addUsage(result.usage);
        await taskSvc.recordEvent(runId, TASK_EVENT.PROVIDER_RESPONSE, {
          message: `round ${rounds} finish=${result.finishReason}`,
          payload: {
            round: rounds,
            attempt: currentAttempt,
            finishReason: result.finishReason,
            model: result.model ?? null,
            contentPreview: truncateText(result.content ?? '', 500),
            usage: scrubObject(result.usage ?? null, TASK_DEFAULTS.EVENT_PREVIEW_CHARS),
            toolCalls: (result.toolCalls ?? []).map((tc) => tc.name),
          },
          attempt: currentAttempt,
        });

        // ---------------- stop ----------------
        if (result.finishReason === 'stop') {
          const content = result.content ?? '';
          await finish(
            taskSvc.finishRun(runId, {
              status: 'succeeded',
              resultText: content,
              resultJson: { model: result.model ?? provider.model ?? null, rounds, toolCalls: toolCallCount, usage: usageTotals },
              attempt: currentAttempt,
              usage: usageTotals,
              preview: truncateText(content, 500),
            }),
          );
          return { outcome: 'succeeded', runId, chars: content.length, toolCalls: toolCallCount, attempts: currentAttempt };
        }

        // ---------------- tool calls ----------------
        const calls = result.toolCalls ?? [];
        if (result.finishReason !== 'tool_calls' || calls.length === 0) {
          await finish(
            taskSvc.finishRun(runId, {
              status: 'failed',
              errorCode: 'PROVIDER_BAD_FINISH',
              errorMessage: `finishReason '${result.finishReason}' with no content and no tool calls`,
              attempt: currentAttempt,
              usage: usageTotals,
            }),
          );
          return { outcome: 'failed', runId, code: 'PROVIDER_BAD_FINISH' };
        }

        messages.push({
          role: 'assistant',
          content: result.content ?? null,
          tool_calls: calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
          })),
        });

        let hardAbort = false;
        for (const tc of calls) {
          await pollCancel();
          if (ac.signal.aborted) {
            hardAbort = true;
            break;
          }
          toolCallCount += 1;
          const tool = findTool(tc.name);
          let toolMsg; // object fed back to the model
          let executed = false;
          let validatedArgs = null;

          if (!tool) {
            toolMsg = { ok: false, error: { code: 'tool_unavailable', message: `unknown tool '${tc.name}'` } };
          } else {
            const gate = toolGate(tool);
            if (!gate.allowed) {
              toolMsg = { ok: false, error: { code: 'tool_disabled', message: gate.reason } };
            } else {
              const validation = validateToolArgs(tool.parameters, tc.arguments);
              if (!validation.ok) {
                toolMsg = { ok: false, error: { code: 'invalid_arguments', errors: validation.errors } };
              } else {
                validatedArgs = validation.value;
                if (!gate.auto) {
                  // MD §11.4: approval_required — wait for a REAL human.
                  const approval = await taskSvc.createApproval({
                    runId,
                    toolName: tool.name,
                    arguments: validatedArgs,
                    preview: truncateText(safeStringify(validatedArgs), 500),
                  });
                  await taskSvc.setWaitingApproval(runId, { approvalId: approval.id, toolName: tool.name, attempt: currentAttempt });
                  const decision = await waitForApproval(approval.id);
                  if (decision.type === 'cancelled' || decision.type === 'timeout') {
                    hardAbort = true;
                    break; // terminal handled below
                  }
                  await taskSvc.resumeFromApproval(runId);
                  if (decision.type === 'rejected') {
                    toolMsg = { ok: false, error: { code: 'approval_rejected', message: decision.reason ?? 'rejected by human' } };
                  } else {
                    executed = true;
                  }
                } else {
                  executed = true;
                }
              }
            }
          }

          if (executed) {
            await taskSvc.recordEvent(runId, TASK_EVENT.TOOL_CALL, {
              message: tool.name,
              payload: { tool: tool.name, arguments: scrubObject(validatedArgs, TASK_DEFAULTS.EVENT_PREVIEW_CHARS) },
              attempt: currentAttempt,
            });
            try {
              const handler = toolHandlers[tool.name];
              if (typeof handler !== 'function') {
                toolMsg = { ok: false, error: { code: 'tool_disabled', message: 'no handler registered' } };
              } else {
                toolMsg = await handler(validatedArgs);
              }
            } catch (err) {
              // A tool failure is NOT a run failure (MD §11.4): feed the error
              // back so the model can report it.
              toolMsg = { ok: false, error: { code: err.apiCode ?? 'TOOL_ERROR', message: err.message?.slice(0, 500) } };
            }
            await taskSvc.recordEvent(runId, TASK_EVENT.TOOL_RESULT, {
              message: toolMsg?.ok ? `${tool.name} ok` : `${tool.name} error: ${toolMsg?.error?.code}`,
              payload: { tool: tool.name, ok: !!toolMsg?.ok, preview: truncateText(safeStringify(toolMsg), 800) },
              attempt: currentAttempt,
            });
          } else if (toolMsg) {
            // pre-execution rejection (unknown/disabled/invalid/rejected): record
            await taskSvc.recordEvent(runId, toolMsg.error?.code === 'approval_rejected' ? TASK_EVENT.TOOL_RESULT : TASK_EVENT.TOOL_CALL, {
              message: toolMsg.error?.code === 'approval_rejected' ? `${tc.name} approval rejected` : `${tc.name} rejected pre-execution: ${toolMsg.error?.code}`,
              payload: {
                tool: tc.name,
                ok: false,
                errorCode: toolMsg.error?.code ?? null,
                reason: toolMsg.error?.message ?? null,
                arguments: scrubObject(tc.arguments, TASK_DEFAULTS.EVENT_PREVIEW_CHARS),
              },
              attempt: currentAttempt,
            });
          }

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: truncateText(safeStringify(toolMsg ?? { ok: false, error: { code: 'TOOL_ERROR', message: 'no result' } }), TASK_DEFAULTS.TOOL_RESULT_CHARS),
          });
          if (hardAbort) break;
        }
        if (hardAbort) break;
        // else: loop → next provider round
      }

      // ============================ abort / cancelled / timed out =========
      if (ac.signal.aborted) {
        const why = abortedBecause();
        if (cancelRequested) {
          await finish(taskSvc.markCancelled(runId, { reason: 'cancelled_during_run', attempt: currentAttempt }));
          return { outcome: 'cancelled', runId, reason: why };
        }
        if (deadlineHit) {
          await finish(
            taskSvc.finishRun(runId, {
              status: 'timed_out',
              errorCode: 'TIMEOUT',
              errorMessage: `exceeded ${timeoutMs}ms run deadline`,
              attempt: currentAttempt,
              usage: usageTotals,
            }),
          );
          return { outcome: 'timed_out', runId, timeoutMs };
        }
        await finish(
          taskSvc.finishRun(runId, {
            status: 'failed',
            errorCode: 'ABORTED',
            errorMessage: 'execution aborted',
            attempt: currentAttempt,
            usage: usageTotals,
          }),
        );
        return { outcome: 'failed', runId, code: 'ABORTED' };
      }
      // Fallback: loop exited without a terminal (defensive; should not happen).
      await finish(
        taskSvc.finishRun(runId, {
          status: 'failed',
          errorCode: 'ENGINE_LOOP_EXIT',
          errorMessage: 'engine loop exited without a terminal state',
          attempt: currentAttempt,
        }),
      );
      return { outcome: 'failed', runId, code: 'ENGINE_LOOP_EXIT' };
    } finally {
      clearTimeout(deadlineTimer);
      clearInterval(cancelTimer);
    }
  }

  return { handleJob };
}
