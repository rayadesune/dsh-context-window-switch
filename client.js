/**
 * dsh-context-window-picker — Client half.
 *
 * Adds a standalone 「上下文窗口」 row to the shipped model popup's root pane,
 * directly below 「模型」/「推理等级」.
 *
 * The shipped `ModelSelect` (which owns the `conversation.input.model` seat)
 * renders its root pane itself, so there is no slot for an extra row. Instead of
 * replacing that seat — which would mean re-implementing model search, grouping,
 * keyboard navigation and the selection round-trip — this half keeps the seat
 * untouched and mounts one extra row next to the shipped ones:
 *
 *  - The row is rendered through `conversation.input.model.label` (placement
 *    `menu`), which the shipped popup renders once its model directory settles.
 *  - A hidden anchor node walks up the DOM to the element that owns the shipped
 *    `role="menuitem"` cells, and a React portal appends the row after the last
 *    cell. Because the row lives INSIDE that element, the popup's own
 *    outside-click and blur handlers treat it as part of the menu: clicking the
 *    row and its option list does not dismiss the popup mid-click.
 *  - Selecting a size posts to the host half over the loopback JSON API; the
 *    override is stored per session, so a new session starts at the Profile
 *    default again.
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
    const MENU_LOOKUP_DEPTH = 12;
    const PANEL_MARGIN = 8;

    const zh = {
      'row.label': '上下文窗口',
      'row.aria': '上下文窗口，当前 {value}，点击切换（仅本会话）',
      'row.pending': '读取中',
      'row.unknown': '默认',
      'panel.title': '上下文窗口',
      'panel.subtitle': '仅本会话',
      'option.default': '默认（跟随模型）',
      'option.tokens': '{value} tokens',
      'panel.note': '只对当前会话生效，新建会话自动恢复 Profile 默认值；较小的窗口会同时收紧单次输出上限。',
      'panel.loading': '读取中…',
      'panel.empty': '当前模型没有更小的可用档位。',
      'panel.error': '无法读取当前上下文窗口',
      'panel.failed': '切换失败',
    };
    const en = {
      'row.label': 'Context window',
      'row.aria': 'Context window, currently {value}, click to change (this session only)',
      'row.pending': 'Loading',
      'row.unknown': 'Default',
      'panel.title': 'Context window',
      'panel.subtitle': 'This session only',
      'option.default': 'Default (follows the model)',
      'option.tokens': '{value} tokens',
      'panel.note':
        'Applies to this session only; a new session returns to the Profile default. A smaller window also tightens the per-request output cap.',
      'panel.loading': 'Loading…',
      'panel.empty': 'No smaller size is available for the current model.',
      'panel.error': 'Could not read the current context window',
      'panel.failed': 'Could not change the context window',
    };

    const CSS = `
.dcwp_hidden{display:block;position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;clip-path:inset(50%)}
.dcwp_rowSlot{display:block;width:100%;position:relative}
.dcwp_row{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:auto;min-width:100%;height:34px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:0 8px;font-family:inherit;font-size:13px;line-height:20px;display:flex}
.dcwp_row:hover,.dcwp_row:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dcwp_rowLabel{white-space:nowrap;flex:none}
.dcwp_rowValue{text-overflow:ellipsis;white-space:nowrap;text-align:right;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;overflow:hidden}
.dcwp_rowValue[data-override="true"]{color:var(--dsw-alias-brand-primary)}
.dcwp_rowChevron{width:12px;height:12px;color:var(--dsw-alias-menu-icon);flex:none}
.dcwp_panel{position:fixed;z-index:1300;display:flex;flex-direction:column;gap:1px;box-sizing:border-box;overflow:hidden;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary)}
.dcwp_head{display:flex;align-items:baseline;gap:6px;padding:4px 8px 6px}
.dcwp_title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dcwp_sub{font-size:11px;color:var(--dsw-alias-label-caption)}
.dcwp_list{display:flex;flex-direction:column;min-height:0;overflow-y:auto}
.dcwp_option{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:auto;min-width:100%;min-height:34px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:5px 7px;font-family:inherit;display:flex}
.dcwp_option:hover,.dcwp_option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dcwp_option[data-busy="true"]{opacity:.55;pointer-events:none}
.dcwp_optionName{text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:400;line-height:18px;overflow:hidden;flex:1;min-width:0}
.dcwp_check{color:var(--dsw-alias-label-primary);flex:0 0 14px;display:grid;place-items:center}
.dcwp_check svg{width:14px;height:14px}
.dcwp_note{margin:2px 4px 2px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}
.dcwp_error{padding:2px 8px 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}
.dcwp_status{padding:6px 8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
`;

    const CHECK_PATH =
      'M2.6 7.3 5.4 10.1 11.4 4.1';
    const CHEVRON_PATH = 'M4.3 2.3 8.9 7 4.3 11.7';

    function icon(path, className) {
      return h(
        'svg',
        {
          viewBox: '0 0 14 14',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className,
          'aria-hidden': 'true',
        },
        h('path', { d: path }),
      );
    }

    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
      if (value >= 1048576 && value % 1048576 === 0) return `${value / 1048576}M`;
      if (value >= 1024) {
        const kilo = value / 1024;
        return Number.isInteger(kilo) ? `${kilo}K` : `${kilo.toFixed(1)}K`;
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

    /**
     * Climb from the hidden anchor to the element that owns the shipped
     * `role="menuitem"` cells, i.e. the root pane container of the model popup.
     * Returns `null` outside the popup so the row simply does not mount.
     */
    function findRowContainer(node) {
      let element = node;
      for (let depth = 0; depth < MENU_LOOKUP_DEPTH; depth += 1) {
        element = element?.parentElement;
        if (element === null || element === undefined || element === document.body) return null;
        if (element.querySelector(':scope > button[role="menuitem"]') !== null) return element;
      }
      return null;
    }

    function resolveSessionId(props, ctx) {
      if (typeof props.sessionId === 'string' && props.sessionId !== '') return props.sessionId;
      try {
        const uiSession = ctx.get('uiSession');
        const binding = uiSession?.current?.getSnapshot?.();
        if (typeof binding?.key === 'string' && binding.key !== '') return binding.key;
      } catch {
        /* the session service is optional for this row */
      }
      return '';
    }

    function ContextWindowRow(props) {
      const translate = React.useCallback(
        (key, vars) => {
          const bound = typeof props.t === 'function' ? props.t : undefined;
          const template = bound === undefined ? key : bound(key);
          const text = typeof template === 'string' ? template : key;
          if (vars === undefined) return text;
          return text.replace(/\{(\w+)\}/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
          );
        },
        // `t` is memoized per locale revision but its identity can move; the
        // dictionary lookup is cheap and the component is small.
        [props.t],
      );

      const placement = props.placement;
      const provider = props.provider;
      const model = props.model;
      const ctx = props.ctx;

      const anchorRef = React.useRef(null);
      const slotRef = React.useRef(null);
      const [host, setHost] = React.useState(null);
      const [state, setState] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [panelBox, setPanelBox] = React.useState(null);

      const sessionId = resolveSessionId(props, ctx);
      const providerId = typeof provider?.id === 'string' ? provider.id : '';
      const modelId = typeof model?.id === 'string' ? model.id : '';
      const modelName = typeof model?.name === 'string' && model.name !== '' ? model.name : modelId;

      // ------------------------------------------------------------ mounting

      React.useLayoutEffect(() => {
        if (placement !== 'menu') return undefined;
        const anchor = anchorRef.current;
        if (anchor === null || anchor === undefined) return undefined;
        const container = findRowContainer(anchor);
        if (container === null) return undefined;
        const cells = [...container.querySelectorAll(':scope > button[role="menuitem"]')];
        const slot = document.createElement('div');
        slot.className = 'dcwp_rowSlot';
        const last = cells.length === 0 ? null : cells[cells.length - 1];
        if (last === null) container.appendChild(slot);
        else last.after(slot);
        slotRef.current = slot;
        setHost(slot);
        return () => {
          slot.remove();
          slotRef.current = null;
          setHost(null);
        };
      }, [placement]);

      // --------------------------------------------------------------- state

      const loadSignal = React.useRef(null);
      const load = React.useCallback(() => {
        if (sessionId === '' || providerId === '') return;
        loadSignal.current?.abort();
        const controller = new AbortController();
        loadSignal.current = controller;
        const url = apiUrl('state', { sessionId, provider: providerId, model: modelId });
        fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal: controller.signal })
          .then((response) =>
            response.ok ? readJson(response) : Promise.reject(new Error(`HTTP ${response.status}`)),
          )
          .then((body) => {
            if (controller.signal.aborted) return;
            if (body?.ok !== true) {
              setError(translate('panel.error'));
              return;
            }
            setState(body);
            setError(null);
          })
          .catch((cause) => {
            if (controller.signal.aborted || cause?.name === 'AbortError') return;
            setError(translate('panel.error'));
          });
      }, [sessionId, providerId, modelId, translate]);

      React.useEffect(() => {
        if (host === null) return undefined;
        load();
        return () => loadSignal.current?.abort();
      }, [host, load]);

      // ------------------------------------------------------------- picking

      const measure = React.useCallback(() => {
        const slot = slotRef.current;
        if (slot === null) return undefined;
        const menu = slot.parentElement;
        if (menu === null) return undefined;
        const box = menu.getBoundingClientRect();
        const width = Math.max(200, Math.min(box.width, window.innerWidth - 2 * PANEL_MARGIN));
        const left = Math.min(Math.max(PANEL_MARGIN, box.left), window.innerWidth - width - PANEL_MARGIN);
        const top = Math.min(Math.max(PANEL_MARGIN, box.top), Math.max(PANEL_MARGIN, window.innerHeight - 240));
        return {
          left: Math.round(left),
          top: Math.round(top),
          width: Math.round(width),
          maxHeight: Math.round(Math.max(160, window.innerHeight - top - PANEL_MARGIN)),
        };
      }, []);

      React.useLayoutEffect(() => {
        if (!open) {
          setPanelBox(null);
          return;
        }
        setPanelBox(measure() ?? null);
      }, [open, measure, state]);

      React.useEffect(() => {
        if (!open) return undefined;
        const closeOnEscape = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        };
        const recompute = () => setPanelBox(measure() ?? null);
        document.addEventListener('keydown', closeOnEscape, true);
        window.addEventListener('resize', recompute);
        return () => {
          document.removeEventListener('keydown', closeOnEscape, true);
          window.removeEventListener('resize', recompute);
        };
      }, [open, measure]);

      const choose = React.useCallback(
        async (windowValue) => {
          if (busy || sessionId === '') return;
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
            setError(`${translate('panel.failed')}: ${cause instanceof Error ? cause.message : String(cause)}`);
          } finally {
            setBusy(false);
          }
        },
        [busy, sessionId, providerId, modelId, translate],
      );

      // ------------------------------------------------------------- render

      // This slot occupies the composer's own model-name seat, so every branch
      // below must still render the catalog name exactly as the shipped UI
      // did. Only the popup's `menu` placement additionally appends our row.
      const plainLabel = h('span', null, modelName);

      if (placement !== 'menu') {
        // Trigger caption and the model list rows: the untouched catalog name.
        return plainLabel;
      }

      const effectiveLabel = formatTokens(state?.effective);
      const hasOverride = typeof state?.override === 'number';
      const valueText =
        state === null && error === null
          ? translate('row.pending')
          : effectiveLabel === ''
            ? translate('row.unknown')
            : effectiveLabel;

      const row = h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          tabIndex: 0,
          className: 'dcwp_row',
          'aria-haspopup': 'true',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': translate('row.aria', { value: valueText }),
          onClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen((current) => !current);
          },
          onMouseDown: (event) => event.stopPropagation(),
        },
        h('span', { className: 'dcwp_rowLabel' }, translate('row.label')),
        h(
          'span',
          { className: 'dcwp_rowValue', 'data-override': hasOverride ? 'true' : 'false' },
          valueText,
        ),
        icon(CHEVRON_PATH, 'dcwp_rowChevron'),
      );

      if (host === null) {
        return h(
          'span',
          {
            ref: (node) => {
              anchorRef.current = node;
            },
            className: 'dcwp_hidden',
          },
          plainLabel,
        );
      }

      const presets = Array.isArray(state?.presets) ? state.presets : [];
      const isDefault = state?.override === null || state?.override === undefined;
      const options = [
        h(
          'button',
          {
            type: 'button',
            key: 'default',
            className: 'dcwp_option',
            role: 'menuitemradio',
            'aria-checked': isDefault ? 'true' : 'false',
            'data-busy': busy ? 'true' : 'false',
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              void choose(null);
            },
            onMouseDown: (event) => event.stopPropagation(),
          },
          h('span', { className: 'dcwp_optionName' }, translate('option.default')),
          h(
            'span',
            { className: 'dcwp_check' },
            isDefault ? icon(CHECK_PATH, undefined) : null,
          ),
        ),
      ];
      for (const preset of presets) {
        const selected = state?.override === preset;
        options.push(
          h(
            'button',
            {
              type: 'button',
              key: String(preset),
              className: 'dcwp_option',
              role: 'menuitemradio',
              'aria-checked': selected ? 'true' : 'false',
              'data-busy': busy ? 'true' : 'false',
              onClick: (event) => {
                event.preventDefault();
                event.stopPropagation();
                void choose(preset);
              },
              onMouseDown: (event) => event.stopPropagation(),
            },
            h('span', { className: 'dcwp_optionName' }, translate('option.tokens', { value: formatTokens(preset) })),
            h('span', { className: 'dcwp_check' }, selected ? icon(CHECK_PATH, undefined) : null),
          ),
        );
      }

      const panel =
        !open || host === null
          ? null
          : ReactDOM.createPortal(
              h(
                'div',
                {
                  className: 'dcwp_panel',
                  role: 'group',
                  'aria-label': translate('panel.title'),
                  style:
                    panelBox === null
                      ? { left: 0, top: 0, visibility: 'hidden', width: 240 }
                      : {
                          left: `${panelBox.left}px`,
                          top: `${panelBox.top}px`,
                          width: `${panelBox.width}px`,
                          maxHeight: `${panelBox.maxHeight}px`,
                        },
                  onMouseDown: (event) => event.stopPropagation(),
                  onClick: (event) => event.stopPropagation(),
                },
                h(
                  'div',
                  { className: 'dcwp_head' },
                  h('span', { className: 'dcwp_title' }, translate('panel.title')),
                  h('span', { className: 'dcwp_sub' }, translate('panel.subtitle')),
                ),
                state === null && error === null
                  ? h('div', { className: 'dcwp_status' }, translate('panel.loading'))
                  : null,
                error === null ? null : h('div', { className: 'dcwp_error' }, error),
                presets.length === 0 && state !== null
                  ? h('div', { className: 'dcwp_status' }, translate('panel.empty'))
                  : h('div', { className: 'dcwp_list' }, ...options),
                h('div', { className: 'dcwp_note' }, translate('panel.note')),
              ),
              host,
            );

      return h(
        React.Fragment,
        null,
        h(
          'span',
          {
            ref: (node) => {
              anchorRef.current = node;
            },
            className: 'dcwp_hidden',
            'aria-hidden': 'true',
          },
          plainLabel,
        ),
        ReactDOM.createPortal(row, host),
        panel,
      );
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

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'context-window-picker: dictionaries');

        const RowWithContext = (props) => h(ContextWindowRow, { ...props, ctx });

        ctx.slots.inject(SLOT, () =>
          ctx.slots.register({ name: SLOT, priority: -1000, locale: NS }, RowWithContext),
        );
      },
    };
  },
});
