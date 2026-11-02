/**
 * Per-model thinking level (the adapter's reasoning effort) for DeepSeek Harness.
 *
 * A model's thinking level is the level its selector starts on and the level a
 * request falls back to when the caller names no level. This plugin sets that
 * level for the models named in its Config:
 *
 * - `ctx.llm.resolveModelInfo()` feeds the model catalog every selector renders,
 *   so the configured level is the one the picker shows and sends when a user
 *   picks the model;
 * - `ctx.llm.resolveCallConfig()` materializes the same level for callers that
 *   name no effort at all (other entry points, delegation, forks);
 * - `ctx.agentDefaultModel.currentSelection()` carries it into a fresh Session,
 *   whose deployment default would otherwise name its own level.
 *
 * An explicit level always wins, and a configured level a model does not
 * advertise is ignored with a warning, so a stale Config can never break model
 * selection. Every surface is wrapped inside `ctx.effect`, so unloading the
 * plugin restores the original methods.
 *
 * The Settings page reads and writes the same Config through two small Host
 * routes: `GET /dsh-thinking-levels/catalog` reports every model with the
 * efforts it advertises, and `POST /dsh-thinking-levels/set` persists one
 * choice through `ctx.configEditor`, which writes the profile patch.
 *
 * @module @redhair4740/dsh-thinking-levels
 */

/** Prefix for every diagnostic this plugin writes. */
const TAG = 'thinking-levels'

/** Package specifier, used to locate the profile row that owns this plugin. */
const PACKAGE = '@redhair4740/dsh-thinking-levels'

/** Route paths served for the Settings page. */
const CATALOG_PATH = '/dsh-thinking-levels/catalog'
const SET_PATH = '/dsh-thinking-levels/set'

/** Upper bound for one Settings write body. */
const MAX_BODY_BYTES = 8 * 1024

/**
 * Normalize the Config into lookup entries.
 *
 * Accepted shape (`cordis.patch.yml`):
 * ```yaml
 * config:
 *   models:
 *     - provider: deepseek-official   # optional; matches any provider when absent
 *       model: deepseek-flash
 *       reasoningEffort: low
 * ```
 *
 * @param {unknown} config - raw row Config.
 * @returns {Array<{ provider: string, model: string, reasoningEffort: string }>} valid entries.
 */
function normalizeConfig(config) {
	return normalizeModels(config !== null && typeof config === 'object' ? config.models : undefined)
}

/**
 * Normalize a raw `models` array.
 *
 * @param {unknown} models - raw Config field.
 * @returns {Array<{ provider: string, model: string, reasoningEffort: string }>} valid entries.
 */
function normalizeModels(models) {
	const list = Array.isArray(models) ? models : []
	const entries = []
	for (const item of list) {
		if (item === null || typeof item !== 'object') continue
		const model = typeof item.model === 'string' ? item.model.trim() : ''
		const reasoningEffort = typeof item.reasoningEffort === 'string' ? item.reasoningEffort.trim() : ''
		const provider = typeof item.provider === 'string' ? item.provider.trim() : ''
		if (model === '' || reasoningEffort === '') continue
		entries.push({ provider, model, reasoningEffort })
	}
	return entries
}

/**
 * Find the configured effort for one exact route.
 *
 * An entry naming the provider wins over a provider-less entry; the first
 * provider-less entry is the fallback for every provider.
 *
 * @param {readonly { provider: string, model: string, reasoningEffort: string }[]} entries - normalized Config.
 * @param {string} provider - registered provider route.
 * @param {string} model - provider-owned model id.
 * @returns {string | undefined} configured effort id.
 */
function findEffort(entries, provider, model) {
	let fallback
	for (const entry of entries) {
		if (entry.model !== model) continue
		if (entry.provider === provider) return entry.reasoningEffort
		if (entry.provider === '' && fallback === undefined) fallback = entry.reasoningEffort
	}
	return fallback
}

/**
 * Return the raw entries array a write should start from, keeping fields this
 * plugin does not own (a hand-written comment, a future option) untouched.
 *
 * @param {unknown} models - current raw `models` field.
 * @returns {Record<string, unknown>[]} raw entries.
 */
function rawModels(models) {
	return Array.isArray(models) ? models.filter((item) => item !== null && typeof item === 'object') : []
}

/**
 * Build the next raw `models` value for one model, without dropping other
 * entries or their extra fields.
 *
 * @param {Record<string, unknown>[]} models - current raw entries.
 * @param {string} provider - provider route the write names.
 * @param {string} model - model id the write names.
 * @param {string | null} effort - effort to store, or null to remove the override.
 * @returns {Record<string, unknown>[]} next raw entries.
 */
function nextModels(models, provider, model, effort) {
	const next = []
	let written = false
	for (const item of models) {
		const itemProvider = typeof item.provider === 'string' ? item.provider.trim() : ''
		const itemModel = typeof item.model === 'string' ? item.model.trim() : ''
		if (itemModel !== model || (itemProvider !== provider && itemProvider !== '')) {
			next.push(item)
			continue
		}
		written = true
		if (effort === null) continue
		next.push({ ...item, provider, model, reasoningEffort: effort })
	}
	if (!written && effort !== null) next.push({ provider, model, reasoningEffort: effort })
	return next
}

/**
 * Build one deduplicated warn function so a repeated bad Config entry does not
 * flood the Host log on every catalog fetch.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context.
 * @returns {(message: string) => void} warn sink.
 */
function createWarn(ctx) {
	const seen = new Set()
	return (message) => {
		if (seen.has(message)) return
		seen.add(message)
		const logger = ctx.logger ?? console
		const write = typeof logger.warn === 'function'
			? logger.warn.bind(logger)
			: typeof logger === 'function' ? logger : console.warn
		try {
			write(`${TAG}: ${message}`)
		} catch {
			console.warn(`${TAG}: ${message}`)
		}
	}
}

/**
 * Return whether a model advertises one effort id.
 *
 * @param {unknown} info - resolved model metadata.
 * @param {string} effort - configured effort id.
 * @returns {boolean} true when the effort is selectable for that model.
 */
function supportsEffort(info, effort) {
	const efforts = info?.reasoning?.efforts
	return Array.isArray(efforts) && efforts.some((level) => String(level?.id) === effort)
}

/**
 * Replace a resolved model's default effort with the configured one.
 *
 * @param {Record<string, unknown>} info - metadata from the owning adapter.
 * @param {string} effort - configured effort id.
 * @returns {Record<string, unknown>} original metadata, or a copy with the new default.
 */
function withDefaultEffort(info, effort) {
	const reasoning = info?.reasoning
	if (reasoning === null || typeof reasoning !== 'object') return info
	if (String(reasoning.defaultEffort) === effort) return info
	return { ...info, reasoning: { ...reasoning, defaultEffort: effort } }
}

/**
 * Whether a failure reports an unsupported reasoning effort.
 *
 * @param {unknown} error - failure from `resolveCallConfig`.
 * @returns {boolean} true for the adapter's unsupported-effort rejection.
 */
function isUnsupportedEffort(error) {
	return error !== null && typeof error === 'object' && error.code === 'UNSUPPORTED_REASONING_EFFORT'
}

/**
 * Describe every routable model that advertises reasoning levels, grouped by
 * provider, with the level a selection would currently use.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context.
 * @param {{ entries: { provider: string, model: string, reasoningEffort: string }[] }} state - live overrides.
 * @returns {Promise<Record<string, unknown>>} catalog payload for the Settings page.
 */
async function buildCatalog(ctx, state) {
	const providers = []
	const failures = []
	for (const provider of ctx.llm.listProviders()) {
		try {
			const models = await ctx.llm.listModels(provider.id)
			const entries = (await Promise.all(models.map(async (model) => {
				const info = await ctx.llm.resolveModelInfo(provider.id, model.id)
				const reasoning = info?.reasoning
				if (reasoning === null || typeof reasoning !== 'object' || !Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) {
					return undefined
				}
				const efforts = reasoning.efforts.map((level) => ({
					id: String(level.id),
					name: typeof level.name === 'string' && level.name !== '' ? level.name : String(level.id),
					...(typeof level.description === 'string' ? { description: level.description } : {}),
				}))
				const configured = findEffort(state.entries, provider.id, model.id) ?? null
				const effective = reasoning.defaultEffort === undefined ? null : String(reasoning.defaultEffort)
				return {
					id: model.id,
					name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
					efforts,
					effective,
					configured,
					override: configured !== null && efforts.some((level) => level.id === configured) ? configured : null,
				}
			}))).filter((entry) => entry !== undefined)
			if (entries.length > 0) {
				providers.push({ id: provider.id, name: provider.name ?? provider.id, models: entries })
			}
		} catch (error) {
			failures.push({
				id: provider.id,
				name: provider.name ?? provider.id,
				message: error instanceof Error ? error.message : String(error),
			})
		}
	}
	return {
		ok: true,
		providers,
		failures,
		entries: state.entries.map((entry) => ({ ...entry })),
	}
}

/**
 * Read a JSON request body with a size bound.
 *
 * @param {import('node:http').IncomingMessage} req - request to drain.
 * @returns {Promise<unknown>} parsed body.
 * @throws {Error} when the body exceeds {@link MAX_BODY_BYTES} or is not JSON.
 */
async function readJsonBody(req) {
	const chunks = []
	let bytes = 0
	for await (const chunk of req) {
		bytes += chunk.length
		if (bytes > MAX_BODY_BYTES) throw new Error('request body is too large')
		chunks.push(chunk)
	}
	const text = Buffer.concat(chunks).toString('utf8').trim()
	if (text === '') return undefined
	try {
		return JSON.parse(text)
	} catch {
		throw new Error('request body must be JSON')
	}
}

/**
 * Write one JSON response.
 *
 * @param {import('node:http').ServerResponse} res - response to fill.
 * @param {number} status - HTTP status code.
 * @param {unknown} value - JSON-serializable payload.
 * @returns {void}
 */
function sendJson(res, status, value) {
	const body = JSON.stringify(value)
	res.statusCode = status
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.setHeader('cache-control', 'no-store')
	res.end(body)
}

/**
 * Reject a request the Host/Origin fence or the browser session does not admit.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - context reading the connection service.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @param {import('node:http').ServerResponse} res - response to fill on rejection.
 * @returns {boolean} true when the request was rejected.
 */
function rejected(ctx, req, res) {
	const connection = ctx.get('connection')
	const status = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : undefined
	if (status === undefined) return false
	res.statusCode = status
	res.end()
	return true
}

/**
 * Find the live profile row this plugin owns, which a Settings write targets.
 *
 * @param {{ entries: () => { options?: { name?: string }, id?: string }[] }} editor - config editor service.
 * @param {string | undefined} configuredId - Config override naming the row id.
 * @returns {{ options?: { name?: string }, id?: string } | undefined} live row.
 */
function findOwnEntry(editor, configuredId) {
	const rows = editor.entries()
	if (configuredId !== undefined) {
		const byId = rows.find((row) => row.id === configuredId)
		if (byId !== undefined) return byId
	}
	return rows.find((row) => row.options?.name === PACKAGE)
}

/**
 * Host plugin body: apply the configured default effort to model metadata and
 * call-config resolution, and serve the Settings page's catalog and writes.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context.
 * @param {unknown} config - row Config.
 * @returns {void}
 */
export function apply(ctx, config) {
	const settings = config !== null && typeof config === 'object' ? config : {}
	const state = { entries: normalizeConfig(settings), known: new Map() }
	const warn = createWarn(ctx)
	const llm = ctx.llm
	const effortFor = (provider, model) => findEffort(state.entries, provider, model)
	const routeKey = (provider, model) => `${provider}\u0000${model}`

	const resolveOriginal = llm.resolveModelInfo
	if (typeof resolveOriginal === 'function') {
		ctx.effect(() => {
			llm.resolveModelInfo = async function resolveModelInfo(provider, model, signal) {
				const info = await resolveOriginal.call(this, provider, model, signal)
				const efforts = info?.reasoning?.efforts
				if (Array.isArray(efforts)) {
					state.known.set(routeKey(provider, model), new Set(efforts.map((level) => String(level.id))))
				}
				const effort = effortFor(provider, model)
				if (effort === undefined) return info
				if (!supportsEffort(info, effort)) {
					warn(`model "${provider}/${model}" does not offer reasoning effort "${effort}"; its own default is used`)
					return info
				}
				return withDefaultEffort(info, effort)
			}
			return () => {
				llm.resolveModelInfo = resolveOriginal
			}
		}, `${TAG}: model metadata`)
	}

	const callConfigOriginal = llm.resolveCallConfig
	if (typeof callConfigOriginal === 'function') {
		ctx.effect(() => {
			llm.resolveCallConfig = async function resolveCallConfig(request, signal) {
				if (request === null || typeof request !== 'object' || request.reasoningEffort !== undefined) {
					return callConfigOriginal.call(this, request, signal)
				}
				const effort = effortFor(request.provider, request.model)
				if (effort === undefined) return callConfigOriginal.call(this, request, signal)
				try {
					return await callConfigOriginal.call(this, { ...request, reasoningEffort: effort }, signal)
				} catch (error) {
					if (!isUnsupportedEffort(error)) throw error
					warn(`model "${request.provider}/${request.model}" does not offer reasoning effort "${effort}"; its own default is used`)
					return callConfigOriginal.call(this, request, signal)
				}
			}
			return () => {
				llm.resolveCallConfig = callConfigOriginal
			}
		}, `${TAG}: call defaults`)
	}

	// A fresh Session starts from the deployment default selection, whose explicit
	// effort would otherwise bypass the per-model default. Only an effort this
	// plugin has already seen advertised is injected, so a stale Config entry can
	// never break Session creation.
	const defaultModel = ctx.get('agentDefaultModel')
	if (defaultModel !== undefined && typeof defaultModel.currentSelection === 'function') {
		ctx.effect(() => {
			const original = defaultModel.currentSelection
			defaultModel.currentSelection = function currentSelection() {
				const selection = original.call(this)
				if (selection === null || typeof selection !== 'object') return selection
				const effort = effortFor(selection.provider, selection.model)
				if (effort === undefined) return selection
				const known = state.known.get(routeKey(selection.provider, selection.model))
				if (known === undefined || !known.has(effort)) return selection
				return { ...selection, reasoningEffort: effort }
			}
			return () => {
				defaultModel.currentSelection = original
			}
		}, `${TAG}: deployment default`)
	}

	// Learn which levels every model advertises, so the deployment-default path can
	// be guarded before a selector has loaded the catalog. Best effort: a provider
	// that fails to resolve simply leaves its models unguarded.
	ctx.effect(() => {
		let live = true
		const warm = async () => {
			for (const provider of llm.listProviders()) {
				if (!live) return
				try {
					const models = await llm.listModels(provider.id)
					await Promise.all(models.map((model) => llm.resolveModelInfo(provider.id, model.id).catch(() => undefined)))
				} catch {}
			}
		}
		void warm().catch(() => undefined)
		return () => {
			live = false
		}
	}, `${TAG}: model capability warm-up`)

	const registerRoutes = (webServer, own) => {
		const serveCatalog = async (req, res) => {
			if (rejected(ctx, req, res)) return
			if (req.method !== 'GET') {
				sendJson(res, 405, { ok: false, error: 'method not allowed' })
				return
			}
			try {
				sendJson(res, 200, await buildCatalog(ctx, state))
			} catch (error) {
				sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
			}
		}

		const saveOne = async (req, res) => {
			if (rejected(ctx, req, res)) return
			if (req.method !== 'POST') {
				sendJson(res, 405, { ok: false, error: 'method not allowed' })
				return
			}
			let body
			try {
				body = await readJsonBody(req)
			} catch (error) {
				sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
				return
			}
			const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
			const model = typeof body?.model === 'string' ? body.model.trim() : ''
			const raw = body?.reasoningEffort
			const effort = raw === undefined || raw === null || raw === '' ? null : typeof raw === 'string' ? raw.trim() : undefined
			if (provider === '' || model === '' || effort === undefined) {
				sendJson(res, 400, { ok: false, error: 'provider, model, and reasoningEffort (string or null) are required' })
				return
			}
			const editor = ctx.get('configEditor')
			if (editor === undefined || typeof editor.edit !== 'function') {
				sendJson(res, 503, { ok: false, error: 'this deployment has no configuration editor to persist the choice' })
				return
			}
			const rowId = typeof settings.entryId === 'string' && settings.entryId !== '' ? settings.entryId : undefined
			const entry = findOwnEntry(editor, rowId)
			if (entry === undefined) {
				sendJson(res, 500, { ok: false, error: `no active profile row names ${PACKAGE}` })
				return
			}
			try {
				if (effort !== null) {
					const info = await ctx.llm.resolveModelInfo(provider, model)
					if (!supportsEffort(info, effort)) {
						sendJson(res, 400, { ok: false, error: `model "${provider}/${model}" does not offer reasoning effort "${effort}"` })
						return
					}
				}
				let written
				await editor.edit(entry, (current) => {
					const base = current !== null && typeof current === 'object' ? current : {}
					const models = nextModels(rawModels(base.models), provider, model, effort)
					written = models
					return { ...base, models }
				})
				const models = rawModels(written)
				if (written !== undefined) state.entries = normalizeModels(models)
				sendJson(res, 200, { ok: true, provider, model, reasoningEffort: effort, catalog: await buildCatalog(ctx, state) })
			} catch (error) {
				sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
			}
		}

		own(() => webServer.register({ kind: 'exact', path: CATALOG_PATH, handler: serveCatalog }), `${TAG}: GET ${CATALOG_PATH}`)
		own(() => webServer.register({ kind: 'exact', path: SET_PATH, handler: saveOne }), `${TAG}: POST ${SET_PATH}`)
	}

	// The Web carrier is optional: a headless deployment still gets the model
	// defaults, it only loses the Settings page that edits them.
	const webServer = ctx.get('webServer')
	if (webServer !== undefined) {
		registerRoutes(webServer, (fn, label) => ctx.effect(fn, label))
	} else {
		ctx.inject(['webServer'], (scope) => registerRoutes(scope.webServer, (fn, label) => scope.effect(fn, label)))
	}
}

/** Model metadata, call resolution, and the Web carrier are read before activation. */
export const inject = ['llm']
