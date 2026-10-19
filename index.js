/**
 * dsh-context-window-picker — host half.
 *
 * Gives one session a temporary context-window override without touching the
 * Profile's `llm-pi-ai` / `llm-deepseek` catalog defaults. A new session always
 * starts back at the catalog value.
 *
 * How the override reaches the request without re-implementing the agent loop:
 *  1. The public `llm` service methods `prepareCall` / `resolveModelInfo`
 *     (prototype-patched, restored on unload) resolve the adapter model info for
 *     the active session's provider/model, shrink `context.contextWindow` to the
 *     override and clamp `defaultMaxTokens` accordingly.
 *  2. `prepareCall` gets an extra `configure` callback, which is the supported
 *     seam for changing `maxTokens` while the frozen prepared call stays
 *     internally consistent (the adapter `stream()` asserts that the request
 *     config equals the resolved config).
 *  3. `Session#requestHeader` is clamped for the active session so the
 *     compaction policy (`compaction-basic`) never sees an old, too-large
 *     completion reservation against the smaller window.
 *
 * The override is keyed by session id; nothing is written to the Profile
 * configuration and nothing survives a new session.
 */

const API_PREFIX = '/dsh-context-window-picker/api';
const MAX_REQUEST_BODY = 64 * 1024;
const MAX_TRACKED_SESSIONS = 512;
const MIN_COMPLETION_TOKENS = 256;
const DEFAULT_PRESETS = [131072, 262144, 524288, 1048576];
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,200}$/;
const LOOPBACK_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export const name = 'dsh-context-window-picker';

/** The LLM registry/stream service and the Agent registry (for session attribution). */
export const inject = ['llm', 'agents'];

export function apply(ctx, config) {
  const settings = normalizeSettings(config);
  /** sessionId -> requested context window */
  const overrides = new Map();
  /** sessionId -> { effective, maxTokens } derived from the last resolution */
  const resolved = new Map();
  const headerPatches = new Map();
  const diagnostics = {
    prepareCalls: 0,
    resolveCalls: 0,
    overridesApplied: 0,
    lastSessionId: null,
    lastWindow: null,
  };

  const llm = ctx.llm;
  const llmPrototype = prototypeOf(llm);
  if (llmPrototype === undefined) return;
  const originalPrepareCall = llmPrototype.prepareCall;
  const originalResolveModelInfo = llmPrototype.resolveModelInfo;
  if (typeof originalPrepareCall !== 'function' || typeof originalResolveModelInfo !== 'function') return;

  // ---------------------------------------------------------------- overrides

  function activeOverride(service) {
    const sessionId = currentSessionId(service);
    if (sessionId === undefined) return undefined;
    const requested = overrides.get(sessionId);
    if (requested === undefined) return undefined;
    return { sessionId, requested };
  }

  function currentSessionId(service) {
    const registries = [];
    try {
      const fromService = service?.ctx?.agents;
      if (fromService !== undefined && fromService !== null) registries.push(fromService);
    } catch {
      /* the LLM plugin's context may not reach `agents` */
    }
    try {
      if (ctx.agents !== undefined && ctx.agents !== null) registries.push(ctx.agents);
    } catch {
      /* service unavailable while shutting down */
    }
    for (const registry of registries) {
      let agent;
      try {
        agent = registry.currentInitiator();
      } catch {
        continue;
      }
      const sessionId = agent?.session?.id;
      if (typeof sessionId === 'string' && sessionId !== '') return sessionId;
    }
    return undefined;
  }

  function remember(sessionId, entry) {
    resolved.delete(sessionId);
    resolved.set(sessionId, entry);
    while (resolved.size > MAX_TRACKED_SESSIONS) {
      const oldest = resolved.keys().next();
      if (oldest.done === true) break;
      resolved.delete(oldest.value);
    }
    diagnostics.lastSessionId = sessionId;
    diagnostics.lastWindow = entry.effective;
    diagnostics.overridesApplied += 1;
  }

  // ------------------------------------------------------- window arithmetic

  function resolveWindow(base, requested) {
    const hasBase = Number.isInteger(base) && base > 0;
    const effective = hasBase ? Math.min(requested, base) : requested;
    return { base: hasBase ? base : undefined, effective, changed: hasBase ? effective < base : true };
  }

  function clampCompletion(requested, window) {
    const safeWindow = Math.max(2 * MIN_COMPLETION_TOKENS, Math.floor(window));
    const headroom = Math.min(settings.headroomTokens, Math.floor(safeWindow / 2));
    const ratioLimit = Math.max(MIN_COMPLETION_TOKENS, Math.floor(safeWindow * settings.completionRatio));
    const budgetLimit = Math.max(MIN_COMPLETION_TOKENS, safeWindow - headroom - 1);
    const limit = Math.min(ratioLimit, budgetLimit);
    if (!Number.isFinite(requested)) return limit;
    const value = Math.floor(requested);
    if (value < 1) return limit;
    return Math.min(value, limit);
  }

  // -------------------------------------------------------------- llm patches

  function patchedPrepareCall(config, signal, configure) {
    diagnostics.prepareCalls += 1;
    const active = activeOverride(this);
    if (active === undefined) {
      return originalPrepareCall.call(this, config, signal, configure);
    }
    let resolution;
    const configureCall = (controls, modelInfo) => {
      resolution = resolveWindow(modelInfo?.context?.contextWindow, active.requested);
      const seeded = typeof configure === 'function' ? configure(controls, modelInfo) : controls;
      if (resolution.changed !== true) return seeded;
      const maxTokens = clampCompletion(
        seeded?.maxTokens ?? modelInfo?.defaultMaxTokens,
        resolution.effective,
      );
      return { ...seeded, maxTokens };
    };
    return Promise.resolve(originalPrepareCall.call(this, config, signal, configureCall)).then(
      (prepared) => {
        if (resolution === undefined || resolution.changed !== true) return prepared;
        const maxTokens = clampCompletion(prepared?.config?.maxTokens, resolution.effective);
        remember(active.sessionId, { effective: resolution.effective, maxTokens });
        if (prepared?.context === undefined || prepared.context === null) return prepared;
        return Object.freeze({
          ...prepared,
          context: Object.freeze({ ...prepared.context, contextWindow: resolution.effective }),
        });
      },
    );
  }

  function patchedResolveModelInfo(provider, model, signal) {
    diagnostics.resolveCalls += 1;
    return Promise.resolve(originalResolveModelInfo.call(this, provider, model, signal)).then(
      (info) => {
        const active = activeOverride(this);
        if (active === undefined) return info;
        const resolution = resolveWindow(info?.context?.contextWindow, active.requested);
        if (resolution.changed !== true) return info;
        const defaultMaxTokens = clampCompletion(info?.defaultMaxTokens, resolution.effective);
        remember(active.sessionId, { effective: resolution.effective, maxTokens: defaultMaxTokens });
        return {
          ...info,
          context: { ...(info?.context ?? {}), contextWindow: resolution.effective },
          defaultMaxTokens,
        };
      },
    );
  }

  ctx.effect(() => {
    llmPrototype.prepareCall = patchedPrepareCall;
    llmPrototype.resolveModelInfo = patchedResolveModelInfo;
    return () => {
      if (llmPrototype.prepareCall === patchedPrepareCall) llmPrototype.prepareCall = originalPrepareCall;
      if (llmPrototype.resolveModelInfo === patchedResolveModelInfo) {
        llmPrototype.resolveModelInfo = originalResolveModelInfo;
      }
    };
  }, 'context-window-picker: llm service patches');

  // ------------------------------------------------- request-header clamping

  function clampHeader(header, sessionId) {
    if (header === null || header === undefined || sessionId === undefined) return header;
    const entry = resolved.get(sessionId);
    if (entry === undefined) return header;
    const config = header.config;
    if (config === null || config === undefined) return header;
    const current = config.maxTokens;
    const next = Number.isFinite(current) ? Math.min(current, entry.maxTokens) : entry.maxTokens;
    if (next === current) return header;
    return Object.freeze({ ...header, config: Object.freeze({ ...config, maxTokens: next }) });
  }

  function patchSession(session) {
    if (session === null || typeof session !== 'object') return;
    const proto = prototypeOf(session);
    if (proto === undefined || headerPatches.has(proto)) return;
    const original = proto.requestHeader;
    if (typeof original !== 'function') return;
    const wrapper = function requestHeaderWithContextWindowOverride() {
      return clampHeader(original.call(this), this?.id);
    };
    headerPatches.set(proto, { original, wrapper });
    proto.requestHeader = wrapper;
  }

  ctx.effect(() => {
    const stop = ctx.on('agent/created', (payload) => {
      try {
        patchSession(payload?.agent?.session);
      } catch {
        /* the Agent may be disposed while we look at it */
      }
    });
    try {
      for (const agent of ctx.agents.list()) patchSession(agent?.session);
    } catch {
      /* registry not readable yet */
    }
    return () => {
      if (typeof stop === 'function') stop();
      for (const [proto, entry] of headerPatches) {
        if (proto.requestHeader === entry.wrapper) proto.requestHeader = entry.original;
      }
      headerPatches.clear();
    };
  }, 'context-window-picker: session header clamp');

  ctx.on('agent/disposed', (payload) => {
    const sessionId = payload?.agent?.session?.id;
    if (typeof sessionId === 'string') resolved.delete(sessionId);
  });

  // ------------------------------------------------------------------ API

  function describe(sessionId, base, requested) {
    const hasBase = Number.isInteger(base) && base > 0;
    const hasOverride = Number.isInteger(requested);
    const effective = hasOverride ? (hasBase ? Math.min(requested, base) : requested) : base;
    return {
      ok: true,
      sessionId,
      base: hasBase ? base : null,
      override: hasOverride ? requested : null,
      effective: Number.isInteger(effective) ? effective : null,
      maxTokens: Number.isInteger(effective) ? clampCompletion(undefined, effective) : null,
      // The catalog base stays selectable (it is how a user returns to the full
      // window without clearing the override), so keep `<= base`.
      presets: hasBase
        ? settings.presets.filter((value) => value <= base && value >= settings.minimumWindow)
        : settings.presets.slice(),
      minimumWindow: settings.minimumWindow,
      completionRatio: settings.completionRatio,
    };
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY) throw new Error('request body too large');
      chunks.push(chunk);
    }
    if (size === 0) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed;
  }

  async function baseWindow(provider, model) {
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      return undefined;
    }
    try {
      const info = await originalResolveModelInfo.call(llm, provider, model);
      const value = info?.context?.contextWindow;
      return Number.isInteger(value) && value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  // `webRuntime` is optional (it is only provided by `dsh web`); resolve it lazily
  // so the plugin also loads in headless profiles.
  function trustedHosts() {
    try {
      return ctx.webRuntime?.trustedHosts;
    } catch {
      return undefined;
    }
  }

  const trusted = (req) => isTrustedRequest(req, trustedHosts());

  async function handleState(req, res) {
    if (!trusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' });
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    const query = new URL(req.url ?? API_PREFIX, 'http://localhost').searchParams;
    const sessionId = query.get('sessionId') ?? '';
    const base = await baseWindow(query.get('provider') ?? '', query.get('model') ?? '');
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return writeJson(res, 200, describe('', base, undefined));
    }
    return writeJson(res, 200, describe(sessionId, base, overrides.get(sessionId)));
  }

  async function handleSet(req, res) {
    if (!trusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' });
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return writeJson(res, 400, { ok: false, error: messageOf(error) });
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return writeJson(res, 400, { ok: false, error: 'invalid session id' });
    }
    const provider = typeof body.provider === 'string' ? body.provider : '';
    const model = typeof body.model === 'string' ? body.model : '';
    const base = await baseWindow(provider, model);
    const requested = body.window;
    if (requested === null || requested === undefined) {
      overrides.delete(sessionId);
      resolved.delete(sessionId);
      return writeJson(res, 200, describe(sessionId, base, undefined));
    }
    if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1) {
      return writeJson(res, 400, { ok: false, error: 'window must be a positive integer or null' });
    }
    if (requested < settings.minimumWindow) {
      return writeJson(res, 400, {
        ok: false,
        error: `window must be at least ${settings.minimumWindow}`,
        minimumWindow: settings.minimumWindow,
      });
    }
    if (Number.isInteger(base) && requested > base) {
      return writeJson(res, 400, {
        ok: false,
        error: 'window must not exceed the model default',
        base,
      });
    }
    // Selecting the catalog window clears the override instead of pinning an
    // equal value, so the session stays "default" if the catalog later grows.
    if (Number.isInteger(base) && requested === base) {
      overrides.delete(sessionId);
      resolved.delete(sessionId);
      return writeJson(res, 200, describe(sessionId, base, undefined));
    }
    overrides.set(sessionId, requested);
    resolved.delete(sessionId);
    while (overrides.size > MAX_TRACKED_SESSIONS) {
      const oldest = overrides.keys().next();
      if (oldest.done === true) break;
      overrides.delete(oldest.value);
    }
    return writeJson(res, 200, describe(sessionId, base, requested));
  }

  async function handleHealth(req, res) {
    if (!trusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' });
    return writeJson(res, 200, {
      ok: true,
      plugin: name,
      sessions: overrides.size,
      resolved: resolved.size,
      headerPatches: headerPatches.size,
      diagnostics,
      settings,
    });
  }

  ctx.inject(['webServer'], (scope) => {
    const routes = [
      [`${API_PREFIX}/state`, (req, res) => handleState(req, res)],
      [`${API_PREFIX}/set`, (req, res) => handleSet(req, res)],
      [`${API_PREFIX}/health`, (req, res) => handleHealth(req, res)],
    ];
    for (const [path, handler] of routes) {
      scope.effect(
        () =>
          scope.webServer.register({
            kind: 'exact',
            path,
            handler: (req, res) => {
              Promise.resolve(handler(req, res)).catch((error) => {
                writeJson(res, 500, { ok: false, error: messageOf(error) });
              });
            },
          }),
        `context-window-picker: route ${path}`,
      );
    }
  });
}

// --------------------------------------------------------------------- utils

function normalizeSettings(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const presets = Array.isArray(source.presets)
    ? source.presets.filter((value) => Number.isInteger(value) && value > 0).sort((a, b) => a - b)
    : DEFAULT_PRESETS;
  const completionRatio = clampNumber(source.completionRatio, 0.05, 0.9, 0.25);
  const headroomTokens = Math.max(0, Math.floor(clampNumber(source.headroomTokens, 0, 1e7, 65536)));
  const minimumWindow = Math.max(
    8192,
    Math.floor(clampNumber(source.minimumWindow, 8192, 1e8, 131072)),
  );
  return { presets: presets.length === 0 ? DEFAULT_PRESETS : presets, completionRatio, headroomTokens, minimumWindow };
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function prototypeOf(value) {
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype) return undefined;
    return proto;
  } catch {
    return undefined;
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
}

function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname.trim().toLowerCase();
  } catch {
    return undefined;
  }
}

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isLoopback(hostname) {
  const host = stripBrackets(hostname);
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' || host === '::' || LOOPBACK_PATTERN.test(host);
}

function isTrustedRemote(hostname, trustedHosts) {
  const host = stripBrackets(hostname);
  if (isLoopback(host)) return true;
  if (!Array.isArray(trustedHosts)) return false;
  return trustedHosts.some((entry) => {
    if (typeof entry !== 'string') return false;
    const authority = hostnameOf(entry) ?? entry.trim().toLowerCase();
    return stripBrackets(authority) === host;
  });
}

function isTrustedRequest(req, trustedHosts) {
  const hostname = hostnameOf(req?.headers?.host);
  if (hostname === undefined || !isTrustedRemote(hostname, trustedHosts)) return false;
  const site = req?.headers?.['sec-fetch-site'];
  if (typeof site === 'string' && site.trim().toLowerCase() === 'cross-site') return false;
  const origin = req?.headers?.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'dsh-app://app') {
    let originHostname;
    try {
      originHostname = new URL(origin).hostname.trim().toLowerCase();
    } catch {
      return false;
    }
    if (stripBrackets(originHostname) !== stripBrackets(hostname)) return false;
  }
  return true;
}
