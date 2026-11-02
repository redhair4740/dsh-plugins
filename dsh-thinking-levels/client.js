/**
 * Client half of the Thinking Levels bundle: one Settings page that lists
 * every model advertising reasoning levels and lets the user pick the level a
 * model starts on.
 *
 * The page reads the Host's live catalog (`GET /dsh-thinking-levels/catalog`)
 * and writes one choice at a time (`POST /dsh-thinking-levels/set`), so the
 * displayed levels are exactly the ones the model advertises rather than a
 * hard-coded list.
 */
window.__ModuleLoader__.load({
	id: '@redhair4740/dsh-thinking-levels',
	factory(require) {
		const React = require('react')
		const h = React.createElement
		const NS = 'thinking-levels'
		const CATALOG = '/dsh-thinking-levels/catalog'
		const SAVE = '/dsh-thinking-levels/set'
		/** Sentinel for "no override, keep the model's own default". */
		const FOLLOW = ''

		const zh = {
			nav: '思考等级',
			title: '模型思考等级',
			intro: '为每个模型设置思考等级（模型选择器里显示的“推理等级”）。选中该模型时直接使用这个等级；你仍然可以在选择器里临时改成别的。',
			follow: '跟随模型默认',
			effective: '当前生效：{level}',
			stale: '已配置的等级 {level} 当前不可用',
			empty: '当前没有提供思考等级的模型。',
			loading: '正在读取模型目录…',
			saving: '正在保存…',
			saved: '已保存',
			loadError: '无法读取模型目录：{message}',
			saveError: '保存失败：{message}',
			providerFailure: '{name} 当前不可用：{message}',
			selectAria: '为 {model} 选择思考等级',
		}

		const en = {
			nav: 'Thinking levels',
			title: 'Thinking level per model',
			intro: 'Set the thinking level each model starts on (shown as “Effort” in the model picker). Selecting that model then uses this level directly; you can still switch to another level in the picker.',
			follow: 'Follow model default',
			effective: 'In effect: {level}',
			stale: 'Configured level {level} is not available right now',
			empty: 'No model advertises thinking levels right now.',
			loading: 'Reading the model catalog…',
			saving: 'Saving…',
			saved: 'Saved',
			loadError: 'Could not read the model catalog: {message}',
			saveError: 'Could not save: {message}',
			providerFailure: '{name} is unavailable: {message}',
			selectAria: 'Choose the thinking level for {model}',
		}

		const style = {
			section: 'tl-section',
			title: 'tl-title',
			intro: 'tl-intro',
			status: 'tl-status',
			group: 'tl-group',
			groupTitle: 'tl-group-title',
			row: 'tl-row',
			copy: 'tl-copy',
			name: 'tl-name',
			meta: 'tl-meta',
			select: 'tl-select',
			note: 'tl-note',
		}

		const css = `
.tl-section{display:flex;flex-direction:column;width:100%;max-width:760px;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px}
.tl-title{margin:0;font-size:14px;font-weight:500;line-height:22px}
.tl-intro{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-wrap:pretty}
.tl-status{margin:10px 0 0;min-height:18px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.tl-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.tl-status[data-tone=success]{color:var(--dsw-alias-state-success-primary)}
.tl-group{display:flex;flex-direction:column;margin-top:14px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px}
.tl-group-title{margin:0 0 2px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.tl-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.tl-row:last-child{border-bottom:none;padding-bottom:0}
.tl-copy{min-width:0}
.tl-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px}
.tl-meta{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.tl-meta[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}
.tl-select{box-sizing:border-box;flex:none;height:32px;min-width:136px;max-width:220px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer}
.tl-select:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}
.tl-select:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}
.tl-select:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.tl-note{margin:12px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
`

		/**
		 * Fill `{name}` placeholders in one localized line.
		 * @param {string} line - template from the dictionaries.
		 * @param {Record<string, string>} values - replacements.
		 * @returns {string} rendered text.
		 */
		function format(line, values) {
			return String(line).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
		}

		/** Mount the page stylesheet for the lifetime of the page component. */
		function Styles() {
			return h('style', { 'data-plugin-css': '@redhair4740/dsh-thinking-levels/SettingsSection' }, css)
		}

		/**
		 * Read one model's displayed level name.
		 * @param {{ efforts: { id: string, name: string }[] }} model - catalog row.
		 * @param {string | null} effort - effort id.
		 * @returns {string | undefined} display name.
		 */
		function levelName(model, effort) {
			if (effort === null) return undefined
			const level = model.efforts.find((candidate) => candidate.id === effort)
			return level === undefined ? effort : level.name
		}

		/**
		 * Render the per-model default reasoning level page.
		 *
		 * Status text is stored as a dictionary key plus its values and translated
		 * during render, so a late locale seat or a locale switch never leaves stale
		 * copy on screen.
		 *
		 * @param props - composed slot props; `t` comes from the registered dictionary.
		 * @returns {import('react').ReactElement} the Settings section.
		 */
		function ReasoningDefaultsSection(props) {
			const t = typeof props?.t === 'function' ? props.t : (key) => en[key] ?? key
			const tt = (key, values) => format(t(key), values ?? {})
			const [catalog, setCatalog] = React.useState(null)
			const [phase, setPhase] = React.useState('loading')
			const [message, setMessage] = React.useState(null)
			const [pending, setPending] = React.useState(null)

			const load = React.useCallback(async () => {
				setPhase('loading')
				setMessage(null)
				try {
					const response = await fetch(CATALOG, { headers: { accept: 'application/json' }, cache: 'no-store' })
					const payload = await response.json().catch(() => null)
					if (!response.ok || payload?.ok !== true) {
						throw new Error(payload?.error ?? `HTTP ${response.status}`)
					}
					setCatalog(payload)
					setPhase('ready')
				} catch (error) {
					setPhase('error')
					setMessage({
						key: 'loadError',
						values: { message: error instanceof Error ? error.message : String(error) },
						tone: 'error',
					})
				}
			}, [])

			React.useEffect(() => {
				void load()
			}, [load])

			/**
			 * Persist one model's level.
			 * @param {string} provider - provider route.
			 * @param {string} model - model id.
			 * @param {string} effort - effort id, or the follow sentinel.
			 * @returns {Promise<void>} fulfillment after the Host answered.
			 */
			const choose = async (provider, model, effort) => {
				const key = `${provider}\u0000${model}`
				setPending(key)
				setMessage({ key: 'saving', values: {}, tone: null })
				try {
					const response = await fetch(SAVE, {
						method: 'POST',
						headers: { 'content-type': 'application/json', accept: 'application/json' },
						body: JSON.stringify({ provider, model, reasoningEffort: effort === FOLLOW ? null : effort }),
					})
					const payload = await response.json().catch(() => null)
					if (!response.ok || payload?.ok !== true) {
						throw new Error(payload?.error ?? `HTTP ${response.status}`)
					}
					if (payload.catalog !== undefined) setCatalog(payload.catalog)
					setPhase('ready')
					setMessage({ key: 'saved', values: {}, tone: 'success' })
				} catch (error) {
					setMessage({
						key: 'saveError',
						values: { message: error instanceof Error ? error.message : String(error) },
						tone: 'error',
					})
				} finally {
					setPending(null)
				}
			}

			const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
			const failures = Array.isArray(catalog?.failures) ? catalog.failures : []
			const rows = []

			for (const provider of providers) {
				const models = Array.isArray(provider.models) ? provider.models : []
				if (models.length === 0) continue
				rows.push(h('div', { className: style.group, key: provider.id }, [
					h('div', { className: style.groupTitle, key: 'title' }, provider.name),
					...models.map((model) => {
						const key = `${provider.id}\u0000${model.id}`
						const value = model.override ?? FOLLOW
						const effectiveName = levelName(model, model.effective) ?? null
						const stale = model.configured !== null && model.override === null
						return h('div', { className: style.row, key }, [
							h('div', { className: style.copy, key: 'copy' }, [
								h('div', { className: style.name, key: 'name' }, model.name),
								h('div', {
									className: style.meta,
									key: 'meta',
									...(stale ? { 'data-tone': 'warn' } : {}),
								}, stale
									? tt('stale', { level: model.configured })
									: effectiveName === null ? tt('follow') : tt('effective', { level: effectiveName })),
							]),
							h('select', {
								className: style.select,
								key: 'select',
								value,
								disabled: pending === key,
								'aria-label': tt('selectAria', { model: model.name }),
								onChange: (event) => {
									const next = event.currentTarget.value
									if (next !== value) void choose(provider.id, model.id, next)
								},
							}, [
								h('option', { value: FOLLOW, key: 'follow' }, tt('follow')),
								...model.efforts.map((level) => h('option', { value: level.id, key: level.id }, level.name)),
							]),
						])
					}),
				]))
			}

			return h('div', { className: style.section }, [
				h(Styles, { key: 'styles' }),
				h('h2', { className: style.title, key: 'title' }, tt('title')),
				h('p', { className: style.intro, key: 'intro' }, tt('intro')),
				message === null ? null : h('p', {
					className: style.status,
					key: 'status',
					role: 'status',
					'aria-live': 'polite',
					...(message.tone === null ? {} : { 'data-tone': message.tone }),
				}, tt(message.key, message.values)),
				phase === 'ready' && rows.length === 0
					? h('p', { className: style.note, key: 'empty' }, tt('empty'))
					: null,
				...rows,
				...failures.map((failure) => h('p', {
					className: style.note,
					key: `failure-${failure.id}`,
				}, tt('providerFailure', { name: failure.name, message: failure.message }))),
			])
		}

		return {
			inject: ['slots', 'locale'],
			/**
			 * Register the page in the Settings panel.
			 * @param ctx - Client plugin context.
			 * @returns {void}
			 */
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'thinking-levels: dictionaries')
				const t = ctx.locale.bind(NS)
				ctx.slots.inject('settings.section', () => ctx.slots.register({
					name: 'settings.section',
					id: 'thinking-levels',
					order: 25,
					label: () => t('nav'),
					locale: NS,
				}, ReasoningDefaultsSection))
			},
		}
	},
})
