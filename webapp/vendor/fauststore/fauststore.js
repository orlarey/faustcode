// src/store/StoreFormat.ts
var STORE_MANIFEST = "fauststore.json";
var STORE_INDEX = "index.json";
var NAME = /^[A-Za-z0-9_.-]+$/;
function parseStoreRef(text) {
	let t = (text ?? "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
	let ref = null;
	const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/tree\/(.+))?$/.exec(t);
	if (url) {
		t = url[1] + "/" + url[2];
		ref = url[3] ?? null;
	} else {
		const at = t.indexOf("@");
		if (at >= 0) {
			ref = t.slice(at + 1) || null;
			t = t.slice(0, at);
		}
	}
	const [owner, repo, ...rest] = t.split("/");
	if (rest.length || !owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return null;
	if (ref !== null && !/^[A-Za-z0-9_./-]+$/.test(ref)) return null;
	return {
		owner,
		repo,
		ref
	};
}
function parseFileUrl(text) {
	let url;
	try {
		url = new URL((text ?? "").trim());
	} catch {
		return null;
	}
	if (url.protocol != "https:") return null;
	let parts;
	try {
		parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
	} catch {
		return null;
	}
	let owner, repo, at, rest;
	if (url.hostname == "github.com" || url.hostname == "www.github.com") {
		if (parts[2] != "blob" && parts[2] != "raw") return null;
		[owner, repo, , at, ...rest] = parts;
	} else if (url.hostname == "raw.githubusercontent.com") [owner, repo, at, ...rest] = parts;
	else return null;
	const ref = parseStoreRef(`${owner}/${repo}@${at}`);
	const path = rest.join("/");
	return ref && ref.ref && safePath(path) ? {
		ref,
		path
	} : null;
}
var storeKey = (r) => `${r.owner}/${r.repo}` + (r.ref ? "@" + r.ref : "");
function safePath(path) {
	return typeof path == "string" && path.length > 0 && path.length < 512 && !path.startsWith("/") && path.split("/").every((p) => p.length > 0 && p != "." && p != ".." && !p.startsWith("."));
}
var text = (v, max = 2e3) => typeof v == "string" ? v.slice(0, max) : void 0;
var texts = (v) => Array.isArray(v) ? v.filter((s) => typeof s == "string").map((s) => s.slice(0, 200)) : [];
function parseManifest(json) {
	const m = json;
	if (!m || m.format != "fauststore" || typeof m.version != "number" || m.version < 1 || m.version >= 2) return null;
	return {
		format: "fauststore",
		version: m.version,
		name: text(m.name, 200) ?? "",
		description: text(m.description),
		author: text(m.author, 200),
		license: text(m.license, 100),
		language: text(m.language, 20)
	};
}
var SHA = /^[0-9a-f]{40}$/;
var sha = (v) => typeof v == "string" && SHA.test(v) ? v : void 0;
var date = (v) => typeof v == "string" && v.length < 40 ? v : void 0;
function parseIndex(json) {
	const x = json;
	if (!x || x.format != "fauststore-index" || !Array.isArray(x.modules) || !Array.isArray(x.scenes)) return null;
	const modules = x.modules.filter((m) => m && safePath(m.path) && /\.dsp$/i.test(m.path)).map((m) => ({
		path: m.path,
		name: text(m.name, 200) || nameOfPath(m.path),
		author: text(m.author, 200),
		license: text(m.license, 100),
		summary: text(m.summary, 500) ?? "",
		description: text(m.description, 5e3) ?? "",
		functions: texts(m.functions),
		inlets: texts(m.inlets),
		outlets: texts(m.outlets),
		code: sha(m.code),
		sha: sha(m.sha),
		updated: date(m.updated),
		versions: Array.isArray(m.versions) ? m.versions.filter((v) => v && sha(v.code) && sha(v.commit)).map((v) => ({
			code: v.code,
			commit: v.commit,
			date: date(v.date)
		})) : void 0
	}));
	const scenes = x.scenes.filter((s) => s && safePath(s.path) && /\.(jfaust|json)$/i.test(s.path)).map((s) => ({
		path: s.path,
		name: text(s.name, 200) || nameOfPath(s.path),
		summary: text(s.summary, 500),
		author: text(s.author, 200),
		preview: safePath(s.preview) ? s.preview : void 0,
		sha: sha(s.sha),
		updated: date(s.updated),
		codes: Array.isArray(s.codes) ? s.codes.filter((c) => sha(c)) : void 0,
		recordings: Array.isArray(s.recordings) ? s.recordings.filter((m) => safePath(m)) : void 0
	}));
	const materials = Array.isArray(x.materials) ? x.materials.map((m) => m && safePath(m.path) ? parseMaterial(m, m.path, sha(m.sha)) : null).filter((m) => !!m) : void 0;
	return materials ? {
		modules,
		scenes,
		materials
	} : {
		modules,
		scenes
	};
}
var num = (v) => typeof v == "number" && Number.isFinite(v) ? v : void 0;
function parseMaterial(json, path, blob) {
	const m = json;
	if (!m || !safePath(path) || !/^materials\/.+\.json$/i.test(path)) return null;
	if (m.format !== void 0 && m.format != "fauststore-material") return null;
	const dir = path.slice(0, path.lastIndexOf("/") + 1);
	const mediaPath = typeof m.media?.path == "string" ? m.media.path.includes("/") ? m.media.path : dir + m.media.path : void 0;
	const out = {
		path,
		name: text(m.name, 200) || nameOfPath(path),
		kind: text(m.kind, 40) ?? "recording",
		media: mediaPath && safePath(mediaPath) ? {
			path: mediaPath,
			type: text(m.media.type, 60) ?? "application/octet-stream",
			sha1: sha(m.media.sha1),
			size: num(m.media.size)
		} : void 0,
		sampleRate: num(m.sampleRate),
		channels: num(m.channels),
		frames: num(m.frames),
		recordingOf: safePath(m.recordingOf) ? m.recordingOf : void 0,
		from: m.from && safePath(m.from.path) ? {
			store: text(m.from.store, 200),
			path: m.from.path,
			sha1: sha(m.from.sha1),
			commit: sha(m.from.commit)
		} : void 0,
		generator: text(m.generator, 100),
		timeline: m.timeline && [
			m.timeline.tempo,
			m.timeline.meter,
			m.timeline.startTick,
			m.timeline.lengthTicks
		].every((v) => num(v) !== void 0) ? {
			tempo: m.timeline.tempo,
			meter: m.timeline.meter,
			startTick: m.timeline.startTick,
			lengthTicks: m.timeline.lengthTicks
		} : void 0,
		live: Array.isArray(m.live) ? texts(m.live) : void 0,
		date: date(m.date),
		sha: blob
	};
	if (!out.recordingOf && out.from && !out.from.store) out.recordingOf = out.from.path;
	return out;
}
function nameOfPath(path) {
	return path.split("/").pop().replace(/\.[^.]*$/, "");
}
function declared(code, key) {
	const m = new RegExp(`^\\s*declare\\s+${key}\\s+"([^"]*)"\\s*;`, "m").exec(code);
	return m ? m[1] : void 0;
}
function moduleEntry(path, code) {
	const list = (v) => (v ?? "").split(";").map((s) => s.trim()).filter(Boolean);
	const comment = /\/\*\s*=+\s*DESCRIPTION\s*=+\s*([\s\S]*?)\*\//.exec(code);
	const description = comment ? comment[1].trim() : "";
	return {
		path,
		name: declared(code, "name") ?? nameOfPath(path),
		author: declared(code, "author"),
		license: declared(code, "license"),
		summary: declared(code, "summary") ?? description.split("\n")[0]?.replace(/^- /, "") ?? "",
		description,
		functions: [declared(code, "function"), declared(code, "function2")].filter((f) => !!f),
		inlets: list(declared(code, "inlets")),
		outlets: list(declared(code, "outlets"))
	};
}
function contentsOf(paths) {
	const safe = paths.filter(safePath);
	return {
		modules: safe.filter((p) => p.startsWith("modules/") && /\.dsp$/i.test(p)).sort(),
		scenes: safe.filter((p) => p.startsWith("scenes/") && /\.jfaust$/i.test(p)).sort(),
		materials: safe.filter((p) => /^materials\/[^/]+\/[^/]+\.json$/i.test(p)).sort()
	};
}
function slug(name) {
	return (name ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "Untitled";
}
var modulePath = (name) => `modules/${slug(name)}/${slug(name)}.dsp`;
var scenePath = (name) => `scenes/${slug(name)}/${slug(name)}.jfaust`;
var materialPath = (name) => `materials/${slug(name)}/${slug(name)}.json`;
async function gitBlobSha(text) {
	const body = new TextEncoder().encode(text);
	const head = new TextEncoder().encode(`blob ${body.length}\0`);
	const all = new Uint8Array(head.length + body.length);
	all.set(head);
	all.set(body, head.length);
	const digest = await globalThis.crypto.subtle.digest("SHA-1", all);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function serializeIndex(index, updated) {
	const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== void 0));
	return JSON.stringify({
		format: "fauststore-index",
		version: 1,
		updated,
		modules: index.modules.map(clean),
		scenes: index.scenes.map(clean),
		...index.materials?.length ? { materials: index.materials.map((m) => clean({
			...m,
			media: m.media && clean(m.media)
		})) } : {}
	}, null, 1) + "\n";
}
// src/model/ModuleCode.ts
var WRAPPED = /^\s*process\s*=\s*vgroup\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*environment\s*\{([\s\S]*)\}\s*\.process\s*\)\s*;\s*$/;
function wrapModuleCode(name, code) {
	return `process = vgroup("${name.replace(/["\\]/g, "_")}",environment{\n${code}\n}.process);`;
}
function unwrapModuleCode(code) {
	const match = WRAPPED.exec(code);
	if (!match) return null;
	return {
		name: match[1],
		code: match[2].replace(/^\n/, "").replace(/\n$/, "")
	};
}
function userCode(code) {
	return unwrapModuleCode(code)?.code ?? code;
}
// src/documents/Sha1.ts
function normalizeText(text) {
	return text.replace(/\r\n?/g, "\n");
}
async function sha1(text) {
	const bytes = new TextEncoder().encode(normalizeText(text));
	const digest = await globalThis.crypto.subtle.digest("SHA-1", bytes);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
// src/store/StoreIndex.ts
async function sceneCodes(content) {
	try {
		const codes = (JSON.parse(content).modules ?? []).filter((m) => m?.kind == "faust" && typeof m.code == "string").map((m) => unwrapModuleCode(m.code)?.code ?? m.code);
		return [...new Set(await Promise.all(codes.map((c) => sha1(c))))];
	} catch {
		return [];
	}
}
function sceneNameIn(content) {
	try {
		const name = JSON.parse(content)?.sceneName;
		return typeof name == "string" && name.trim() ? name.trim().slice(0, 200) : null;
	} catch {
		return null;
	}
}
async function buildIndex(tree, before, read, changes) {
	const shas = new Map(tree.map((e) => [e.path, e.sha]));
	for (const path of changes?.files.keys() ?? []) if (!shas.has(path)) shas.set(path, void 0);
	const { modules, scenes, materials } = contentsOf([...shas.keys()]);
	const previous = new Map((before?.modules ?? []).map((m) => [m.path, m]));
	const previousScenes = new Map((before?.scenes ?? []).map((s) => [s.path, s]));
	const builtModules = await Promise.all(modules.map(async (path) => {
		const old = previous.get(path);
		const published = changes?.files.get(path);
		if (published === void 0 && old && old.sha && old.sha == shas.get(path)) return old;
		let content;
		try {
			content = published ?? await read(path);
		} catch {
			return null;
		}
		const entry = {
			...moduleEntry(path, content),
			code: await sha1(content),
			sha: await gitBlobSha(content)
		};
		entry.versions = old?.versions ?? [];
		entry.updated = old?.updated;
		if (old?.code && old.code != entry.code) entry.versions = [{
			code: old.code,
			commit: changes?.parent ?? "",
			date: old.updated
		}, ...entry.versions].filter((v) => v.commit);
		if (!old || old.code != entry.code) entry.updated = changes?.date ?? entry.updated;
		if (entry.versions.length == 0) entry.versions = void 0;
		return entry;
	}));
	const builtScenes = await Promise.all(scenes.map(async (path) => {
		const old = previousScenes.get(path);
		const published = changes?.files.get(path);
		const named = async (entry) => {
			if (!changes || entry.name != nameOfPath(path)) return entry;
			try {
				return {
					...entry,
					name: sceneNameIn(await read(path)) ?? entry.name
				};
			} catch {
				return entry;
			}
		};
		if (published === void 0 && old && (old.sha === void 0 || old.sha == shas.get(path))) return named({
			...old,
			sha: shas.get(path) ?? old.sha
		});
		const entry = {
			path,
			name: old?.name ?? nameOfPath(path),
			summary: old?.summary,
			author: old?.author,
			preview: old?.preview,
			sha: shas.get(path)
		};
		if (published !== void 0) {
			entry.name = sceneNameIn(published) ?? entry.name;
			entry.sha = await gitBlobSha(published);
			entry.codes = await sceneCodes(published);
			entry.updated = changes.date;
		} else {
			entry.codes = old?.codes;
			entry.updated = old?.updated;
			return named(entry);
		}
		return entry;
	}));
	const previousMaterials = new Map((before?.materials ?? []).map((m) => [m.path, m]));
	const kept = (await Promise.all(materials.map(async (path) => {
		const old = previousMaterials.get(path);
		const published = changes?.files.get(path);
		if (published === void 0 && old && old.sha && old.sha == shas.get(path)) return old;
		let content;
		try {
			content = published ?? await read(path);
		} catch {
			return null;
		}
		try {
			return parseMaterial(JSON.parse(content), path, await gitBlobSha(content));
		} catch {
			return null;
		}
	}))).filter((m) => m !== null);
	for (const scene of builtScenes) {
		const recordings = kept.filter((m) => m.recordingOf == scene.path).map((m) => m.path);
		scene.recordings = recordings.length ? recordings : void 0;
	}
	const index = {
		modules: builtModules.filter((m) => m !== null),
		scenes: builtScenes
	};
	if (kept.length) index.materials = kept;
	return index;
}
// src/store/StoreReader.ts
var GITHUB = {
	raw: "https://raw.githubusercontent.com",
	api: "https://api.github.com"
};
var StoreError = class extends Error {
	constructor(reason, message) {
		super(message);
		this.reason = reason;
	}
};
var StoreReader = class {
	constructor(fFetch = (url, init) => fetch(url, init), fEndpoints = GITHUB) {
		this.fFetch = fFetch;
		this.fEndpoints = fEndpoints;
	}
	rawUrl(ref, path) {
		const encoded = path.split("/").map(encodeURIComponent).join("/");
		return `${this.fEndpoints.raw}/${ref.owner}/${ref.repo}/${ref.ref ?? "HEAD"}/${encoded}`;
	}
	apiUrl(ref, rest) {
		return `${this.fEndpoints.api}/repos/${ref.owner}/${ref.repo}/${rest}`;
	}
	api(url, token, accept = "application/vnd.github+json") {
		const headers = { Accept: accept };
		if (token) headers.Authorization = `Bearer ${token}`;
		return this.fFetch(url, token ? { headers } : void 0);
	}
	async text(ref, path, token) {
		let response;
		try {
			const encoded = path.split("/").map(encodeURIComponent).join("/");
			response = token ? await this.api(this.apiUrl(ref, `contents/${encoded}`) + (ref.ref ? `?ref=${encodeURIComponent(ref.ref)}` : ""), token, "application/vnd.github.raw") : await this.fFetch(this.rawUrl(ref, path));
		} catch (e) {
			throw new StoreError("network", String(e));
		}
		if (response.status == 404) throw new StoreError("notFound", path);
		if (!response.ok) throw new StoreError("network", `${response.status} ${path}`);
		return response.text();
	}
	async open(ref, token) {
		let manifest = null;
		try {
			manifest = parseManifest(JSON.parse(await this.text(ref, STORE_MANIFEST, token)));
		} catch (e) {
			if (e instanceof StoreError) throw e;
			throw new StoreError("notAStore", STORE_MANIFEST);
		}
		if (!manifest) throw new StoreError("notAStore", STORE_MANIFEST);
		let index = null;
		try {
			index = parseIndex(JSON.parse(await this.text(ref, STORE_INDEX, token)));
		} catch {}
		let tree;
		try {
			tree = await this.tree(ref, token);
		} catch (e) {
			if (index) return {
				ref,
				manifest,
				index,
				rebuilt: false
			};
			throw e;
		}
		return {
			ref,
			manifest,
			index: await buildIndex(tree, index, (path) => this.text(ref, path, token)),
			rebuilt: !index
		};
	}
	async commitOf(ref, token) {
		try {
			const response = await this.api(this.apiUrl(ref, `commits/${encodeURIComponent(ref.ref ?? "HEAD")}`), token, "application/vnd.github.sha");
			if (!response.ok) return null;
			const text = (await response.text()).trim();
			const sha = text.startsWith("{") ? JSON.parse(text)?.sha : text;
			return typeof sha == "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
		} catch {
			return null;
		}
	}
	async tree(ref, token) {
		let response;
		try {
			response = await this.api(this.apiUrl(ref, `git/trees/${encodeURIComponent(ref.ref ?? "HEAD")}?recursive=1`), token);
		} catch (e) {
			throw new StoreError("network", String(e));
		}
		if (!response.ok) throw new StoreError(response.status == 404 ? "notFound" : "network", `${response.status} git/trees`);
		return ((await response.json())?.tree ?? []).filter((e) => e?.type == "blob" && typeof e.path == "string").map((e) => ({
			path: e.path,
			sha: e.sha
		}));
	}
};
// src/store/StorePublisher.ts
function base64(bytes) {
	let bin = "";
	for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
	return btoa(bin);
}
var PublishError = class extends Error {
	constructor(reason, message) {
		super(message);
		this.reason = reason;
	}
};
var StorePublisher = class {
	constructor(fFetch = (url, init) => fetch(url, init), fEndpoints = GITHUB) {
		this.fFetch = fFetch;
		this.fEndpoints = fEndpoints;
	}
	async call(ref, token, rest, init = {}) {
		let response;
		try {
			response = await this.fFetch(`${this.fEndpoints.api}/repos/${ref.owner}/${ref.repo}${rest}`, {
				method: init.method ?? "GET",
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					...init.body ? { "Content-Type": "application/json" } : {}
				},
				body: init.body ? JSON.stringify(init.body) : void 0
			});
		} catch (e) {
			throw new PublishError("network", String(e));
		}
		if (response.status == 401) throw new PublishError("token", rest);
		if (response.status == 403) throw new PublishError("rights", rest);
		if (response.status == 404) throw new PublishError("notFound", rest);
		if (response.status == 409) throw new PublishError("empty", rest);
		if (response.status == 422) throw new PublishError("conflict", rest);
		if (!response.ok) throw new PublishError("network", `${response.status} ${rest}`);
		return response.json();
	}
	async verify(ref, token) {
		const repo = await this.call(ref, token, "");
		if (!repo?.permissions?.push) throw new PublishError("rights", "push");
		return {
			branch: ref.ref ?? repo.default_branch,
			private: !!repo.private
		};
	}
	async branch(ref, token, name) {
		const head = await this.call(ref, token, `/git/ref/heads/${encodeURIComponent(name)}`);
		const commit = await this.call(ref, token, `/git/commits/${head.object.sha}`);
		const tree = await this.call(ref, token, `/git/trees/${commit.tree.sha}?recursive=1`);
		return {
			name,
			commit: head.object.sha,
			tree: (tree.tree ?? []).filter((e) => e.type == "blob").map((e) => ({
				path: e.path,
				sha: e.sha
			}))
		};
	}
	async publish(ref, token, make) {
		const { branch: name } = await this.verify(ref, token);
		for (let attempt = 0; attempt < 3; attempt++) {
			const branch = await this.branch(ref, token, name);
			const { files, message } = await make(branch);
			const base = (await this.call(ref, token, `/git/commits/${branch.commit}`)).tree.sha;
			const entries = await Promise.all(files.map(async (f) => {
				if ("content" in f) return {
					path: f.path,
					mode: "100644",
					type: "blob",
					content: f.content
				};
				const blob = await this.call(ref, token, "/git/blobs", {
					method: "POST",
					body: {
						content: base64(f.bytes),
						encoding: "base64"
					}
				});
				return {
					path: f.path,
					mode: "100644",
					type: "blob",
					sha: blob.sha
				};
			}));
			const tree = await this.call(ref, token, "/git/trees", {
				method: "POST",
				body: {
					base_tree: base,
					tree: entries
				}
			});
			const commit = await this.call(ref, token, "/git/commits", {
				method: "POST",
				body: {
					message,
					tree: tree.sha,
					parents: [branch.commit]
				}
			});
			try {
				await this.call(ref, token, `/git/refs/heads/${encodeURIComponent(name)}`, {
					method: "PATCH",
					body: {
						sha: commit.sha,
						force: false
					}
				});
				return {
					commit: commit.sha,
					branch: name
				};
			} catch (e) {
				if (!(e instanceof PublishError) || e.reason != "conflict") throw e;
			}
		}
		throw new PublishError("conflict", "the branch keeps moving");
	}
};
// src/store/Stores.ts
var STORES_KEY = "faustmodular:stores";
var TOKENS_KEY = "faustmodular:store-tokens";
var KEY = STORES_KEY;
var Stores = class Stores {
	constructor(reader = new StoreReader(), fStorage = Stores.storage()) {
		this.reader = reader;
		this.fStorage = fStorage;
		this.fStates = /* @__PURE__ */ new Map();
		this.fListeners = [];
		this.tokenFor = () => void 0;
		for (const key of this.saved()) {
			const ref = parseStoreRef(key);
			if (ref) this.fStates.set(key, {
				key,
				ref,
				status: "loading"
			});
		}
	}
	static storage() {
		try {
			return localStorage;
		} catch {
			return null;
		}
	}
	saved() {
		try {
			const list = JSON.parse(this.fStorage?.getItem(KEY) ?? "[]");
			return Array.isArray(list) ? list.filter((k) => typeof k == "string") : [];
		} catch {
			return [];
		}
	}
	save() {
		try {
			this.fStorage?.setItem(KEY, JSON.stringify([...this.fStates.keys()]));
		} catch {}
	}
	onChange(listener) {
		this.fListeners.push(listener);
	}
	emit() {
		this.fListeners.forEach((l) => l());
	}
	list() {
		return [...this.fStates.values()];
	}
	get(key) {
		return this.fStates.get(key);
	}
	loadAll() {
		return Promise.all(this.list().map((s) => this.load(s.key))).then(() => void 0);
	}
	async load(key) {
		const state = this.fStates.get(key);
		if (!state) return void 0;
		state.status = "loading";
		this.emit();
		try {
			state.store = await this.reader.open(state.ref, this.tokenFor(key));
			state.status = "ready";
			state.error = void 0;
		} catch (e) {
			state.status = "error";
			state.error = e instanceof StoreError ? e.reason : "network";
		}
		this.emit();
		return state;
	}
	async follow(text) {
		const ref = parseStoreRef(text);
		if (!ref) throw new StoreError("notFound", text);
		const key = storeKey(ref);
		const known = this.fStates.get(key);
		if (known?.status == "ready") return known;
		this.fStates.set(key, {
			key,
			ref,
			status: "loading"
		});
		const state = await this.load(key);
		if (state.status == "error" && !known) {
			this.fStates.delete(key);
			this.emit();
			throw new StoreError(state.error, key);
		}
		this.save();
		return state;
	}
	unfollow(key) {
		if (!this.fStates.delete(key)) return;
		this.save();
		this.emit();
	}
	refresh(key) {
		return this.load(key);
	}
	async syncFromStorage() {
		const saved = new Set(this.saved());
		let changed = false;
		for (const key of [...this.fStates.keys()]) if (!saved.has(key)) {
			this.fStates.delete(key);
			changed = true;
		}
		const added = [];
		for (const key of saved) {
			const ref = parseStoreRef(key);
			if (ref && !this.fStates.has(key)) {
				this.fStates.set(key, {
					key,
					ref,
					status: "loading"
				});
				added.push(key);
			}
		}
		if (changed && !added.length) this.emit();
		await Promise.all(added.map((key) => this.load(key)));
	}
	watch(target = window) {
		let tokens = this.tokenSnapshot();
		target.addEventListener("storage", (e) => {
			if (e.key === "faustmodular:stores" || e.key === null) this.syncFromStorage();
			if (e.key === "faustmodular:store-tokens" || e.key === null) {
				const now = this.tokenSnapshot();
				for (const s of this.list()) if (now.get(s.key) !== tokens.get(s.key)) this.refresh(s.key);
				tokens = now;
			}
		});
	}
	tokenSnapshot() {
		return new Map(this.list().map((s) => [s.key, this.tokenFor(s.key)]));
	}
};
// src/store/Publishing.ts
var TOKENS = TOKENS_KEY;
var OLD_REPO = "faustmodular:my-store";
var OLD_TOKEN = "faustmodular:my-store-token";
var StoreTokens = class StoreTokens {
	constructor(fStorage = StoreTokens.storage()) {
		this.fStorage = fStorage;
		try {
			const repo = this.fStorage?.getItem(OLD_REPO), token = this.fStorage?.getItem(OLD_TOKEN);
			if (repo && token && !this.get(repo)) this.set(repo, token);
			this.fStorage?.removeItem(OLD_REPO);
			this.fStorage?.removeItem(OLD_TOKEN);
		} catch {}
	}
	static storage() {
		try {
			return localStorage;
		} catch {
			return null;
		}
	}
	all() {
		try {
			const x = JSON.parse(this.fStorage?.getItem(TOKENS) ?? "{}");
			return x && typeof x == "object" ? x : {};
		} catch {
			return {};
		}
	}
	write(all) {
		try {
			this.fStorage?.setItem(TOKENS, JSON.stringify(all));
		} catch {}
	}
	get(key) {
		return this.all()[key];
	}
	set(key, token) {
		this.write({
			...this.all(),
			[key]: token
		});
	}
	remove(key) {
		const all = this.all();
		delete all[key];
		this.write(all);
	}
	keys() {
		return Object.keys(this.all());
	}
};
var MAX_MEDIA = 52428800;
function shareLink(app, ref, commit, path) {
	return `${app}?scene=https://github.com/${ref.owner}/${ref.repo}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
var Publishing = class {
	constructor(tokens, stores, publisher = new StorePublisher()) {
		this.tokens = tokens;
		this.stores = stores;
		this.publisher = publisher;
		stores.tokenFor = (key) => this.tokens.get(key);
	}
	writable() {
		return this.stores.list().map((s) => s.key).filter((key) => !!this.tokens.get(key));
	}
	async configure(store, token) {
		const ref = parseStoreRef(store);
		if (!ref) throw new PublishError("notFound", store);
		const verified = await this.publisher.verify(ref, token.trim());
		const key = storeKey(ref);
		this.tokens.set(key, token.trim());
		if (this.stores.get(key)) await this.stores.refresh(key);
		else await this.stores.follow(key);
		return {
			key,
			...verified
		};
	}
	forget(store) {
		this.tokens.remove(store);
		this.stores.refresh(store);
	}
	target(store) {
		const ref = parseStoreRef(store), token = this.tokens.get(store);
		if (!ref || !token) throw new PublishError("token", store);
		return {
			ref,
			token
		};
	}
	async exists(store, path) {
		const { ref, token } = this.target(store);
		const { branch } = await this.publisher.verify(ref, token);
		return (await this.publisher.branch(ref, token, branch)).tree.some((e) => e.path == path);
	}
	async publish(store, files, message) {
		const { ref, token } = this.target(store);
		let index = {
			modules: [],
			scenes: []
		};
		const result = await this.publisher.publish(ref, token, async (branch) => {
			const at = {
				...ref,
				ref: branch.commit
			};
			let before = null;
			try {
				before = parseIndex(JSON.parse(await this.stores.reader.text(at, STORE_INDEX, token)));
			} catch {}
			const date = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "Z");
			const texts = new Map([...files].filter((e) => typeof e[1] == "string"));
			index = await buildIndex(branch.tree, before, (path) => this.stores.reader.text(at, path, token), {
				files: texts,
				parent: branch.commit,
				date
			});
			return {
				files: [...[...files].map(([path, content]) => typeof content == "string" ? {
					path,
					content
				} : {
					path,
					bytes: content
				}), {
					path: STORE_INDEX,
					content: serializeIndex(index, date)
				}],
				message
			};
		});
		const key = storeKey(ref);
		if (this.stores.get(key)) await this.stores.refresh(key);
		else await this.stores.follow(key);
		return {
			...result,
			index
		};
	}
	async publishScene(store, name, content, modules = /* @__PURE__ */ new Map()) {
		const path = scenePath(name);
		const replaced = await this.exists(store, path);
		const files = new Map([[path, content], ...modules]);
		const what = `the scene ${name}` + (modules.size ? ` and ${modules.size} module${modules.size > 1 ? "s" : ""} (${[...modules.keys()].map((p) => p.split("/")[1]).join(", ")})` : "");
		const { commit, branch } = await this.publish(store, files, `${replaced ? "Publish again" : "Publish"} ${what} (faustmodular)`);
		return {
			store,
			path,
			commit,
			branch,
			replaced,
			modules: [...modules.keys()]
		};
	}
	async publishRecording(store, name, content, modules, recording) {
		if (recording.flac.length > 52428800) throw new Error(`the recording is ${Math.round(recording.flac.length / 1048576)} MB (50 MB at most in a store)`);
		const path = scenePath(name);
		const replaced = await this.exists(store, path);
		const description = materialPath(recording.name);
		const dir = description.slice(0, description.lastIndexOf("/") + 1);
		const media = dir + description.slice(dir.length).replace(/\.json$/, ".flac");
		const fiche = {
			format: "fauststore-material",
			version: 1,
			kind: "recording",
			name: recording.name,
			...recording.description,
			media: {
				path: media.slice(dir.length),
				type: "audio/flac",
				sha1: await bytesSha1(recording.flac),
				size: recording.flac.length
			},
			recordingOf: path,
			from: {
				path,
				sha1: await sha1(content)
			}
		};
		const files = new Map([
			[path, content],
			...modules,
			[media, recording.flac],
			[description, JSON.stringify(fiche, null, 1) + "\n"]
		]);
		const what = `the scene ${name}, its recording ${recording.name}` + (modules.size ? ` and ${modules.size} module${modules.size > 1 ? "s" : ""} (${[...modules.keys()].map((p) => p.split("/")[1]).join(", ")})` : "");
		const { commit, branch } = await this.publish(store, files, `${replaced ? "Publish again" : "Publish"} ${what} (faustmodular)`);
		return {
			store,
			path,
			commit,
			branch,
			replaced,
			modules: [...modules.keys()],
			material: description
		};
	}
	async publishModule(store, name, code) {
		const path = modulePath(name);
		const replaced = await this.exists(store, path);
		const { commit, branch } = await this.publish(store, /* @__PURE__ */ new Map([[path, code]]), `${replaced ? "Publish a new version of" : "Publish"} the module ${name} (faustmodular)`);
		return {
			store,
			path,
			commit,
			branch,
			replaced
		};
	}
};
async function bytesSha1(bytes) {
	const digest = await globalThis.crypto.subtle.digest("SHA-1", bytes);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
// src/store/StoreLink.ts
function storeLink(search, param = "scene") {
	const params = new URLSearchParams(search);
	const scene = params.get(param);
	const file = !params.get("store") && scene ? parseFileUrl(scene) : null;
	if (file) return {
		store: storeKey(file.ref),
		scene: file.path
	};
	const ref = parseStoreRef(params.get("store") ?? "");
	if (!ref) return null;
	const at = params.get("ref");
	if (at && /^[A-Za-z0-9_./-]+$/.test(at)) ref.ref = at;
	return {
		store: storeKey(ref),
		scene: scene && safePath(scene) ? scene : void 0
	};
}
function withoutStoreLink(href, param = "scene") {
	const url = new URL(href);
	for (const p of [
		"store",
		param,
		"ref"
	]) url.searchParams.delete(p);
	return url.pathname + (url.searchParams.toString() ? "?" + url.searchParams : "") + url.hash;
}
// src/store/ScenePlan.ts
function libraryShas(index) {
	const shas = /* @__PURE__ */ new Map();
	for (const [path, sha] of Object.entries(index?.modules ?? {})) shas.set(sha, path);
	for (const [sha, entry] of Object.entries(index?.history ?? {})) if (!shas.has(sha)) shas.set(sha, entry.path);
	return shas;
}
function planSceneModules(modules, index, library) {
	const inStore = new Map((index?.modules ?? []).map((m) => [m.path, m]));
	const taken = /* @__PURE__ */ new Map();
	const free = (name) => {
		for (let n = 2;; n++) {
			const path = modulePath(`${name}-${n}`);
			if (!inStore.has(path) && !taken.has(path)) return path;
		}
	};
	const rows = [];
	const seen = /* @__PURE__ */ new Set();
	for (const m of modules) {
		if (seen.has(m.sha)) continue;
		seen.add(m.sha);
		const path = modulePath(m.name);
		if (library.has(m.sha)) {
			rows.push({
				...m,
				path,
				status: "library",
				library: library.get(m.sha),
				choice: "skip"
			});
			continue;
		}
		const entry = inStore.get(path);
		if (taken.get(path) !== void 0) {
			const other = free(m.name);
			taken.set(other, m.sha);
			rows.push({
				...m,
				path,
				status: "conflict",
				other,
				choice: "other",
				inScene: true
			});
		} else if (!entry) {
			taken.set(path, m.sha);
			rows.push({
				...m,
				path,
				status: "new",
				choice: "publish"
			});
		} else if (entry.code == m.sha) {
			taken.set(path, m.sha);
			rows.push({
				...m,
				path,
				status: "same",
				choice: "skip"
			});
		} else if (entry.versions?.some((v) => v.code == m.sha)) {
			taken.set(path, m.sha);
			rows.push({
				...m,
				path,
				status: "older",
				choice: "skip"
			});
		} else {
			const other = free(m.name);
			taken.set(path, m.sha);
			rows.push({
				...m,
				path,
				status: "conflict",
				other,
				choice: "version"
			});
		}
	}
	return rows;
}
function planFiles(rows) {
	const files = /* @__PURE__ */ new Map();
	for (const r of rows) if (r.choice == "publish" || r.choice == "version") files.set(r.path, r.code);
	else if (r.choice == "other" && r.other) files.set(r.other, r.code);
	return files;
}
// src/store/fauststore.ts
var FAUSTSTORE_VERSION = "1.1.0";
export { FAUSTSTORE_VERSION, GITHUB, MAX_MEDIA, PublishError, Publishing, STORES_KEY, STORE_INDEX, STORE_MANIFEST, StoreError, StorePublisher, StoreReader, StoreTokens, Stores, TOKENS_KEY, buildIndex, contentsOf, gitBlobSha, libraryShas, materialPath, moduleEntry, modulePath, nameOfPath, normalizeText, parseFileUrl, parseIndex, parseManifest, parseMaterial, parseStoreRef, planFiles, planSceneModules, safePath, sceneCodes, sceneNameIn, scenePath, serializeIndex, sha1, shareLink, slug, storeKey, storeLink, unwrapModuleCode, userCode, withoutStoreLink, wrapModuleCode };
