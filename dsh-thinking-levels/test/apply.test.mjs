import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'

const EFFORTS = [
	{ id: 'off', name: 'Off' },
	{ id: 'low', name: 'Low' },
	{ id: 'high', name: 'High' },
	{ id: 'max', name: 'Max' },
]

/** Minimal Host context stand-in: effects, child injection, routes, config editor. */
function createContext(options = {}) {
	const disposers = []
	const warnings = []
	const routes = new Map()
	const editor = {
		configs: [{ models: [] }],
		edited: [],
		entries() {
			return [{ id: 'thinking-levels', options: { name: '@redhair4740/dsh-thinking-levels', config: this.configs.at(-1) } }]
		},
		async edit(entry, change) {
			const next = change(entry.options.config ?? {}, entry.options.config ?? {})
			this.edited.push(next)
			this.configs.push(next)
		},
	}
	const ctx = {
		llm: {
			listProviders() {
				return [{ id: 'deepseek-official', name: 'DeepSeek' }]
			},
			async listModels() {
				return [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }, { id: 'text-only', name: 'Text Only' }]
			},
			async resolveModelInfo(provider, model) {
				if (model === 'text-only') return { provider, id: model, name: model }
				return {
					provider,
					id: model,
					name: model,
					reasoning: { efforts: EFFORTS, defaultEffort: 'high' },
				}
			},
			async resolveCallConfig(request) {
				if (request.reasoningEffort !== undefined && !EFFORTS.some((level) => level.id === request.reasoningEffort)) {
					const error = new Error(`unsupported ${request.reasoningEffort}`)
					error.code = 'UNSUPPORTED_REASONING_EFFORT'
					throw error
				}
				return { ...request, reasoningEffort: request.reasoningEffort ?? 'high' }
			},
		},
		webServer: {
			register(route) {
				routes.set(`${route.kind} ${route.path}`, route.handler)
				return () => routes.delete(`${route.kind} ${route.path}`)
			},
		},
		logger: { warn: (message) => warnings.push(message) },
		defaultModel: {
			selection: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
			currentSelection() {
				return { ...this.selection }
			},
		},
		get(name) {
			if (name === 'connection') return options.connection
			if (name === 'configEditor') return options.configEditor === false ? undefined : editor
			if (name === 'webServer') return options.webServer === false ? undefined : ctx.webServer
			if (name === 'agentDefaultModel') return options.defaultModel === false ? undefined : ctx.defaultModel
			return undefined
		},
		inject(_names, callback) {
			const scope = {
				webServer: ctx.webServer,
				effect(fn) {
					disposers.push(fn())
				},
			}
			callback(scope)
		},
		effect(fn) {
			disposers.push(fn())
		},
	}
	return { ctx, warnings, routes, editor, dispose: () => disposers.forEach((dispose) => dispose()) }
}

/** Build a fake request carrying an optional JSON body. */
function createRequest(method, value) {
	const stream = (async function* stream() {
		yield Buffer.from(value === undefined ? '' : JSON.stringify(value))
	})()
	return {
		method,
		url: '/dsh-thinking-levels',
		[Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
	}
}

/** Capture one handler response. */
function createResponse() {
	const response = {
		statusCode: 0,
		headers: {},
		body: '',
		setHeader(name, value) {
			this.headers[name] = value
		},
		end(value) {
			this.body = value ?? ''
		},
	}
	return response
}

/** Invoke a captured route and parse its JSON answer. */
async function call(routes, path, method, payload) {
	const handler = routes.get(`exact ${path}`)
	assert.ok(handler, `route ${path} is registered`)
	const res = createResponse()
	await handler(createRequest(method, payload), res)
	return { status: res.statusCode, json: res.body === '' ? undefined : JSON.parse(res.body) }
}

const config = {
	models: [
		{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
		{ model: 'shared', reasoningEffort: 'off' },
		{ provider: 'deepseek-official', model: 'shared', reasoningEffort: 'max' },
	],
}

test('advertises the configured level as the model default', async () => {
	const { ctx } = createContext()
	const original = ctx.llm.resolveModelInfo
	apply(ctx, config)
	const info = await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')
	assert.equal(info.reasoning.defaultEffort, 'low')
	assert.equal(info.reasoning.efforts.length, 4)
	const other = await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-pro')
	assert.equal(other.reasoning.defaultEffort, 'high')
	assert.notEqual(ctx.llm.resolveModelInfo, original)
})

test('provider-specific entry wins over a provider-less entry', async () => {
	const { ctx } = createContext()
	apply(ctx, config)
	assert.equal((await ctx.llm.resolveModelInfo('deepseek-official', 'shared')).reasoning.defaultEffort, 'max')
	assert.equal((await ctx.llm.resolveModelInfo('other', 'shared')).reasoning.defaultEffort, 'off')
})

test('an unsupported level is ignored and reported once', async () => {
	const { ctx, warnings } = createContext()
	apply(ctx, { models: [{ model: 'deepseek-flash', reasoningEffort: 'medium' }] })
	for (let index = 0; index < 3; index += 1) {
		const info = await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')
		assert.equal(info.reasoning.defaultEffort, 'high')
	}
	assert.equal(warnings.filter((message) => message.includes('medium')).length, 1)
})

test('a model without reasoning metadata is left alone', async () => {
	const { ctx } = createContext()
	apply(ctx, { models: [{ model: 'text-only', reasoningEffort: 'low' }] })
	const info = await ctx.llm.resolveModelInfo('deepseek-official', 'text-only')
	assert.equal(info.reasoning, undefined)
})

test('call config materializes the configured level when no effort is named', async () => {
	const { ctx } = createContext()
	apply(ctx, config)
	const resolved = await ctx.llm.resolveCallConfig({ provider: 'deepseek-official', model: 'deepseek-flash' })
	assert.equal(resolved.reasoningEffort, 'low')
})

test('an explicit effort is never replaced', async () => {
	const { ctx } = createContext()
	apply(ctx, config)
	const resolved = await ctx.llm.resolveCallConfig({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' })
	assert.equal(resolved.reasoningEffort, 'max')
})

test('an unsupported call-config level falls back to the adapter default', async () => {
	const { ctx, warnings } = createContext()
	apply(ctx, { models: [{ model: 'deepseek-flash', reasoningEffort: 'medium' }] })
	const resolved = await ctx.llm.resolveCallConfig({ provider: 'deepseek-official', model: 'deepseek-flash' })
	assert.equal(resolved.reasoningEffort, 'high')
	assert.ok(warnings.some((message) => message.includes('medium')))
})

test('unloading restores both original methods and withdraws the routes', () => {
	const { ctx, routes, dispose } = createContext()
	const resolveModelInfo = ctx.llm.resolveModelInfo
	const resolveCallConfig = ctx.llm.resolveCallConfig
	apply(ctx, config)
	assert.equal(routes.size, 2)
	dispose()
	assert.equal(ctx.llm.resolveModelInfo, resolveModelInfo)
	assert.equal(ctx.llm.resolveCallConfig, resolveCallConfig)
	assert.equal(routes.size, 0)
})

test('malformed entries are dropped without throwing', async () => {
	const { ctx } = createContext()
	apply(ctx, { models: [null, 'x', { model: '', reasoningEffort: 'low' }, { model: 'deepseek-flash', reasoningEffort: 3 }] })
	assert.equal((await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')).reasoning.defaultEffort, 'high')
})

test('the catalog route lists levels, the effective default, and the override', async () => {
	const { ctx, routes } = createContext()
	apply(ctx, config)
	const answer = await call(routes, '/dsh-thinking-levels/catalog', 'GET')
	assert.equal(answer.status, 200)
	assert.equal(answer.json.ok, true)
	const provider = answer.json.providers[0]
	assert.equal(provider.id, 'deepseek-official')
	const flash = provider.models.find((model) => model.id === 'deepseek-flash')
	assert.deepEqual(flash.efforts.map((level) => level.id), ['off', 'low', 'high', 'max'])
	assert.equal(flash.effective, 'low')
	assert.equal(flash.override, 'low')
	assert.equal(provider.models.some((model) => model.id === 'text-only'), false)
})

test('a stale configured level is reported instead of shown as the override', async () => {
	const { ctx, routes } = createContext()
	apply(ctx, { models: [{ model: 'deepseek-flash', reasoningEffort: 'medium' }] })
	const answer = await call(routes, '/dsh-thinking-levels/catalog', 'GET')
	const flash = answer.json.providers[0].models[0]
	assert.equal(flash.configured, 'medium')
	assert.equal(flash.override, null)
	assert.equal(flash.effective, 'high')
})

test('the set route persists one choice and answers with the fresh catalog', async () => {
	const { ctx, routes, editor } = createContext()
	apply(ctx, { models: [] })
	const answer = await call(routes, '/dsh-thinking-levels/set', 'POST', { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' })
	assert.equal(answer.status, 200, JSON.stringify(answer.json))
	assert.deepEqual(editor.edited[0].models, [{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }])
	const flash = answer.json.catalog.providers[0].models[0]
	assert.equal(flash.effective, 'low')
	// the new choice is live without a restart
	assert.equal((await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')).reasoning.defaultEffort, 'low')
})

test('removing an override keeps the other entries', async () => {
	const { ctx, routes, editor } = createContext()
	apply(ctx, { models: [{ model: 'other', reasoningEffort: 'off' }] })
	editor.configs.push({ models: [
		{ model: 'other', reasoningEffort: 'off' },
		{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
	] })
	const answer = await call(routes, '/dsh-thinking-levels/set', 'POST', { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: null })
	assert.equal(answer.status, 200, JSON.stringify(answer.json))
	assert.deepEqual(editor.edited[0].models, [{ model: 'other', reasoningEffort: 'off' }])
	assert.equal((await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')).reasoning.defaultEffort, 'high')
})

test('the set route rejects an unknown provider, model, or level', async () => {
	const { ctx, routes } = createContext()
	apply(ctx, { models: [] })
	const missing = await call(routes, '/dsh-thinking-levels/set', 'POST', { provider: '', model: 'deepseek-flash', reasoningEffort: 'low' })
	assert.equal(missing.status, 400)
	const unsupported = await call(routes, '/dsh-thinking-levels/set', 'POST', { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'medium' })
	assert.equal(unsupported.status, 400)
	assert.match(unsupported.json.error, /does not offer/)
})

test('the set route reports a deployment without a configuration editor', async () => {
	const { ctx, routes } = createContext({ configEditor: false })
	apply(ctx, { models: [] })
	const answer = await call(routes, '/dsh-thinking-levels/set', 'POST', { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' })
	assert.equal(answer.status, 503)
})

test('the routes answer 405 for the wrong method', async () => {
	const { ctx, routes } = createContext()
	apply(ctx, { models: [] })
	const answer = await call(routes, '/dsh-thinking-levels/catalog', 'POST', {})
	assert.equal(answer.status, 405)
})

test('a rejected connection is refused before the handler runs', async () => {
	const { ctx, routes } = createContext({ connection: { requestRejection: () => 401 } })
	apply(ctx, { models: [] })
	const answer = await call(routes, '/dsh-thinking-levels/catalog', 'GET')
	assert.equal(answer.status, 401)
})

test('routes are registered through the carrier that arrives late', async () => {
	const { ctx, routes } = createContext({ webServer: false })
	apply(ctx, { models: [] })
	assert.equal(routes.size, 2)
})

test('a fresh Session starts on the configured level', async () => {
	const { ctx } = createContext()
	apply(ctx, { models: [{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }] })
	await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')
	assert.deepEqual(ctx.defaultModel.currentSelection(), {
		provider: 'deepseek-official',
		model: 'deepseek-flash',
		reasoningEffort: 'low',
	})
})

test('deployment defaults stay untouched for unconfigured or unknown routes', async () => {
	const { ctx } = createContext()
	apply(ctx, { models: [{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }] })
	// a route this plugin has never seen advertised is left exactly as configured
	ctx.defaultModel.selection = { provider: 'elsewhere', model: 'unknown', reasoningEffort: 'max' }
	await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')
	assert.equal(ctx.defaultModel.currentSelection().reasoningEffort, 'max')
	// an unconfigured model keeps its own deployment effort
	ctx.defaultModel.selection = { provider: 'deepseek-official', model: 'other', reasoningEffort: 'high' }
	assert.equal(ctx.defaultModel.currentSelection().reasoningEffort, 'high')
})

test('unloading restores the deployment default reader', () => {
	const { ctx, dispose } = createContext()
	const original = ctx.defaultModel.currentSelection
	apply(ctx, config)
	assert.notEqual(ctx.defaultModel.currentSelection, original)
	dispose()
	assert.equal(ctx.defaultModel.currentSelection, original)
})
