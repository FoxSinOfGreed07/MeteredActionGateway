import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { ActionState } from '../../../db/schema.js';
import { GatewayError } from '../../../shared/errors.js';
import { getActionForTenant, getActionLedger, getEvents, listActions } from '../../actions/repo.js';
import { ACTION_STATES } from '../../actions/state-machine.js';
import { submitAction } from '../../actions/submit.js';
import { toActionDetail, toActionView } from '../../actions/view.js';
import type { GatewayContext } from '../../context.js';
import type { AppEnv } from '../types.js';

const SubmitBody = z.object({ action_type: z.string().min(1).max(64), payload: z.unknown() });

export function actionRoutes(ctx: GatewayContext) {
  const r = new Hono<AppEnv>();

  r.post('/', async (c) => {
    const key = c.req.header('idempotency-key');
    if (!key || key.length > 255) {
      throw new GatewayError(
        'missing_idempotency_key',
        400,
        'Idempotency-Key header (1–255 chars) is required',
      );
    }
    const raw = await c.req.json().catch(() => {
      throw new GatewayError('invalid_request', 400, 'body must be JSON');
    });
    const body = SubmitBody.parse(raw);
    const res = await submitAction(ctx, {
      tenant: c.get('tenant'),
      actionType: body.action_type,
      payload: body.payload,
      idempotencyKey: key,
    });
    if (res.replayed) c.header('Idempotent-Replayed', 'true');
    // Echo the STORED body — never recompute anything at replay time.
    return c.json(res.body as object, res.status as ContentfulStatusCode);
  });

  r.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) throw new GatewayError('not_found', 404, 'action not found');
    const action = await getActionForTenant(ctx.db, c.get('tenant').id, id);
    if (!action) throw new GatewayError('not_found', 404, 'action not found');
    const [events, ledger] = await Promise.all([getEvents(ctx.db, id), getActionLedger(ctx.db, id)]);
    return c.json(toActionDetail(action, events, ledger));
  });

  r.get('/', async (c) => {
    const state = c.req.query('state');
    if (state && !ACTION_STATES.includes(state as ActionState)) {
      throw new GatewayError('invalid_request', 400, `state must be one of ${ACTION_STATES.join(', ')}`);
    }
    const limit = Number(c.req.query('limit') ?? 50);
    const rows = await listActions(ctx.db, c.get('tenant').id, {
      ...(state ? { state: state as ActionState } : {}),
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return c.json({ actions: rows.map(toActionView) });
  });

  return r;
}
