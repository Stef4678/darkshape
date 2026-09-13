/*
 * Interface smoke test for Darkshape.
 *
 * Runs the real index.html in jsdom and drives the real app.js, in two
 * configurations:
 *
 *   Phase A  static  — every id app.js looks up exists in the markup, and
 *                      every local asset the page references is on disk.
 *   Phase B  standalone — the plugin booted outside Eagle (clear degraded
 *                      state, controls, view switching, reset).
 *   Phase C  hosted  — a mocked Eagle host. Verifies the selection is
 *                      loaded, unsupported formats are skipped, the batch
 *                      export runs, items are imported with the right
 *                      names/folders/tags and the staging files are
 *                      cleaned up.
 *
 * The raster layer is stubbed (jsdom has no canvas): HTMLCanvasElement is
 * patched to return synthetic pixels, so the *real* silhouette engine
 * still runs end to end inside the test.
 *
 * Usage: node tests/dom-smoke.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

/**
 * Loads jsdom from wherever it was installed. A fresh clone puts it in
 * `node_modules/` via `npm install`; the machine this was written on keeps it
 * in `.devtools/`. Try both.
 */
let JSDOM, VirtualConsole;
try {
	({ JSDOM, VirtualConsole } = require(path.join(ROOT, '.devtools', 'node_modules', 'jsdom')));
} catch (err) {
	try {
		({ JSDOM, VirtualConsole } = require('jsdom'));
	} catch (err2) {
		console.log('\u2717 jsdom is not installed.');
		console.log('  run:  npm install');
		process.exit(1);
	}
}

const JS_FILES = ['js/engine.js', 'js/bridge.js', 'js/app.js'];

/* A real 1x1 PNG, used as the bytes for staged export files. */
const TINY_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
);

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
}
function section(title) { console.log(`\n${title}`); }

function read(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }

function pageMarkup() {
	// Script tags are stripped and evaluated manually so load order is
	// deterministic and no file:// resource loading is involved.
	return read('index.html').replace(/<script[^>]*src=[^>]*>\s*<\/script>/g, '');
}

function settle(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function flush(turns = 12) {
	let chain = Promise.resolve();
	for (let i = 0; i < turns; i++) chain = chain.then(() => new Promise((r) => setTimeout(r, 0)));
	return chain;
}

/* ------------------------------------------------------------------ *
 * Shared window plumbing
 * ------------------------------------------------------------------ */

/** Minimal ImageData + canvas raster layer for jsdom. */
function installRasterStubs(window, options) {
	const opts = options || {};
	// Electron renders plugins with Node integration, so the plugin code may
	// use Buffer/process. jsdom windows do not have them.
	window.Buffer = Buffer;
	window.process = process;

	window.ImageData = class ImageData {
		constructor(a, b, c) {
			if (a instanceof Uint8ClampedArray) {
				this.data = a; this.width = b; this.height = c;
			} else {
				this.width = a; this.height = b;
				this.data = new Uint8ClampedArray(a * b * 4);
			}
		}
	};

	// A synthetic "photo": backdrop plus a dark ellipse subject. The backdrop
	// is flat by default; `unevenBackdrop` sweeps a shadow across it, which
	// is the case background modelling cannot handle well, and `cavity` puts
	// a light patch inside the subject so there is an enclosed gap to report.
	function pattern(w, h) {
		const data = new Uint8ClampedArray(w * h * 4);
		const cx = w / 2, cy = h / 2, rx = w * 0.22, ry = h * 0.32;
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = (y * w + x) * 4;
				const dx = (x - cx) / rx, dy = (y - cy) / ry;
				const r = Math.sqrt(dx * dx + dy * dy);
				const inside = r <= 1;

				if (opts.lowContrast) {
					// A subject barely darker than its backdrop, with more
					// noise than separation: no threshold finds the shape.
					const n = ((x * 37 + y * 91) % 21) - 10;
					const v = (inside ? 120 : 132) + n;
					data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
					continue;
				}

				const hollow = opts.cavity && inside && r < 0.45;
				if (inside && !hollow) {
					data[i] = 32; data[i + 1] = 30; data[i + 2] = 42;
				} else if (opts.unevenBackdrop) {
					const v = Math.round(90 + (x / Math.max(1, w - 1)) * 150);
					data[i] = v; data[i + 1] = v; data[i + 2] = v;
				} else {
					data[i] = 236; data[i + 1] = 237; data[i + 2] = 240;
				}
				data[i + 3] = 255;
			}
		}
		return new window.ImageData(data, w, h);
	}

	const proto = window.HTMLCanvasElement.prototype;

	proto.getContext = function getContext() {
		const canvas = this;
		if (!canvas.__dshCtx) {
			canvas.__dshCtx = {
				imageSmoothingEnabled: true,
				imageSmoothingQuality: 'high',
				clearRect() { },
				drawImage() { },
				getImageData(x, y, w, h) { return pattern(Math.max(1, w), Math.max(1, h)); },
				putImageData(imageData) { canvas.__dshPut = imageData; }
			};
		}
		return canvas.__dshCtx;
	};

	proto.toBlob = function toBlob(callback) {
		callback(new window.Blob([TINY_PNG], { type: 'image/png' }));
	};

	// Not a real PNG encoder: the URL is derived from the pixels that were
	// put on the canvas, which is enough for the interface to use it as a
	// background image while still letting the tests tell two renders apart.
	proto.toDataURL = function toDataURL() {
		if (!this.__dshPut) {
			return 'data:image/png;base64,' + TINY_PNG.toString('base64');
		}
		const data = this.__dshPut.data;
		let hash = 2166136261;
		for (let i = 0; i < data.length; i += 17) {
			hash ^= data[i];
			hash = (hash * 16777619) >>> 0;
		}
		return 'data:image/png;base64,' + Buffer.from('px' + hash.toString(16)).toString('base64');
	};

	// Images "decode" instantly and report a fixed intrinsic size.
	window.Image = class Image {
		constructor() {
			this.naturalWidth = 640;
			this.naturalHeight = 480;
			this.width = 640;
			this.height = 480;
			this.onload = null;
			this.onerror = null;
			this._src = '';
		}
		set src(value) {
			this._src = value;
			setTimeout(() => { if (typeof this.onload === 'function') this.onload(); }, 0);
		}
		get src() { return this._src; }
	};
}

function buildWindow(options) {
	const opts = options || {};
	const errors = [];
	const virtualConsole = new VirtualConsole();

	virtualConsole.on('jsdomError', (err) => errors.push('jsdomError: ' + err.message));
	virtualConsole.on('error', (...args) => errors.push('console.error: ' + args.join(' ')));

	const dom = new JSDOM(pageMarkup(), {
		url: 'https://darkshape.test/',
		runScripts: 'dangerously',
		pretendToBeVisual: true,
		virtualConsole,
		beforeParse(window) {
			installRasterStubs(window, opts.raster);
			window.addEventListener('error', (event) => {
				errors.push('window.error: ' + (event.message || 'unknown'));
			});
			if (opts.beforeParse) opts.beforeParse(window);
		}
	});

	const window = dom.window;

	// Evaluate the plugin sources in order.
	for (const file of JS_FILES) {
		try {
			window.eval(read(file));
		} catch (err) {
			errors.push('eval ' + file + ': ' + err.message);
		}
	}

	return { dom, window, errors };
}

/* ------------------------------------------------------------------ *
 * Phase A — static checks
 * ------------------------------------------------------------------ */

function staticChecks() {
	section('Phase A \u2014 static structure');

	const html = read('index.html');
	const app = read('js/app.js');

	const required = new Set();
	let match;
	const lookup = /\$\('([A-Za-z0-9_-]+)'\)/g;
	while ((match = lookup.exec(app)) !== null) required.add(match[1]);

	const declared = new Set();
	const idPattern = /id="([^"]+)"/g;
	while ((match = idPattern.exec(html)) !== null) declared.add(match[1]);

	const missing = Array.from(required).filter((id) => !declared.has(id));
	check(`all ${required.size} element ids app.js looks up exist in index.html`,
		missing.length === 0, missing.join(', '));

	const assets = [];
	const assetPattern = /(?:src|href)="([^"]+)"/g;
	while ((match = assetPattern.exec(html)) !== null) {
		if (!/^(https?:|data:|#)/.test(match[1])) assets.push(match[1]);
	}
	const missingAssets = assets.filter((ref) => !fs.existsSync(path.join(ROOT, ref)));
	check(`all ${assets.length} referenced local assets exist`,
		missingAssets.length === 0, missingAssets.join(', '));

	const manifest = JSON.parse(read('manifest.json'));
	check('manifest declares an id, name, logo and main.url',
		!!(manifest.id && manifest.name && manifest.logo && manifest.main && manifest.main.url));
	check('manifest main.url points at index.html', manifest.main.url === 'index.html');
	check('manifest version is semver', /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version);
	check('manifest logo file exists', fs.existsSync(path.join(ROOT, manifest.logo.replace(/^\//, ''))));
}

/* ------------------------------------------------------------------ *
 * Phase B — standalone (no Eagle host)
 * ------------------------------------------------------------------ */

async function standaloneChecks() {
	section('Phase B \u2014 standalone boot (degraded state)');

	const ctx = buildWindow({});
	const { window, errors } = ctx;
	await flush();

	check('engine and bridge globals are exposed',
		!!window.DarkshapeEngine && !!window.DarkshapeBridge);
	check('no boot errors', errors.length === 0, errors.join(' | '));

	const doc = window.document;
	const empty = doc.getElementById('stageEmpty');
	const inner = doc.getElementById('stageInner');
	check('empty state is shown without a host', empty && !empty.hidden);
	check('canvas stage is hidden without a host', inner && inner.hidden);
	check('empty state explains the situation',
		/not running inside eagle/i.test(doc.getElementById('emptyTitle').textContent),
		doc.getElementById('emptyTitle').textContent);
	check('run button is disabled with no items', doc.getElementById('btnRun').disabled);
	check('queue strip is hidden with no items', doc.getElementById('queue').hidden);

	// --- every control responds without throwing -----------------------
	const before = errors.length;

	const segButtons = doc.querySelectorAll('.segmented button');
	segButtons.forEach((button) => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
	check(`segmented buttons clickable (${segButtons.length})`, segButtons.length > 0);

	// Selecting luminance mode must reveal its own fields and hide tolerance.
	doc.querySelector('#segMode button[data-value="luminance"]')
		.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	const lumField = doc.querySelector('[data-when="luminance"]');
	const bgField = doc.querySelector('[data-when="background"]');
	check('luminance mode reveals the threshold controls', lumField && !lumField.hidden);
	check('luminance mode hides the tolerance slider', bgField && bgField.hidden);

	doc.querySelector('#segMode button[data-value="background"]')
		.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	check('switching back restores the tolerance slider', bgField && !bgField.hidden);

	const switches = doc.querySelectorAll('.switch');
	switches.forEach((node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
	check(`switches toggle (${switches.length})`, switches.length > 0);
	const trimSwitch = doc.getElementById('swTrim');
	check('trim switch reveals the padding slider',
		trimSwitch.classList.contains('is-on') === !doc.getElementById('fieldPadding').hidden);

	// The luminous style owns an extra control that must appear with it.
	const styleButtons = doc.querySelectorAll('#segStyle button');
	check('the shape control offers solid, outline and luminous', styleButtons.length === 3,
		styleButtons.length + ' options');
	doc.querySelector('#segStyle button[data-value="luminous"]')
		.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	check('luminous style reveals the glow contrast control',
		!doc.getElementById('fieldGlowContrast').hidden);
	doc.querySelector('#segStyle button[data-value="solid"]')
		.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	check('solid style hides the glow contrast control',
		doc.getElementById('fieldGlowContrast').hidden);

	// Ranges
	const ranges = doc.querySelectorAll('input[type="range"]');
	ranges.forEach((range) => {
		const min = Number(range.min || 0);
		const max = Number(range.max || 100);
		range.value = String(min + (max - min) * 0.5);
		range.dispatchEvent(new window.Event('input', { bubbles: true }));
	});
	check(`ranges accept input (${ranges.length})`, ranges.length > 0);
	check('a range paints its filled track',
		/--fill|var\(--fill/.test(ranges[0].getAttribute('style') || '') || ranges[0].style.getPropertyValue('--fill') !== '',
		ranges[0].style.getPropertyValue('--fill'));

	// Swatches
	const swatches = doc.querySelectorAll('.swatch[data-color]');
	swatches.forEach((node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
	check(`colour swatches clickable (${swatches.length})`, swatches.length > 0);

	// View switching writes through to the stage
	['result', 'original', 'split'].forEach((view) => {
		doc.querySelector(`#segView button[data-value="${view}"]`)
			.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
		check(`view "${view}" applies to the stage`,
			doc.getElementById('stage').dataset.view === view,
			doc.getElementById('stage').dataset.view);
	});

	// Reset restores defaults
	doc.querySelector('#segMode button[data-value="alpha"]')
		.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	doc.getElementById('btnReset').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	check('reset returns the mode to auto',
		doc.querySelector('#segMode button[data-value="auto"]').classList.contains('is-active'));

	check('driving every control raised no errors', errors.length === before,
		errors.slice(before).join(' | '));

	ctx.dom.window.close();
}

/* ------------------------------------------------------------------ *
 * Phase C — hosted by a mocked Eagle
 * ------------------------------------------------------------------ */

async function hostedChecks() {
	section('Phase C \u2014 batch export against a mocked Eagle host');

	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darkshape-test-'));
	const sourceDir = path.join(tempRoot, 'library');
	fs.mkdirSync(sourceDir, { recursive: true });

	function writeSource(name) {
		const filePath = path.join(sourceDir, name);
		fs.writeFileSync(filePath, TINY_PNG);
		return filePath;
	}

	const added = [];
	const selected = [];
	const notified = [];
	let runCallback = null;
	let showCallback = null;

	const items = [
		{
			id: 'item-1', name: 'Portrait.jpg', ext: 'jpg',
			filePath: writeSource('Portrait.jpg'),
			thumbnailPath: writeSource('Portrait_thumbnail.png'),
			folders: ['folder-people'], tags: ['people']
		},
		{
			id: 'item-2', name: 'Statue.png', ext: 'png',
			filePath: writeSource('Statue.png'),
			thumbnailPath: writeSource('Statue_thumbnail.png'),
			folders: [], tags: []
		},
		// Unsupported format: must be skipped with a reason.
		{
			id: 'item-3', name: 'Clip.mp4', ext: 'mp4',
			filePath: writeSource('Clip.mp4'),
			thumbnailPath: '', folders: [], tags: []
		}
	];

	const ctx = buildWindow({
		beforeParse(window) {
			window.require = require;

			window.eagle = {
				app: {
					theme: 'DARK', platform: 'win32', locale: 'en',
					isDarkColors: () => true
				},
				os: { tmpdir: () => tempRoot },
				item: {
					getSelected: async () => items,
					getById: async (id) => items.find((i) => i.id === id) || null,
					select: async (ids) => { selected.push(...ids); return true; },
					addFromPath: async (filePath, options) => {
						added.push({
							filePath, options,
							existedAtImport: fs.existsSync(filePath),
							size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
						});
						return 'new-' + added.length;
					}
				},
				folder: {
					getAll: async () => ([
						{ id: 'folder-people', name: 'People', children: [{ id: 'folder-kids', name: 'Kids', children: [] }] },
						{ id: 'folder-places', name: 'Places', children: [] }
					])
				},
				dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
				notification: { show: (payload) => notified.push(payload) },
				shell: { showItemInFolder() { }, openExternal() { } },
				window: {
					minimize() { }, maximize() { }, unmaximize() { }, hide() { },
					isMaximized: async () => false, setBackgroundColor() { }
				},
				library: { path: sourceDir, info: async () => ({ name: 'Test Library' }) },
				plugin: { manifest: { id: 'darkshape', name: 'Darkshape' } },
				log: { info() { }, warn() { }, error() { }, debug() { } },
				onPluginCreate: () => { },
				// Eagle fires plugin-run right after plugin-create.
				onPluginRun: (callback) => { runCallback = callback; setTimeout(() => callback(), 0); },
				onPluginShow: (callback) => { showCallback = callback; },
				onThemeChanged: () => { }
			};
		}
	});

	const { window, errors } = ctx;
	await settle(200);
	await flush(30);

	const doc = window.document;

	check('no boot errors with a host', errors.length === 0, errors.join(' | '));
	check('library name is shown in the title bar',
		doc.getElementById('libraryName').textContent === 'Test Library',
		doc.getElementById('libraryName').textContent);

	check('unsupported formats are skipped (queue holds 2)',
		doc.querySelectorAll('.queue-item').length === 2,
		doc.querySelectorAll('.queue-item').length + ' tiles');
	check('queue strip is shown for a multi-image selection', !doc.getElementById('queue').hidden);
	check('run button reports the batch size',
		doc.getElementById('runLabel').textContent === 'Create 2 silhouettes',
		doc.getElementById('runLabel').textContent);
	check('run button is enabled', !doc.getElementById('btnRun').disabled);
	check('a first image is activated for preview',
		doc.querySelectorAll('.queue-item.is-active').length === 1);
	check('preview canvas content was produced', !!doc.getElementById('canvasResult'));

	check('folder picker lists Eagle folders',
		doc.querySelectorAll('#selectFolder option').length >= 4,
		doc.querySelectorAll('#selectFolder option').length + ' options');
	check('nested folders are indented in the picker',
		Array.from(doc.querySelectorAll('#selectFolder option'))
			.some((o) => o.value === 'folder:folder-kids' && /^\u00a0/.test(o.textContent)));

	// --- the Refine panel must report what it actually did ---------------
	// Several of those controls are legitimately no-ops on a clean
	// single-subject image, so silence would look like a broken slider.
	await settle(200);
	await flush(20);
	const noteSoftness = doc.getElementById('noteSoftness');
	const softnessRange = doc.getElementById('rangeSoftness');
	const noteDespeckle = doc.getElementById('noteDespeckle');
	const noteFillHoles = doc.getElementById('noteFillHoles');
	const noteLargest = doc.getElementById('noteLargest');

	check('every refine note is populated after a preview',
		!!noteSoftness.textContent && !!noteDespeckle.textContent &&
		!!noteFillHoles.textContent && !!noteLargest.textContent,
		[noteSoftness, noteDespeckle, noteFillHoles, noteLargest]
			.map((n) => n.textContent).join(' | '));
	check('the speck control says there is nothing to remove',
		/nothing to remove/i.test(noteDespeckle.textContent), noteDespeckle.textContent);
	check('the hole control explains why it cannot apply in background mode',
		/background mode/i.test(noteFillHoles.textContent), noteFillHoles.textContent);
	check('an inactive control is marked as such',
		noteFillHoles.dataset.state === 'muted', noteFillHoles.dataset.state);
	check('the feather note reports a measured radius',
		/feathered by about \d+ px/i.test(noteSoftness.textContent), noteSoftness.textContent);
	check('a negligible feather says it is barely smoothing',
		/only smoothing the step edges/i.test(noteSoftness.textContent),
		noteSoftness.textContent);

	// Raising it must clear that remark.
	softnessRange.value = '14';
	softnessRange.dispatchEvent(new window.Event('input', { bubbles: true }));
	await settle(400);
	await flush(30);
	check('a real feather drops the barely-smoothing remark',
		!/only smoothing the step edges/i.test(doc.getElementById('noteSoftness').textContent),
		doc.getElementById('noteSoftness').textContent);

	// Moving a control must refresh its note, which proves the preview
	// actually re-ran rather than the note being static text.
	softnessRange.value = '0';
	softnessRange.dispatchEvent(new window.Event('input', { bubbles: true }));
	await settle(400);
	await flush(30);
	check('the feather note updates when the control moves',
		/crisp/i.test(doc.getElementById('noteSoftness').textContent),
		doc.getElementById('noteSoftness').textContent);

	// --- the brightness split readout ------------------------------------
	// It used to say "Auto" with a second button also labelled "Auto", which
	// told the user nothing and offered a control with nothing to do.
	doc.querySelector('#segMode button[data-value="luminance"]')
		.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await settle(400);
	await flush(30);

	const autoBtn = doc.getElementById('btnAutoThreshold');
	const thresholdOut = doc.getElementById('outThreshold');

	check('the split readout shows the resolved automatic level',
		/^Auto · \d+$/.test(thresholdOut.textContent), thresholdOut.textContent);
	check('the reset button is not a second "Auto" label',
		!/^auto$/i.test(autoBtn.textContent.trim()), autoBtn.textContent.trim());
	check('there is nothing to reset while the level is automatic',
		autoBtn.disabled);

	const thrRange = doc.getElementById('rangeThreshold');
	thrRange.value = '90';
	thrRange.dispatchEvent(new window.Event('input', { bubbles: true }));
	await settle(400);
	await flush(30);
	check('setting the split by hand shows the number',
		thresholdOut.textContent === '90', thresholdOut.textContent);
	check('the reset button becomes available', !autoBtn.disabled);

	autoBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await settle(400);
	await flush(30);
	check('the reset button restores the automatic level',
		/^Auto · \d+$/.test(thresholdOut.textContent), thresholdOut.textContent);
	check('the reset button goes quiet again', autoBtn.disabled);

	// Back to the default mode for the export that follows.
	doc.querySelector('#segMode button[data-value="auto"]')
		.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await settle(300);
	await flush(20);

	// --- configure and run --------------------------------------------
	const tagsInput = doc.getElementById('inputTags');
	tagsInput.value = 'silhouette, stencil';
	tagsInput.dispatchEvent(new window.Event('input', { bubbles: true }));

	const suffix = doc.getElementById('inputSuffix');
	suffix.value = '_sil';
	suffix.dispatchEvent(new window.Event('input', { bubbles: true }));

	doc.getElementById('btnRun').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await settle(1500);
	await flush(40);

	check('two items were imported', added.length === 2, added.length + ' imports');

	const names = added.map((a) => a.options.name).sort();
	check('names use the configured suffix',
		names.join(',') === 'Portrait_sil,Statue_sil', names.join(','));

	check('tags were parsed from the comma separated field',
		added.every((a) => a.options.tags && a.options.tags.join(',') === 'silhouette,stencil'),
		JSON.stringify(added[0] && added[0].options.tags));

	check('staged files exist at import time and are non-empty',
		added.every((a) => a.existedAtImport && a.size > 0),
		added.map((a) => a.size).join(','));

	const portrait = added.find((a) => a.options.name === 'Portrait_sil');
	const statue = added.find((a) => a.options.name === 'Statue_sil');
	check('items inherit the source folder',
		portrait && portrait.options.folders.join(',') === 'folder-people',
		portrait && JSON.stringify(portrait.options.folders));
	check('unfiled sources stay unfiled',
		statue && statue.options.folders.length === 0,
		statue && JSON.stringify(statue.options.folders));

	check('exports land in the library temp folder',
		added.every((a) => a.filePath.replace(/\\/g, '/').includes('/darkshape/')),
		added[0] && added[0].filePath);

	// The staging files must be removed once Eagle has taken them.
	const staging = path.join(tempRoot, 'darkshape');
	const leftovers = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
	check('staging files are cleaned up after import', leftovers.length === 0, leftovers.join(', '));

	check('new items are selected in Eagle', selected.length === 2, selected.join(','));
	check('a completion notification is raised', notified.length === 1, JSON.stringify(notified));
	check('status reports completion',
		/finished/i.test(doc.getElementById('statusTitle').textContent),
		doc.getElementById('statusTitle').textContent);
	check('every queue tile is marked done',
		doc.querySelectorAll('.queue-item.is-done').length === 2,
		doc.querySelectorAll('.queue-item.is-done').length + ' done');
	check('progress bar is hidden after the run', doc.getElementById('progressTrack').hidden);

	// --- re-running picks up a fresh selection -------------------------
	items.length = 1;
	await runCallback();
	await settle(400);
	await flush(30);
	check('re-running reloads the selection (1 item)',
		doc.getElementById('runLabel').textContent === 'Create silhouette',
		doc.getElementById('runLabel').textContent);

	// --- starting over: the reload control -------------------------------
	const reloadBtn = doc.getElementById('btnReloadSelection');
	check('a reload control is offered in the action bar', !!reloadBtn);
	check('the reload control is enabled while idle', reloadBtn && !reloadBtn.disabled);
	check('the old do-nothing refresh button is gone',
		!doc.getElementById('btnPreviewOnly'));

	// Selecting something else in Eagle and clicking reload must swap the queue.
	items.length = 0;
	items.push({
		id: 'item-9', name: 'Second Shoot.jpg', ext: 'jpg',
		filePath: writeSource('Second Shoot.jpg'), thumbnailPath: '', folders: []
	});
	reloadBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await settle(400);
	await flush(30);
	check('reload swaps in the newly selected image',
		doc.getElementById('queueCount').textContent === '1 image',
		doc.getElementById('queueCount').textContent);
	check('reload updates the action label for the new selection',
		doc.getElementById('runLabel').textContent === 'Create silhouette',
		doc.getElementById('runLabel').textContent);

	// --- picking up a new selection on refocus ---------------------------
	items.length = 0;
	items.push(
		{ id: 'item-11', name: 'Alpha.png', ext: 'png', filePath: writeSource('Alpha.png'), thumbnailPath: '', folders: [] },
		{ id: 'item-12', name: 'Beta.png', ext: 'png', filePath: writeSource('Beta.png'), thumbnailPath: '', folders: [] }
	);
	await showCallback();
	await settle(400);
	await flush(30);
	check('a changed selection is picked up when the window is refocused',
		doc.getElementById('runLabel').textContent === 'Create 2 silhouettes',
		doc.getElementById('runLabel').textContent);

	// Refocusing with the same selection must not disturb the queue.
	await showCallback();
	await settle(300);
	await flush(20);
	check('an unchanged selection leaves the queue alone',
		doc.getElementById('runLabel').textContent === 'Create 2 silhouettes',
		doc.getElementById('runLabel').textContent);

	// The results we just created get selected back in Eagle; refocusing
	// then must not replace the queue with its own output.
	items.length = 0;
	items.push(
		{ id: 'new-1', name: 'Alpha_sil.png', ext: 'png', filePath: writeSource('Alpha_sil.png'), thumbnailPath: '', folders: [] },
		{ id: 'new-2', name: 'Beta_sil.png', ext: 'png', filePath: writeSource('Beta_sil.png'), thumbnailPath: '', folders: [] }
	);
	await showCallback();
	await settle(300);
	await flush(20);
	check('our own generated output is not mistaken for a new selection',
		doc.getElementById('runLabel').textContent === 'Create 2 silhouettes',
		doc.getElementById('runLabel').textContent);

	const finalErrors = errors.filter((e) => !/Not implemented/.test(e));
	check('no errors across the whole session', finalErrors.length === 0, finalErrors.join(' | '));

	ctx.dom.window.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * Phase D — looks, scenes and settings migration
 * ------------------------------------------------------------------ */

async function lookChecks() {
	section('Phase D \u2014 look presets, scene picker and settings migration');

	const ctx = buildWindow({
		beforeParse(window) {
			// A settings blob written before scenes existed: `background`
			// used to be a literal colour name.
			try {
				window.localStorage.setItem('darkshape.settings.v1',
					JSON.stringify({ background: 'white', tolerance: 44 }));
			} catch (err) { /* localStorage may be unavailable */ }
		}
	});

	const { window, errors } = ctx;
	await flush();

	const doc = window.document;
	const activeSeg = (id) => {
		const node = doc.querySelector(`#${id} button.is-active`);
		return node ? node.dataset.value : null;
	};

	check('no boot errors with stored settings', errors.length === 0, errors.join(' | '));

	// --- migration ------------------------------------------------------
	check('legacy "white" background migrates to the colour mode',
		activeSeg('segBackground') === 'color', String(activeSeg('segBackground')));
	check('migrated colour swatches are shown',
		!doc.getElementById('swatchesBackground').hidden);
	check('scene picker stays hidden in colour mode',
		doc.getElementById('sceneGrid').hidden);
	check('other stored settings survive the migration',
		doc.getElementById('rangeTolerance').value === '44',
		doc.getElementById('rangeTolerance').value);

	// --- scene picker ---------------------------------------------------
	const tiles = Array.from(doc.querySelectorAll('#sceneGrid .scene-tile'));
	check('a tile is rendered for every scene', tiles.length === 4, tiles.length + ' tiles');
	check('scene tiles carry rendered previews',
		tiles.every((t) => /^url\("?data:image\/png/.test(t.style.backgroundImage || '')),
		tiles.map((t) => t.dataset.scene).join(','));
	check('each scene preview is distinct',
		new Set(tiles.map((t) => t.style.backgroundImage)).size === tiles.length);
	check('one active scene tile is marked', doc.querySelectorAll('#sceneGrid .scene-tile.is-active').length === 1);

	// --- look presets ---------------------------------------------------
	const presets = Array.from(doc.querySelectorAll('#presetRow .preset'));
	check('every look has a button', presets.length === 5, presets.map((p) => p.dataset.preset).join(','));
	check('preset buttons carry a thumbnail',
		presets.every((p) => /background-(image|color)/.test((p.querySelector('i') || {}).getAttribute
			? p.querySelector('i').getAttribute('style') || '' : '')));

	// --- applying a look ------------------------------------------------
	check('rim controls start hidden', doc.getElementById('rimOptions').hidden);
	presets.find((p) => p.dataset.preset === 'sunset')
		.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

	check('look switches the background to a scene', activeSeg('segBackground') === 'scene');
	check('look reveals the scene picker', !doc.getElementById('sceneGrid').hidden);
	check('look selects its own scene',
		(doc.querySelector('#sceneGrid .scene-tile.is-active') || {}).dataset
			&& doc.querySelector('#sceneGrid .scene-tile.is-active').dataset.scene === 'sunset');
	check('look turns the rim light on',
		doc.getElementById('swRim').classList.contains('is-on'));
	check('look reveals the rim controls', !doc.getElementById('rimOptions').hidden);
	check('look sets the rim intensity',
		doc.getElementById('rangeRimIntensity').value === '62',
		doc.getElementById('rangeRimIntensity').value);
	check('look aims the rim light',
		(doc.querySelector('#compass button.is-active') || {}).dataset
			&& doc.querySelector('#compass button.is-active').dataset.dir === 'top-right');

	// --- manual control of the new fields -------------------------------
	const deepTile = doc.querySelector('#sceneGrid .scene-tile[data-scene="deep"]');
	deepTile.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	check('clicking a scene tile selects it',
		doc.querySelector('#sceneGrid .scene-tile.is-active').dataset.scene === 'deep');

	const leftArrow = doc.querySelector('#compass button[data-dir="left"]');
	leftArrow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	check('compass arrows set the light direction',
		doc.querySelector('#compass button.is-active').dataset.dir === 'left');
	check('exactly one compass direction is active',
		doc.querySelectorAll('#compass button.is-active').length === 1);

	doc.getElementById('swRim').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	check('rim switch hides the rim controls again',
		doc.getElementById('rimOptions').hidden);

	// --- the studio look returns to a flat backdrop ---------------------
	presets.find((p) => p.dataset.preset === 'studio')
		.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	check('studio look uses a flat colour background', activeSeg('segBackground') === 'color');
	check('studio look hides the scene picker', doc.getElementById('sceneGrid').hidden);
	check('studio look shows the colour swatches',
		!doc.getElementById('swatchesBackground').hidden);
	check('studio look turns the rim light off',
		!doc.getElementById('swRim').classList.contains('is-on'));

	// --- the luminous look, tuned against the reference plates ----------
	presets.find((p) => p.dataset.preset === 'luminous')
		.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	check('luminous look selects the luminous shape', activeSeg('segStyle') === 'luminous');
	check('luminous look reveals the glow contrast control',
		!doc.getElementById('fieldGlowContrast').hidden);
	check('luminous look keeps glow contrast linear for a natural falloff',
		doc.getElementById('rangeGlowContrast').value === '0',
		doc.getElementById('rangeGlowContrast').value);
	check('luminous look uses a flat near-black field',
		activeSeg('segBackground') === 'color' &&
		!doc.getElementById('swatchesBackground').hidden);
	const activeSwatch = doc.querySelector('#swatchesBackground .swatch.is-active');
	check('luminous look selects the near-black swatch',
		!!activeSwatch && ['#14161a', '#000000'].indexOf(activeSwatch.dataset.color) !== -1,
		activeSwatch && activeSwatch.dataset.color);
	check('luminous look leaves the rim light on',
		doc.getElementById('swRim').classList.contains('is-on'));
	check('luminous look uses a wide even glow',
		doc.getElementById('rangeRimWidth').value === '14' &&
		(doc.querySelector('#compass button.is-active') || {}).dataset.dir === 'all',
		doc.getElementById('rangeRimWidth').value);

	check('no errors from the new controls', errors.length === 0, errors.join(' | '));

	ctx.dom.window.close();
}

/* ------------------------------------------------------------------ *
 * Phase E — the uneven-backdrop suggestion
 * ------------------------------------------------------------------ */

async function backdropHintChecks() {
	section('Phase E \u2014 uneven backdrop suggestion');

	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darkshape-hint-'));
	const sourceDir = path.join(tempRoot, 'lib');
	fs.mkdirSync(sourceDir, { recursive: true });
	const file = path.join(sourceDir, 'Shadowed.png');
	fs.writeFileSync(file, TINY_PNG);

	const item = {
		id: 'shadow-1', name: 'Shadowed.png', ext: 'png',
		filePath: file, thumbnailPath: '', folders: []
	};

	const ctx = buildWindow({
		raster: { unevenBackdrop: true, cavity: true },
		beforeParse(window) {
			window.require = require;
			window.eagle = {
				app: { theme: 'DARK', platform: 'win32', isDarkColors: () => true },
				os: { tmpdir: () => tempRoot },
				item: {
					getSelected: async () => [item],
					getById: async () => item,
					select: async () => true,
					addFromPath: async () => 'new-1'
				},
				folder: { getAll: async () => [] },
				dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
				notification: { show() { } },
				shell: { showItemInFolder() { }, openExternal() { } },
				window: {
					minimize() { }, maximize() { }, unmaximize() { }, hide() { },
					isMaximized: async () => false, setBackgroundColor() { }
				},
				library: { path: sourceDir, info: async () => ({ name: 'Hint Library' }) },
				plugin: { manifest: { id: 'darkshape', name: 'Darkshape' } },
				log: { info() { }, warn() { }, error() { }, debug() { } },
				onPluginCreate: () => { },
				onPluginRun: (callback) => { setTimeout(() => callback(), 0); },
				onThemeChanged: () => { }
			};
		}
	});

	const { window, errors } = ctx;
	await settle(400);
	await flush(30);

	const doc = window.document;
	const hint = doc.getElementById('backdropHint');
	const activeSeg = (id) => {
		const node = doc.querySelector(`#${id} button.is-active`);
		return node ? node.dataset.value : null;
	};

	check('no errors with an uneven backdrop', errors.length === 0, errors.join(' | '));

	// Auto-tune weighs both methods and reports what it read — and having
	// decided, it does not then second-guess itself with a suggestion card.
	check('auto-tune reports what it read',
		doc.getElementById('noteAutoTune').textContent.length > 0,
		doc.getElementById('noteAutoTune').textContent);
	check('the auto-tune switch is on',
		doc.getElementById('swAutoTune').classList.contains('is-on'));
	check('no manual suggestion while the tuner is in charge',
		doc.getElementById('backdropHint').hidden);

	// Taking manual control must hand the decision back — and bring the
	// suggestion with it, since the tuner is no longer watching.
	doc.querySelector('#segMode button[data-value="background"]')
		.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await settle(400);
	await flush(30);

	check('setting the mode by hand turns auto-tune off',
		!doc.getElementById('swAutoTune').classList.contains('is-on'));
	check('the manual suggestion returns', !hint.hidden);
	check('the suggestion explains the problem',
		/uneven/i.test(doc.getElementById('noteBackdrop').textContent),
		doc.getElementById('noteBackdrop').textContent);

	// Its one-click fix must switch modes and pick the correct subject side.
	doc.getElementById('btnTryContrast').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await settle(400);
	await flush(30);

	check('the fix switches to contrast mode', activeSeg('segMode') === 'luminance',
		String(activeSeg('segMode')));
	check('the fix picks the dark subject for a light backdrop',
		(doc.querySelector('#segLumSubject button.is-active') || {}).dataset
			&& doc.querySelector('#segLumSubject button.is-active').dataset.value === 'dark');
	check('the suggestion clears once it has been applied', hint.hidden);

	// Contrast mode now sees the enclosed cavity. Drop the limit below its
	// size so the "still open" path is exercised regardless of the default.
	const holesRange = doc.getElementById('rangeFillHoles');
	holesRange.value = '1';
	holesRange.dispatchEvent(new window.Event('input', { bubbles: true }));
	await settle(400);
	await flush(30);

	const gapNote = doc.getElementById('noteFillHoles').textContent;
	check('an oversized enclosed gap is reported as still open',
		/still open/i.test(gapNote), gapNote);
	check('the gap note suggests the limit control',
		/raise the limit/i.test(gapNote), gapNote);

	// Raising the limit must close it and say so.
	holesRange.value = '10';
	holesRange.dispatchEvent(new window.Event('input', { bubbles: true }));
	await settle(400);
	await flush(30);
	const closedNote = doc.getElementById('noteFillHoles').textContent;
	check('raising the limit closes the gap',
		/closed/i.test(closedNote) && !/still open/i.test(closedNote), closedNote);

	check('no errors after applying the fix', errors.length === 0, errors.join(' | '));

	ctx.dom.window.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * Phase F — stored settings versus retuned defaults
 * ------------------------------------------------------------------ */

async function settingsPersistenceChecks() {
	section('Phase F \u2014 stored settings and superseded defaults');

	function bootWith(blob) {
		return buildWindow({
			beforeParse(window) {
				try {
					if (blob.v1) {
						window.localStorage.setItem('darkshape.settings.v1', JSON.stringify(blob.v1));
					}
					if (blob.v2) {
						window.localStorage.setItem('darkshape.settings.v2', JSON.stringify(blob.v2));
					}
				} catch (err) { /* jsdom may refuse storage */ }
			}
		});
	}

	// An older blob, written back when fillHoles defaulted to 2 and
	// edgeSoftness to 1.4. Those are not choices, so the retuned defaults
	// must apply — while a genuinely different value is kept.
	{
		const ctx = bootWith({ v1: { fillHoles: 2, edgeSoftness: 1.4, tolerance: 44 } });
		await flush();
		const doc = ctx.window.document;
		check('a superseded default no longer pins the old value',
			doc.getElementById('rangeFillHoles').value === '5',
			doc.getElementById('rangeFillHoles').value);
		check('the retuned edge softness is picked up too',
			doc.getElementById('rangeSoftness').value === '3',
			doc.getElementById('rangeSoftness').value);
		check('a deliberate value survives the migration',
			doc.getElementById('rangeTolerance').value === '44',
			doc.getElementById('rangeTolerance').value);
		check('no errors from the legacy blob', ctx.errors.length === 0, ctx.errors.join(' | '));
		ctx.dom.window.close();
	}

	// A current blob that records the user having set fillHoles themselves:
	// that choice must be honoured even though it matches an old default.
	{
		const ctx = bootWith({ v2: { values: { fillHoles: 2 }, touched: ['fillHoles'] } });
		await flush();
		const doc = ctx.window.document;
		check('a choice the user actually made is restored',
			doc.getElementById('rangeFillHoles').value === '2',
			doc.getElementById('rangeFillHoles').value);
		check('keys they never touched still follow the defaults',
			doc.getElementById('rangeSoftness').value === '3',
			doc.getElementById('rangeSoftness').value);
		ctx.dom.window.close();
	}

	// A current blob with an empty touch list: nothing was chosen at all.
	{
		const ctx = bootWith({ v2: { values: { fillHoles: 2 }, touched: [] } });
		await flush();
		const doc = ctx.window.document;
		check('an untouched key follows the current default',
			doc.getElementById('rangeFillHoles').value === '5',
			doc.getElementById('rangeFillHoles').value);
		ctx.dom.window.close();
	}

	// The running build must be visible, so a stale install can be spotted.
	{
		const ctx = buildWindow({});
		await flush();
		const version = ctx.window.document.getElementById('brandVersion').textContent;
		check('the build version is shown in the title bar',
			/^v\d+\.\d+\.\d+$/.test(version), version || '(empty)');
		ctx.dom.window.close();
	}
}

/* ------------------------------------------------------------------ *
 * Phase G — warning when nothing can be separated
 * ------------------------------------------------------------------ */

async function unreliableChecks() {
	section('Phase G \u2014 warning when a photo cannot be separated');

	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darkshape-weak-'));
	const sourceDir = path.join(tempRoot, 'lib');
	fs.mkdirSync(sourceDir, { recursive: true });
	const file = path.join(sourceDir, 'Flat.jpg');
	fs.writeFileSync(file, TINY_PNG);
	const item = { id: 'flat-1', name: 'Flat.jpg', ext: 'jpg', filePath: file, thumbnailPath: '', folders: [] };

	const ctx = buildWindow({
		raster: { lowContrast: true },
		beforeParse(window) {
			window.require = require;
			window.eagle = {
				app: { theme: 'DARK', platform: 'win32', isDarkColors: () => true },
				os: { tmpdir: () => tempRoot },
				item: {
					getSelected: async () => [item],
					getById: async () => item,
					select: async () => true,
					addFromPath: async () => 'new-1'
				},
				folder: { getAll: async () => [] },
				dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
				notification: { show() { } },
				shell: { showItemInFolder() { }, openExternal() { } },
				window: {
					minimize() { }, maximize() { }, unmaximize() { }, hide() { },
					isMaximized: async () => false, setBackgroundColor() { }
				},
				library: { path: sourceDir, info: async () => ({ name: 'Flat Library' }) },
				plugin: { manifest: { id: 'darkshape', name: 'Darkshape' } },
				log: { info() { }, warn() { }, error() { }, debug() { } },
				onPluginCreate: () => { },
				onPluginRun: (callback) => { setTimeout(() => callback(), 0); },
				onPluginShow: () => { },
				onThemeChanged: () => { }
			};
		}
	});

	const { window, errors } = ctx;
	await settle(500);
	await flush(30);
	const doc = window.document;

	check('no errors on an unseparable photo', errors.length === 0, errors.join(' | '));
	check('the result is flagged as unreliable', !doc.getElementById('weakHint').hidden);
	check('the warning says why it cannot be trusted',
		/tone|real edge/i.test(doc.getElementById('noteWeak').textContent),
		doc.getElementById('noteWeak').textContent);
	check('the warning is carried into the status bar too',
		/unreliable|rough cut/i.test(doc.getElementById('statusTitle').textContent),
		doc.getElementById('statusTitle').textContent);
	check('the status dot shows the warning state',
		doc.getElementById('statusDot').dataset.state === 'warn',
		doc.getElementById('statusDot').dataset.state);

	// Turning auto-tune off hands the judgement back, so the warning goes.
	doc.getElementById('swAutoTune').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await settle(300);
	await flush(20);
	check('the warning clears when auto-tune is turned off',
		doc.getElementById('weakHint').hidden);

	ctx.dom.window.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * Phase H — the whole queue is evaluated
 * ------------------------------------------------------------------ */

/** Builds a window with a queue of real files behind it. */
function buildQueueHost(files, rasterOpts) {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darkshape-queue-'));
	const sourceDir = path.join(tempRoot, 'lib');
	fs.mkdirSync(sourceDir, { recursive: true });

	const items = files.map((name, i) => {
		const p = path.join(sourceDir, name);
		fs.writeFileSync(p, TINY_PNG);
		return {
			id: 'q' + i, name: name, ext: name.split('.').pop(),
			filePath: p, thumbnailPath: '', folders: []
		};
	});

	const ctx = buildWindow({
		raster: rasterOpts || {},
		beforeParse(window) {
			window.require = require;
			window.eagle = {
				app: { theme: 'DARK', platform: 'win32', isDarkColors: () => true },
				os: { tmpdir: () => tempRoot },
				item: {
					getSelected: async () => items,
					getById: async (id) => items.find((x) => x.id === id) || null,
					select: async () => true,
					addFromPath: async () => 'new-1'
				},
				folder: { getAll: async () => [] },
				dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
				notification: { show() { } },
				shell: { showItemInFolder() { }, openExternal() { } },
				window: {
					minimize() { }, maximize() { }, unmaximize() { }, hide() { },
					isMaximized: async () => false, setBackgroundColor() { }
				},
				library: { path: sourceDir, info: async () => ({ name: 'Queue Library' }) },
				plugin: { manifest: { id: 'darkshape', name: 'Darkshape' } },
				log: { info() { }, warn() { }, error() { }, debug() { } },
				onPluginCreate: () => { },
				onPluginRun: (callback) => { setTimeout(() => callback(), 0); },
				onPluginShow: () => { },
				onThemeChanged: () => { }
			};
		}
	});

	return { ctx, tempRoot };
}

async function queueEvaluationChecks() {
	section('Phase H \u2014 the whole queue is evaluated');

	// Everything separable: say so, and flag nothing.
	{
		const { ctx, tempRoot } = buildQueueHost(['A.png', 'B.png', 'C.png'], {});
		await settle(1500);
		await flush(60);
		const doc = ctx.window.document;

		check('a clean queue is reported as separable',
			/all 3 can be separated/i.test(doc.getElementById('queueWarn').textContent),
			doc.getElementById('queueWarn').textContent);
		check('a clean queue flags no tiles',
			doc.querySelectorAll('.queue-item.is-weak').length === 0,
			doc.querySelectorAll('.queue-item.is-weak').length + ' flagged');
		check('the clean report is not styled as a warning',
			!doc.getElementById('queueWarn').classList.contains('is-warning'));
		check('no errors while evaluating a clean queue',
			ctx.errors.length === 0, ctx.errors.join(' | '));

		ctx.dom.window.close();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}

	// Nothing separable: every item flagged, before any export happens.
	{
		const { ctx, tempRoot } = buildQueueHost(['A.jpg', 'B.jpg', 'C.jpg'], { lowContrast: true });
		await settle(1500);
		await flush(60);
		const doc = ctx.window.document;

		check('every unseparable photo is flagged',
			doc.querySelectorAll('.queue-item.is-weak').length === 3,
			doc.querySelectorAll('.queue-item.is-weak').length + ' flagged');
		check('the count of unseparable photos is shown',
			/3 of 3 cannot be separated/i.test(doc.getElementById('queueWarn').textContent),
			doc.getElementById('queueWarn').textContent);
		check('the queue report carries the warning style',
			doc.getElementById('queueWarn').classList.contains('is-warning'));
		check('a flagged tile says why on hover',
			/cannot be separated/i.test(doc.querySelector('.queue-item.is-weak').title),
			doc.querySelector('.queue-item.is-weak').title);
		check('no errors while evaluating a bad queue',
			ctx.errors.length === 0, ctx.errors.join(' | '));

		ctx.dom.window.close();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

(async function main() {
	try {
		staticChecks();
		await standaloneChecks();
		await hostedChecks();
		await lookChecks();
		await backdropHintChecks();
		await settingsPersistenceChecks();
		await unreliableChecks();
		await queueEvaluationChecks();
	} catch (err) {
		check('test run completed', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
	}

	console.log(`\n${'-'.repeat(58)}`);
	let passed = 0, failed = 0;
	for (const row of results) {
		if (row.ok) passed++;
		else {
			failed++;
			console.log(`  \u2717 ${row.name}${row.detail ? ' \u2014 ' + row.detail : ''}`);
		}
	}
	console.log(`${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
})();
