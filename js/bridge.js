/*!
 * Darkshape — Eagle bridge
 * ---------------------------------------------------------------
 * Every interaction with the Eagle host lives here, so the rest of the
 * plugin can be reasoned about (and tested) without an Eagle runtime.
 *
 * All calls are defensive: the plugin API has grown across Eagle
 * releases, and the plugin must degrade gracefully rather than throw
 * when an optional method is missing.
 */
(function (global) {
	'use strict';

	var nodeRequire = null;
	try {
		// In the plugin renderer `require` is provided by Eagle's preload.
		nodeRequire = global.require || (typeof require === 'function' ? require : null);
	} catch (err) {
		nodeRequire = null;
	}

	var fs = null;
	var path = null;
	var os = null;
	try {
		if (nodeRequire) {
			fs = nodeRequire('fs');
			path = nodeRequire('path');
			os = nodeRequire('os');
		}
	} catch (err) {
		fs = null;
	}

	var MIME_BY_EXT = {
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		jpe: 'image/jpeg',
		png: 'image/png',
		webp: 'image/webp',
		gif: 'image/gif',
		bmp: 'image/bmp',
		avif: 'image/avif',
		svg: 'image/svg+xml'
	};

	/** Extensions Chromium can actually decode into a canvas. */
	var DECODABLE = ['jpg', 'jpeg', 'jpe', 'png', 'webp', 'gif', 'bmp', 'avif'];

	var state = {
		tempDir: null,
		tempFiles: []
	};

	function eagle() {
		return global.eagle || null;
	}

	function available() {
		var api = eagle();
		return !!(api && api.item && typeof api.item.getSelected === 'function');
	}

	function hasNode() {
		return !!(fs && path);
	}

	function log() {
		var api = eagle();
		var args = Array.prototype.slice.call(arguments);
		if (api && api.log && typeof api.log.info === 'function') {
			try {
				api.log.info('[darkshape] ' + args.join(' '));
				return;
			} catch (err) { /* fall through to console */ }
		}
		console.log.apply(console, ['[darkshape]'].concat(args));
	}

	function warn() {
		var api = eagle();
		var args = Array.prototype.slice.call(arguments);
		if (api && api.log && typeof api.log.warn === 'function') {
			try {
				api.log.warn('[darkshape] ' + args.join(' '));
				return;
			} catch (err) { /* fall through */ }
		}
		console.warn.apply(console, ['[darkshape]'].concat(args));
	}

	/* ------------------------------------------------------------------ *
	 * Library access
	 * ------------------------------------------------------------------ */

	function isImageItem(item) {
		if (!item || !item.ext) return false;
		return DECODABLE.indexOf(String(item.ext).toLowerCase()) !== -1;
	}

	/**
	 * Items currently selected in Eagle, restricted to formats we can
	 * decode, with a reason recorded for anything skipped.
	 */
	async function getSelectedItems() {
		var api = eagle();
		if (!api || !api.item || typeof api.item.getSelected !== 'function') {
			return { items: [], skipped: [] };
		}

		// The one host call that can fail while the user is watching — Eagle
		// closing, an IPC hiccup — and the only one that used to be left
		// unguarded. A rejection here surfaced as an unhandled promise and a
		// button that silently did nothing.
		var selected;
		try {
			selected = await api.item.getSelected();
		} catch (err) {
			warn('could not read the Eagle selection:', err && err.message);
			throw new Error('Eagle did not return the current selection.');
		}
		if (!Array.isArray(selected)) selected = [];

		var items = [];
		var skipped = [];

		selected.forEach(function (item) {
			if (!item) return;
			var ext = String(item.ext || '').toLowerCase();
			if (DECODABLE.indexOf(ext) === -1) {
				skipped.push({ name: item.name || item.id, reason: ext ? '.' + ext + ' is not a decodable image' : 'unknown format' });
				return;
			}
			if (!item.filePath) {
				skipped.push({ name: item.name || item.id, reason: 'file is missing from the library' });
				return;
			}
			items.push(item);
		});

		return { items: items, skipped: skipped };
	}

	async function getFolders() {
		var api = eagle();
		if (!api || !api.folder || typeof api.folder.getAll !== 'function') return [];
		try {
			var folders = await api.folder.getAll();
			return Array.isArray(folders) ? folders : [];
		} catch (err) {
			warn('could not read folders:', err && err.message);
			return [];
		}
	}

	async function selectItems(ids) {
		var api = eagle();
		if (!api || !api.item || typeof api.item.select !== 'function') return false;
		if (!ids || !ids.length) return false;
		try {
			await api.item.select(ids);
			return true;
		} catch (err) {
			warn('select failed:', err && err.message);
			return false;
		}
	}

	/* ------------------------------------------------------------------ *
	 * Reading sources
	 * ------------------------------------------------------------------ */

	function mimeForPath(filePath) {
		var ext = String(filePath || '').split('.').pop().toLowerCase();
		return MIME_BY_EXT[ext] || 'image/png';
	}

	/**
	 * Reads a file straight off disk and returns a data URL. Data URLs can
	 * never taint the canvas, so pixel reads always succeed regardless of
	 * how Eagle's custom protocol handles file:// origins.
	 */
	function readFileAsDataUrl(filePath) {
		if (!hasNode()) throw new Error('Filesystem access is unavailable.');
		var buffer = fs.readFileSync(filePath);
		return 'data:' + mimeForPath(filePath) + ';base64,' + buffer.toString('base64');
	}

	function decodeImage(dataUrl) {
		return new Promise(function (resolve, reject) {
			var image = new Image();
			image.onload = function () { resolve(image); };
			image.onerror = function () { reject(new Error('The image could not be decoded.')); };
			image.src = dataUrl;
		});
	}

	async function loadImage(item) {
		var dataUrl;
		if (hasNode()) {
			dataUrl = readFileAsDataUrl(item.filePath);
		} else if (item.fileURL) {
			dataUrl = item.fileURL;
		} else {
			throw new Error('No readable path for ' + (item.name || item.id));
		}
		var image = await decodeImage(dataUrl);
		// The data URL itself is deliberately not kept on the image. It is
		// roughly 1.33x the file size as a string, nothing reads it, and
		// pinning it here keeps it alive for as long as the decoded bitmap —
		// which defeats releasing the bitmap on navigation.
		return image;
	}

	/** Small preview bitmap for the queue strip; falls back to the full file. */
	async function loadThumbnail(item) {
		if (!hasNode()) return null;
		var candidates = [];
		if (item.thumbnailPath) candidates.push(item.thumbnailPath);
		if (item.filePath) candidates.push(item.filePath);

		for (var i = 0; i < candidates.length; i++) {
			try {
				if (fs.existsSync(candidates[i])) return readFileAsDataUrl(candidates[i]);
			} catch (err) { /* try the next candidate */ }
		}
		return null;
	}

	/* ------------------------------------------------------------------ *
	 * Writing results
	 * ------------------------------------------------------------------ */

	function ensureTempDir() {
		if (state.tempDir) return state.tempDir;
		if (!hasNode()) throw new Error('Filesystem access is unavailable.');
		var base = (eagle() && eagle().os && typeof eagle().os.tmpdir === 'function')
			? eagle().os.tmpdir()
			: os.tmpdir();
		var dir = path.join(base, 'darkshape');
		fs.mkdirSync(dir, { recursive: true });
		state.tempDir = dir;
		return dir;
	}

	/** Removes anything left behind by a previous session. */
	function sweepTempDir() {
		if (!hasNode()) return;
		try {
			var dir = ensureTempDir();
			var entries = fs.readdirSync(dir);
			entries.forEach(function (name) {
				try {
					fs.rmSync(path.join(dir, name), { force: true, recursive: true });
				} catch (err) { /* best effort */ }
			});
		} catch (err) {
			warn('temp sweep failed:', err && err.message);
		}
	}

	function sanitizeName(name) {
		return String(name || 'silhouette')
			.replace(/[\\/:*?"<>|]+/g, '-')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 120) || 'silhouette';
	}

	function canvasToPngBuffer(canvas) {
		return new Promise(function (resolve, reject) {
			if (typeof canvas.toBlob === 'function') {
				canvas.toBlob(function (blob) {
					if (!blob) { reject(new Error('PNG encoding failed.')); return; }
					blob.arrayBuffer()
						.then(function (buffer) { resolve(Buffer.from(buffer)); })
						.catch(reject);
				}, 'image/png');
				return;
			}
			// Fallback for environments without toBlob.
			try {
				var dataUrl = canvas.toDataURL('image/png');
				resolve(Buffer.from(dataUrl.split(',')[1], 'base64'));
			} catch (err) {
				reject(err);
			}
		});
	}

	/**
	 * Adds a rendered canvas to the library.
	 *
	 * The PNG is staged in the OS temp directory and imported by path,
	 * which keeps large images out of the IPC channel. addFromPath resolves
	 * only once Eagle has finished importing, so the staged file is safe to
	 * delete immediately afterwards.
	 *
	 * @returns {Promise<string|null>} the new item id
	 */
	async function addCanvasToLibrary(canvas, options) {
		var api = eagle();
		if (!api || !api.item || typeof api.item.addFromPath !== 'function') {
			throw new Error('Eagle item API is unavailable.');
		}
		if (!hasNode()) throw new Error('Filesystem access is unavailable.');

		var opts = options || {};
		var dir = ensureTempDir();
		var fileName = sanitizeName(opts.name) + '.png';
		var filePath = path.join(dir, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + fileName);

		var buffer = await canvasToPngBuffer(canvas);
		fs.writeFileSync(filePath, buffer);

		try {
			var id = await api.item.addFromPath(filePath, {
				name: sanitizeName(opts.name),
				folders: opts.folders || [],
				tags: opts.tags || [],
				annotation: opts.annotation || '',
				website: opts.website || ''
			});
			return id || null;
		} finally {
			try {
				fs.rmSync(filePath, { force: true });
			} catch (err) { /* the sweep at start-up will catch strays */ }
		}
	}

	function notify(title, body, duration) {
		var api = eagle();
		if (api && api.notification && typeof api.notification.show === 'function') {
			try {
				api.notification.show({ title: title, body: body, duration: duration || 2000 });
				return;
			} catch (err) { /* fall through */ }
		}
		log(title + (body ? ' — ' + body : ''));
	}

	/* ------------------------------------------------------------------ *
	 * Native dialogs
	 * ------------------------------------------------------------------ */

	async function chooseImageFiles() {
		var api = eagle();
		if (!api || !api.dialog || typeof api.dialog.showOpenDialog !== 'function') {
			return [];
		}
		try {
			var result = await api.dialog.showOpenDialog({
				properties: ['openFile', 'multiSelections'],
				filters: [{ name: 'Images', extensions: DECODABLE }]
			});
			if (!result || result.canceled || !result.filePaths) return [];
			return result.filePaths.map(function (filePath) {
				var name = String(filePath).split(/[\\/]/).pop();
				var ext = name.split('.').pop().toLowerCase();
				return { path: filePath, name: name, ext: ext };
			});
		} catch (err) {
			warn('file picker failed:', err && err.message);
			return [];
		}
	}

	async function chooseDirectory() {
		var api = eagle();
		if (!api || !api.dialog || typeof api.dialog.showOpenDialog !== 'function') return null;
		try {
			var result = await api.dialog.showOpenDialog({
				properties: ['openDirectory', 'createDirectory']
			});
			if (!result || result.canceled || !result.filePaths || !result.filePaths.length) return null;
			return result.filePaths[0];
		} catch (err) {
			warn('directory picker failed:', err && err.message);
			return null;
		}
	}

	/** Writes a rendered canvas to a directory as a PNG. */
	async function saveCanvasToFolder(canvas, directory, fileName) {
		if (!hasNode()) throw new Error('Filesystem access is unavailable.');
		var buffer = await canvasToPngBuffer(canvas);
		var fullPath = path.join(directory, sanitizeName(fileName) + '.png');
		fs.writeFileSync(fullPath, buffer);
		return fullPath;
	}

	function showItemInFolder(fullPath) {
		var api = eagle();
		if (api && api.shell && typeof api.shell.showItemInFolder === 'function') {
			try { api.shell.showItemInFolder(fullPath); } catch (err) { /* ignore */ }
		}
	}

	/* ------------------------------------------------------------------ *
	 * Host metadata
	 * ------------------------------------------------------------------ */

	function manifest() {
		var api = eagle();
		return (api && api.plugin && api.plugin.manifest) || {};
	}

	function theme() {
		var api = eagle();
		if (api && api.app && api.app.theme) {
			var name = String(api.app.theme).toUpperCase();
			if (name === 'LIGHT' || name === 'LIGHTGRAY') return 'light';
			if (name) return 'dark';
		}
		try {
			if (api && api.app && typeof api.app.isDarkColors === 'function') {
				return api.app.isDarkColors() ? 'dark' : 'light';
			}
		} catch (err) { /* ignore */ }
		try {
			return global.matchMedia && global.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
		} catch (err) {
			return 'dark';
		}
	}

	function onThemeChanged(callback) {
		var api = eagle();
		if (api && typeof api.onThemeChanged === 'function') {
			try { api.onThemeChanged(function () { callback(theme()); }); } catch (err) { /* ignore */ }
		}
	}

	function onPluginRun(callback) {
		var api = eagle();
		if (api && typeof api.onPluginRun === 'function') api.onPluginRun(callback);
	}

	function onPluginCreate(callback) {
		var api = eagle();
		if (api && typeof api.onPluginCreate === 'function') api.onPluginCreate(callback);
	}

	/** Fires whenever the plugin window is brought back to the front. */
	function onPluginShow(callback) {
		var api = eagle();
		if (api && typeof api.onPluginShow === 'function') {
			try { api.onPluginShow(callback); } catch (err) { /* ignore */ }
		}
	}

	global.DarkshapeBridge = {
		available: available,
		hasNode: hasNode,
		log: log,
		warn: warn,
		getSelectedItems: getSelectedItems,
		getFolders: getFolders,
		selectItems: selectItems,
		loadImage: loadImage,
		loadThumbnail: loadThumbnail,
		readFileAsDataUrl: readFileAsDataUrl,
		decodeImage: decodeImage,
		addCanvasToLibrary: addCanvasToLibrary,
		canvasToPngBuffer: canvasToPngBuffer,
		chooseImageFiles: chooseImageFiles,
		chooseDirectory: chooseDirectory,
		saveCanvasToFolder: saveCanvasToFolder,
		showItemInFolder: showItemInFolder,
		sanitizeName: sanitizeName,
		notify: notify,
		manifest: manifest,
		theme: theme,
		onThemeChanged: onThemeChanged,
		onPluginRun: onPluginRun,
		onPluginCreate: onPluginCreate,
		onPluginShow: onPluginShow,
		sweepTempDir: sweepTempDir,
		isImageItem: isImageItem,
		DECODABLE: DECODABLE
	};
})(typeof window !== 'undefined' ? window : this);
