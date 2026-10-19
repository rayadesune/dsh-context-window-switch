/**
 * dsh-context-window-picker — Client half.
 *
 * Shadows the shipped model label (`conversation.input.model.label`) at a
 * negative priority, so the model popup's detail panel can carry a context
 * window control right next to the shipped "Reasoning effort" row. The control
 * talks to the host half over the loopback JSON API it registers
 * (`/dsh-context-window-picker/api/{state,set}`); the choice is stored per
 * session on the host, so a new session starts at the Profile default again.
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-window-picker',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    const NS = 'context-window-picker';
    const SLOT = 'conversation.input.model.label';
    const API_BASE = 'dsh-context-window-picker/api';
    const CSS_MARKER = 'dsh-context-window-picker';
    const POPOVER_GAP = 6;
    const VIEWPORT_MARGIN = 8;

    const zh = {
      'chip.label': '上下文',
      'chip.aria': '切换本会话上下文窗口',
      'menu.title': '上下文窗口',
      'menu.subtitle': '仅本会话生效',
      'menu.default': '默认（跟随模型）',
      'menu.loading': '读取中…',
      'menu.error': '无法读取当前上下文窗口',
      'menu.note': '只对当前会话生效；新会话自动恢复 Profile 默认值。较小的窗口会同时收紧单次输出上限。',
      'menu.tokensSuffix': 'tokens',
    };
    const en = {
      'chip.label': 'Context',
      'chip.aria': 'Change this session context window',
      'menu.title': 'Context window',
      'menu.subtitle': 'This session only',
      'menu.default': 'Default (follows model)',
      'menu.loading': 'Loading…',
      'menu.error': 'Could not read the current context window',
      'menu.note': 'Applies to this session only; a new session returns to the Profile default. A smaller window also tightens the per-request output cap.',
      'menu.tokensSuffix': 'tokens',
    };

    const CSS = `
.dcwp_name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcwp_suffix{color:var(--dsw-alias-label-caption);font-weight:400}
.dcwp_cell{display:flex;align-items:center;gap:8px;min-width:0;width:100%}
.dcwp_chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}
.dcwp_chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dcwp_chip[data-override="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dcwp_chip:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.dcwp_popover{position:fixed;z-index:1200;display:flex;flex-direction:column;gap:2px;min-width:240px;max-width:min(360px,calc(100vw - 24px));padding:6px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-prominent)}
.dcwp_header{display:flex;align-items:baseline;gap:6px;padding:4px 8px 6px}
.dcwp_title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dcwp_subtitle{font-size:11px;color:var(--dsw-alias-label-caption)}
.dcwp_option{display:flex;align-items:center;justify-content:space-between;gap:12px;height:32px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.dcwp_option:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dcwp_option[data-active="true"]{color:var(--dsw-alias-brand-primary)}
.dcwp_option[data-busy="true"]{opacity:.55;pointer-events:none}
.dcwp_optionLabel{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcwp_check{width:12px;height:12px;flex:none}
.dcwp_optionMeta{font-size:12px;color:var(--dsw-alias-label-caption);white-space:nowrap}
.dcwp_note{margin-top:4px;padding:6px 8px 2px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:1.5;color:var(--dsw-alias-label-caption)}
.dcwp_error{padding:4px 8px;font-size:11px;color:var(--dsw-alias-state-error-primary)}
`;

    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
      if (value >= 1048576 && value % 1048576 === 0) return `${value / 1048576}M`;
      if (value >= 1024) {
        const kilo = value / 1024;
        return `${Number.isInteger(kilo) ? kilo : kilo.toFixed(1)}K`;
      }
      return String(value);
    }

    function pageBase() {
      try {
        const url = new URL(document.baseURI);
        url.search = '';
        url.hash = '';
        if (!url.pathname.endsWith('/')) {
          url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
        }
        return url;
      } catch {
        return new URL('/', window.location.origin);
      }
    }

    function apiUrl(resource, query) {
      const url = new URL(`${API_BASE}/${resource}`.replace(/^\/+/, ''), pageBase());
      if (query !== undefined) {
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
      }
      return url.href;
    }

    async function readJson(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }

    function ContextWindowLabel(props) {
      // `props.t` may be a fresh closure on every render; keep it in a ref so the
      // fetch effect below never re-runs just because the translator identity moved.
      const translateRef = React.useRef(props.t);
      translateRef.current = props.t;
      const translate = React.useCallback((key) => {
        const bound = translateRef.current;
        return typeof bound === 'function' ? bound(key) : key;
      }, []);
      const placement = props.placement;
      const provider = props.provider;
      const model = props.model;
      const sessionId = props.sessionId;
      const providerId = typeof provider?.id === 'string' ? provider.id : '';
      const modelId = typeof model?.id === 'string' ? model.id : '';
      const modelName = typeof model?.name === 'string' && model.name !== '' ? model.name : modelId;
      const inspectable = placement === 'menu' || placement === 'trigger';
      const interactive = placement === 'menu';

      const [state, setState] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [position, setPosition] = React.useState(null);
      const anchorRef = React.useRef(null);
      const popoverRef = React.useRef(null);

      const load = React.useCallback(
        (signal) => {
          if (!inspectable || sessionId === '' || providerId === '') return;
          const url = apiUrl('state', { sessionId, provider: providerId, model: modelId });
          fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal })
            .then((response) => (response.ok ? readJson(response) : Promise.reject(new Error(`HTTP ${response.status}`))))
            .then((body) => {
              if (signal.aborted) return;
              if (body?.ok === true) {
                setState(body);
                setError(null);
              } else {
                setError(translate('menu.error'));
              }
            })
            .catch((cause) => {
              if (signal.aborted) return;
              if (cause?.name === 'AbortError') return;
              setError(translate('menu.error'));
            });
        },
        [inspectable, sessionId, providerId, modelId, translate],
      );

      React.useEffect(() => {
        if (!inspectable) return undefined;
        const controller = new AbortController();
        load(controller.signal);
        return () => controller.abort();
      }, [inspectable, load]);

      React.useEffect(() => {
        if (!open) {
          setPosition(null);
          return undefined;
        }
        const closeOutside = (event) => {
          const target = event.target;
          const popover = popoverRef.current;
          const anchor = anchorRef.current;
          if (popover !== null && popover.contains(target)) return;
          if (anchor !== null && anchor.contains(target)) return;
          setOpen(false);
        };
        const closeOnEscape = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        };
        const closeOnViewportChange = () => setOpen(false);
        document.addEventListener('mousedown', closeOutside, true);
        document.addEventListener('keydown', closeOnEscape, true);
        window.addEventListener('resize', closeOnViewportChange);
        window.addEventListener('scroll', closeOnViewportChange, true);
        return () => {
          document.removeEventListener('mousedown', closeOutside, true);
          document.removeEventListener('keydown', closeOnEscape, true);
          window.removeEventListener('resize', closeOnViewportChange);
          window.removeEventListener('scroll', closeOnViewportChange, true);
        };
      }, [open]);

      React.useLayoutEffect(() => {
        if (!open) return;
        const anchor = anchorRef.current;
        const popover = popoverRef.current;
        if (anchor === null || popover === null) return;
        const box = anchor.getBoundingClientRect();
        const size = popover.getBoundingClientRect();
        const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - size.width - VIEWPORT_MARGIN);
        const left = Math.min(Math.max(VIEWPORT_MARGIN, box.left), maxLeft);
        let top = box.top - size.height - POPOVER_GAP;
        if (top < VIEWPORT_MARGIN) {
          top = Math.min(
            Math.max(VIEWPORT_MARGIN, box.bottom + POPOVER_GAP),
            Math.max(VIEWPORT_MARGIN, window.innerHeight - size.height - VIEWPORT_MARGIN),
          );
        }
        setPosition({ left: Math.round(left), top: Math.round(top) });
      }, [open, state, error, busy]);

      const choose = React.useCallback(
        async (windowValue) => {
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            const response = await fetch(apiUrl('set'), {
              method: 'POST',
              credentials: 'same-origin',
              headers: { accept: 'application/json', 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId, provider: providerId, model: modelId, window: windowValue }),
            });
            const body = await readJson(response);
            if (!response.ok || body?.ok !== true) {
              throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`);
            }
            setState(body);
            setOpen(false);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusy(false);
          }
        },
        [busy, sessionId, providerId, modelId],
      );

      if (!inspectable) {
        return h('span', { className: 'dcwp_name', title: modelName }, modelName);
      }

      const effectiveLabel = formatTokens(state?.effective);
      const hasOverride = typeof state?.override === 'number';

      const anchor = h(
        'span',
        {
          ref: (node) => {
            anchorRef.current = node;
          },
          className: 'dcwp_cell',
          title: modelName,
        },
        h('span', { className: 'dcwp_name' }, modelName),
        interactive
          ? h(
              'span',
              {
                className: 'dcwp_chip',
                'data-override': hasOverride ? 'true' : 'false',
                role: 'button',
                tabIndex: 0,
                'aria-haspopup': 'dialog',
                'aria-expanded': open ? 'true' : 'false',
                'aria-label': `${translate('chip.aria')} (${effectiveLabel === '' ? '—' : effectiveLabel})`,
                onClick: (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen((value) => !value);
                },
                onMouseDown: (event) => event.stopPropagation(),
                onKeyDown: (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen((value) => !value);
                },
              },
              `${translate('chip.label')} ${effectiveLabel === '' ? '—' : effectiveLabel}`,
            )
          : hasOverride && effectiveLabel !== ''
            ? h('span', { className: 'dcwp_suffix' }, `· ${effectiveLabel}`)
            : null,
      );

      if (!open) return anchor;

      const presets = Array.isArray(state?.presets) ? state.presets : [];
      const isDefault = state?.override === null || state?.override === undefined;
      const options = [
        h(
          'button',
          {
            type: 'button',
            key: 'default',
            className: 'dcwp_option',
            'data-active': isDefault ? 'true' : 'false',
            'data-busy': busy ? 'true' : 'false',
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              void choose(null);
            },
            onMouseDown: (event) => event.stopPropagation(),
          },
          h('span', { className: 'dcwp_optionLabel' }, translate('menu.default')),
          h(
            'span',
            { className: 'dcwp_optionMeta' },
            state?.base === null || state?.base === undefined ? '—' : formatTokens(state.base),
          ),
        ),
      ];
      for (const preset of presets) {
        options.push(
          h(
            'button',
            {
              type: 'button',
              key: String(preset),
              className: 'dcwp_option',
              'data-active': state?.override === preset ? 'true' : 'false',
              'data-busy': busy ? 'true' : 'false',
              onClick: (event) => {
                event.preventDefault();
                event.stopPropagation();
                void choose(preset);
              },
              onMouseDown: (event) => event.stopPropagation(),
            },
            h('span', { className: 'dcwp_optionLabel' }, `${formatTokens(preset)} ${translate('menu.tokensSuffix')}`),
            state?.override === preset ? h('span', { className: 'dcwp_optionMeta' }, '✓') : null,
          ),
        );
      }

      const popover = h(
        'div',
        {
          ref: (node) => {
            popoverRef.current = node;
          },
          className: 'dcwp_popover',
          role: 'dialog',
          'aria-label': translate('menu.title'),
          style:
            position === null
              ? { left: 0, top: 0, visibility: 'hidden' }
              : { left: `${position.left}px`, top: `${position.top}px` },
          onMouseDown: (event) => event.stopPropagation(),
          onClick: (event) => event.stopPropagation(),
        },
        h(
          'div',
          { className: 'dcwp_header' },
          h('span', { className: 'dcwp_title' }, translate('menu.title')),
          h('span', { className: 'dcwp_subtitle' }, translate('menu.subtitle')),
        ),
        state === null && error === null ? h('div', { className: 'dcwp_note' }, translate('menu.loading')) : null,
        error === null ? null : h('div', { className: 'dcwp_error' }, error),
        ...options,
        h('div', { className: 'dcwp_note' }, translate('menu.note')),
      );

      return h(React.Fragment, null, anchor, ReactDOM.createPortal(popover, document.body));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          if (document.querySelector(`style[data-plugin-css="${CSS_MARKER}"]`) !== null) return () => {};
          const style = document.createElement('style');
          style.dataset.pluginCss = CSS_MARKER;
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'context-window-picker: styles');

        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'context-window-picker: dictionaries',
        );

        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            { name: SLOT, priority: -1000, locale: NS },
            ContextWindowLabel,
          ),
        );
      },
    };
  },
});
