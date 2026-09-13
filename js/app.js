/*!
 * Darkshape — application shell
 * ---------------------------------------------------------------
 * Wires the silhouette engine to the Eagle host and the interface:
 * source queue, live preview, split comparison, batch export.
 */
(function () {
	'use strict';

	var Engine = window.DarkshapeEngine;
	var Bridge = window.DarkshapeBridge;

	/* ------------------------------------------------------------------ *
	 * Constants
	 * ------------------------------------------------------------------ */

	// Preview renders at a reduced resolution so every slider tick stays
	// interactive; export runs at full quality.
	var PREVIEW_MAX = 1000;
	var EXPORT_MAX = 4096;
	var STORAGE_KEY = 'darkshape.settings.v2';
	var LEGACY_STORAGE_KEY = 'darkshape.settings.v1';

	/**
	 * Values that once shipped as defaults before being retuned.
	 *
	 * Settings used to be persisted as one whole object and restored key by
	 * key, so a stored value could not be told apart from a deliberate choice.
	 * The first time anyone touched any control, every default of that moment
	 * was frozen in permanently — which meant retuned defaults never reached
	 * an existing user. A stored value equal to one of these is treated as an
	 * untouched default and dropped.
	 */
	var SUPERSEDED_DEFAULTS = {
		edgeSoftness: 1.4,
		fillHoles: 2
	};

	/** Keys the user has actually operated, as opposed to defaults. */
	var userTouched = {};

	/**
	 * Settings the auto-tuner owns. Operating any of them by hand hands
	 * control back to the user — quietly leaving the tuner on would make the
	 * next image undo their change.
	 */
	var AUTO_MANAGED = ['mode', 'tolerance', 'luminanceThreshold',
		'luminanceSubject', 'keepLargest', 'fillHoles'];

	function markTouched(key) {
		if (!key) return;
		userTouched[key] = true;
		if (params.autoTune && AUTO_MANAGED.indexOf(key) !== -1) {
			params.autoTune = false;
			if (el.swAutoTune) {
				el.swAutoTune.classList.remove('is-on');
				el.swAutoTune.setAttribute('aria-checked', 'false');
			}
			if (el.noteAutoTune) {
				el.noteAutoTune.textContent = 'Auto-tune off — you are setting the detection yourself now.';
				el.noteAutoTune.dataset.state = 'muted';
			}
			toast('Auto-tune off', 'Turn it back on to let the plugin choose per image again.', 'warn');
		}
	}
	var MAX_ZOOM = 8;

	var FILL_SWATCHES = ['#000000', '#ffffff', '#7c5cff', '#22d3ee', '#f43f5e', '#f59e0b'];
	var BACKGROUND_SWATCHES = ['#ffffff', '#f4f4f7', '#000000', '#14161a', '#7c5cff', '#22d3ee'];
	var RIM_SWATCHES = ['#ffffff', '#ffe6c2', '#ffd08a', '#9fd8ff', '#c9b8ff', '#ff9ec4'];

	/**
	 * One-click recipes for the "striking portrait" look: a backdrop, a rim
	 * light tuned to it, and an edge that stays crisp. Colours are chosen so
	 * the silhouette reads as pitch black against each scene.
	 */
	var LOOKS = {
		sunset: {
			label: 'Sunset portrait',
			scene: 'sunset',
			background: 'scene',
			style: 'solid',
			fillColor: '#000000',
			edgeSoftness: 1.2,
			rimLight: true,
			rimColor: '#ffd9a8',
			rimIntensity: 62,
			rimWidth: 11,
			rimDirection: 'top-right'
		},
		studio: {
			label: 'Studio',
			background: 'color',
			backgroundColor: '#ffffff',
			style: 'solid',
			fillColor: '#000000',
			edgeSoftness: 1.0,
			rimLight: false
		},
		deep: {
			label: 'Deep drama',
			scene: 'deep',
			background: 'scene',
			style: 'solid',
			fillColor: '#000000',
			edgeSoftness: 1.2,
			rimLight: true,
			rimColor: '#9fd8ff',
			rimIntensity: 55,
			rimWidth: 13,
			rimDirection: 'top'
		},
		golden: {
			label: 'Golden hour',
			scene: 'golden',
			background: 'scene',
			style: 'solid',
			fillColor: '#000000',
			edgeSoftness: 1.4,
			rimLight: true,
			rimColor: '#ffe6c2',
			rimIntensity: 50,
			rimWidth: 12,
			rimDirection: 'top-left'
		},
		/**
		 * Tuned against a reference set of luminous long-exposure plates:
		 * the field is a very dark neutral grey rather than pure black, the
		 * glow is linear so the source keeps its own falloff, and a wide even
		 * halo supplies the bloom.
		 */
		luminous: {
			label: 'Luminous',
			background: 'color',
			backgroundColor: '#14161a',
			style: 'luminous',
			glowContrast: 0,
			fillColor: '#ffffff',
			edgeSoftness: 5,
			rimLight: true,
			rimColor: '#ffffff',
			rimIntensity: 55,
			rimWidth: 14,
			rimDirection: 'all'
		}
	};

	var DEFAULTS = {
		autoTune: true,
		mode: 'auto',
		tolerance: 32,
		luminanceThreshold: 'auto',
		luminanceSubject: 'dark',
		invert: false,
		edgeSoftness: 3.0,
		despeckle: 0.03,
		fillHoles: 5,
		keepLargest: false,
		style: 'solid',
		glowContrast: 45,
		fillColor: '#000000',
		background: 'transparent',
		backgroundColor: '#ffffff',
		scene: 'sunset',
		rimLight: false,
		rimIntensity: 55,
		rimWidth: 9,
		rimColor: '#ffffff',
		rimDirection: 'all',
		trim: false,
		padding: 6,
		suffix: '_silhouette',
		folderMode: 'same',
		tags: '',
		selectAfter: true
	};

	/* ------------------------------------------------------------------ *
	 * DOM
	 * ------------------------------------------------------------------ */

	function $(id) { return document.getElementById(id); }

	var el = {
		stage: $('stage'),
		stageInner: $('stageInner'),
		stageEmpty: $('stageEmpty'),
		emptyTitle: $('emptyTitle'),
		emptyBody: $('emptyBody'),
		canvasStack: $('canvasStack'),
		canvasOriginal: $('canvasOriginal'),
		canvasResult: $('canvasResult'),
		splitHandle: $('splitHandle'),
		tagOriginal: $('tagOriginal'),
		tagResult: $('tagResult'),

		segMode: $('segMode'),
		helpMode: $('helpMode'),
		swAutoTune: $('swAutoTune'),
		noteAutoTune: $('noteAutoTune'),
		weakHint: $('weakHint'),
		noteWeak: $('noteWeak'),
		backdropHint: $('backdropHint'),
		noteBackdrop: $('noteBackdrop'),
		btnTryContrast: $('btnTryContrast'),
		rangeTolerance: $('rangeTolerance'),
		outTolerance: $('outTolerance'),
		rangeThreshold: $('rangeThreshold'),
		outThreshold: $('outThreshold'),
		btnAutoThreshold: $('btnAutoThreshold'),
		segLumSubject: $('segLumSubject'),
		swInvert: $('swInvert'),

		rangeSoftness: $('rangeSoftness'),
		outSoftness: $('outSoftness'),
		noteSoftness: $('noteSoftness'),
		rangeDespeckle: $('rangeDespeckle'),
		outDespeckle: $('outDespeckle'),
		noteDespeckle: $('noteDespeckle'),
		rangeFillHoles: $('rangeFillHoles'),
		outFillHoles: $('outFillHoles'),
		noteFillHoles: $('noteFillHoles'),
		noteLargest: $('noteLargest'),
		swLargest: $('swLargest'),

		segStyle: $('segStyle'),
		fieldGlowContrast: $('fieldGlowContrast'),
		rangeGlowContrast: $('rangeGlowContrast'),
		outGlowContrast: $('outGlowContrast'),
		swatchesFill: $('swatchesFill'),
		segBackground: $('segBackground'),
		swatchesBackground: $('swatchesBackground'),
		sceneGrid: $('sceneGrid'),
		presetRow: $('presetRow'),
		swRim: $('swRim'),
		rimOptions: $('rimOptions'),
		rangeRimIntensity: $('rangeRimIntensity'),
		outRimIntensity: $('outRimIntensity'),
		rangeRimWidth: $('rangeRimWidth'),
		outRimWidth: $('outRimWidth'),
		swatchesRim: $('swatchesRim'),
		compass: $('compass'),

		swTrim: $('swTrim'),
		fieldPadding: $('fieldPadding'),
		rangePadding: $('rangePadding'),
		outPadding: $('outPadding'),
		inputSuffix: $('inputSuffix'),
		selectFolder: $('selectFolder'),
		inputTags: $('inputTags'),
		swSelect: $('swSelect'),
		btnReset: $('btnReset'),

		segView: $('segView'),
		btnZoomIn: $('btnZoomIn'),
		btnZoomOut: $('btnZoomOut'),
		btnZoomFit: $('btnZoomFit'),
		btnCompare: $('btnCompare'),
		outZoom: $('outZoom'),
		btnExportFolder: $('btnExportFolder'),
		dropVeil: $('dropVeil'),

		queue: $('queue'),
		queueList: $('queueList'),
		queueCount: $('queueCount'),
		queueTitle: $('queueTitle'),
		queueWarn: $('queueWarn'),

		statusDot: $('statusDot'),
		statusTitle: $('statusTitle'),
		statusDetail: $('statusDetail'),
		btnRun: $('btnRun'),
		runLabel: $('runLabel'),
		btnReloadSelection: $('btnReloadSelection'),
		progressTrack: $('progressTrack'),
		progressBar: $('progressBar'),

		btnReload: $('btnReload'),
		btnPickFiles: $('btnPickFiles'),
		toastStack: $('toastStack'),
		libraryName: $('libraryName'),
		chipLibrary: $('chipLibrary'),
		brandVersion: $('brandVersion'),

		btnMinimize: $('btnMinimize'),
		btnMaximize: $('btnMaximize'),
		btnClose: $('btnClose')
	};

	/* ------------------------------------------------------------------ *
	 * State
	 * ------------------------------------------------------------------ */

	var params = loadSettings();

	var state = {
		items: [],
		activeIndex: -1,
		image: null,
		preview: null,
		view: 'split',
		split: 50,
		zoom: 1,
		fitScale: 1,
		panX: 0,
		panY: 0,
		running: false,
		exportFolder: null,
		// Set when the tuner judged this photo's cut untrustworthy, so the
		// warning follows the user out of the sidebar and into the status bar.
		autoWeak: false,
		// Token for the background queue evaluation, so replacing the queue
		// abandons a pass that is still running.
		evalToken: 0,
		evaluating: false,
		// Ids created by the last run, so the selection hand-back to Eagle is
		// not mistaken for the user choosing new source images.
		generatedIds: []
	};

	var previewTimer = null;
	var previewToken = 0;

	/* ------------------------------------------------------------------ *
	 * Small utilities
	 * ------------------------------------------------------------------ */

	function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

	function nextFrame() {
		return new Promise(function (resolve) { requestAnimationFrame(function () { resolve(); }); });
	}

	function formatDuration(ms) {
		if (ms < 1000) return Math.round(ms) + ' ms';
		return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
	}

	function escapeHtml(text) {
		return String(text == null ? '' : text)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function baseName(entry) {
		var name = entry.name || 'image';
		var dot = name.lastIndexOf('.');
		if (dot > 0) name = name.slice(0, dot);
		return name;
	}

	function parseTags(text) {
		return String(text || '')
			.split(',')
			.map(function (t) { return t.trim(); })
			.filter(Boolean);
	}

	/**
	 * Keeps a stored settings blob valid as the schema grows.
	 *
	 * `background` used to be transparent|white|black|custom; it is now
	 * transparent|color|scene with the flat colour held separately, so the
	 * old values are migrated rather than discarded.
	 */
	function normaliseSettings(settings) {
		var LEGACY_BACKGROUND = { white: '#ffffff', black: '#000000' };

		if (Object.prototype.hasOwnProperty.call(LEGACY_BACKGROUND, settings.background)) {
			settings.backgroundColor = LEGACY_BACKGROUND[settings.background];
			settings.background = 'color';
		} else if (settings.background === 'custom') {
			settings.background = 'color';
		} else if (['transparent', 'color', 'scene'].indexOf(settings.background) === -1) {
			settings.background = 'transparent';
		}

		if (!Engine.SCENES[settings.scene]) settings.scene = DEFAULTS.scene;
		if (!Object.prototype.hasOwnProperty.call(Engine.RIM_DIRECTIONS, settings.rimDirection)) {
			settings.rimDirection = DEFAULTS.rimDirection;
		}

		return settings;
	}

	function loadSettings() {
		var settings = Object.assign({}, DEFAULTS);
		var touched = {};
		try {
			var raw = window.localStorage.getItem(STORAGE_KEY) ||
				window.localStorage.getItem(LEGACY_STORAGE_KEY);
			if (raw) {
				var saved = JSON.parse(raw);
				// v2 stores { values, touched }; v1 was a flat object with no
				// record of what was actually chosen.
				var hasList = !!(saved && Array.isArray(saved.touched));
				var values = (saved && saved.values) ? saved.values : saved;
				var list = hasList ? saved.touched : null;

				Object.keys(DEFAULTS).forEach(function (key) {
					if (values[key] === undefined) return;
					if (hasList) {
						// Only what the user actually operated belongs to them;
						// everything else tracks the current defaults.
						if (list.indexOf(key) === -1) return;
					} else if (SUPERSEDED_DEFAULTS[key] !== undefined &&
						values[key] === SUPERSEDED_DEFAULTS[key]) {
						// Legacy blob: a value that merely matches a superseded
						// default was almost certainly never chosen.
						return;
					}
					settings[key] = values[key];
					touched[key] = true;
				});
			}
		} catch (err) { /* defaults are fine */ }
		userTouched = touched;
		return normaliseSettings(settings);
	}

	function saveSettings() {
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
				values: params,
				touched: Object.keys(userTouched)
			}));
		} catch (err) { /* non-fatal */ }
	}

	/* ------------------------------------------------------------------ *
	 * Toasts and status
	 * ------------------------------------------------------------------ */

	function toast(title, text, kind) {
		var node = document.createElement('div');
		node.className = 'toast' + (kind ? ' is-' + kind : '');
		node.innerHTML = '<span class="toast-dot"></span><div class="toast-body">' +
			'<span class="toast-title">' + escapeHtml(title) + '</span>' +
			(text ? '<span class="toast-text">' + escapeHtml(text) + '</span>' : '') +
			'</div>';
		el.toastStack.appendChild(node);

		setTimeout(function () {
			node.classList.add('is-leaving');
			setTimeout(function () { node.remove(); }, 220);
		}, kind === 'error' ? 6000 : 3200);
	}

	function setStatus(kind, title, detail) {
		el.statusDot.dataset.state = kind;
		el.statusTitle.textContent = title;
		el.statusDetail.textContent = detail || '';
	}

	function setProgress(fraction) {
		if (fraction == null) {
			el.progressTrack.hidden = true;
			el.progressBar.style.width = '0%';
			return;
		}
		el.progressTrack.hidden = false;
		el.progressBar.style.width = clamp(fraction, 0, 1) * 100 + '%';
	}

	/* ------------------------------------------------------------------ *
	 * Theme and window chrome
	 * ------------------------------------------------------------------ */

	function applyTheme(theme) {
		document.body.dataset.theme = theme === 'light' ? 'light' : 'dark';
	}

	function wireWindowChrome() {
		el.btnMinimize.addEventListener('click', function () {
			if (window.eagle && eagle.window) eagle.window.minimize();
		});

		el.btnMaximize.addEventListener('click', function () {
			if (!window.eagle || !eagle.window) return;
			eagle.window.isMaximized().then(function (maximised) {
				return maximised ? eagle.window.unmaximize() : eagle.window.maximize();
			}).catch(function () { /* ignore */ });
		});

		el.btnClose.addEventListener('click', function () {
			// In a frameless Electron window window.close() closes the
			// BrowserWindow. Hiding is the graceful fallback if it is
			// unavailable for any reason.
			try { window.close(); } catch (err) { /* fall through */ }
			setTimeout(function () {
				if (window.eagle && eagle.window) {
					try { eagle.window.hide(); } catch (err) { /* ignore */ }
				}
			}, 120);
		});
	}

	/* ------------------------------------------------------------------ *
	 * Control binding
	 * ------------------------------------------------------------------ */

	function paintRange(input) {
		var min = Number(input.min || 0);
		var max = Number(input.max || 100);
		var value = Number(input.value);
		var pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
		input.style.setProperty('--fill', pct + '%');
	}

	function bindSegmented(container, key, onChange) {
		function sync() {
			Array.prototype.forEach.call(container.children, function (button) {
				button.classList.toggle('is-active', button.dataset.value === String(params[key]));
			});
		}
		container.addEventListener('click', function (event) {
			var button = event.target.closest('button[data-value]');
			if (!button) return;
			params[key] = button.dataset.value;
			markTouched(key);
			sync();
			saveSettings();
			if (onChange) onChange(params[key]);
		});
		sync();
		return sync;
	}

	function bindSwitch(button, key, onChange) {
		function sync() {
			var on = !!params[key];
			button.classList.toggle('is-on', on);
			button.setAttribute('aria-checked', on ? 'true' : 'false');
		}
		button.addEventListener('click', function () {
			params[key] = !params[key];
			markTouched(key);
			sync();
			saveSettings();
			if (onChange) onChange(params[key]);
		});
		sync();
		return sync;
	}

	function bindRange(input, output, options) {
		var opts = options || {};
		function sync() {
			input.value = opts.toInput ? opts.toInput(params[opts.key]) : params[opts.key];
			paintRange(input);
			output.textContent = opts.format ? opts.format(params[opts.key]) : input.value;
		}
		input.addEventListener('input', function () {
			params[opts.key] = opts.fromInput ? opts.fromInput(input.value) : Number(input.value);
			markTouched(opts.key);
			paintRange(input);
			output.textContent = opts.format ? opts.format(params[opts.key]) : input.value;
			saveSettings();
			if (opts.onChange) opts.onChange(params[opts.key]);
		});
		sync();
		return sync;
	}

	function buildSwatches(container, values, key, onChange) {
		container.innerHTML = '';

		values.forEach(function (color) {
			var button = document.createElement('button');
			button.type = 'button';
			button.className = 'swatch';
			button.dataset.color = color;
			button.title = color;
			button.style.background = color;
			container.appendChild(button);
		});

		var custom = document.createElement('button');
		custom.type = 'button';
		custom.className = 'swatch swatch-custom';
		custom.title = 'Custom colour';
		var input = document.createElement('input');
		input.type = 'color';
		custom.appendChild(input);
		container.appendChild(custom);

		function sync() {
			var value = String(params[key]).toLowerCase();
			var matched = false;
			Array.prototype.forEach.call(container.querySelectorAll('.swatch[data-color]'), function (button) {
				var isActive = button.dataset.color.toLowerCase() === value;
				button.classList.toggle('is-active', isActive);
				if (isActive) matched = true;
			});
			custom.classList.toggle('is-active', !matched);
			if (!matched) {
				custom.style.setProperty('--swatch-color', params[key]);
				input.value = normaliseHex(params[key]);
			}
		}

		container.addEventListener('click', function (event) {
			var button = event.target.closest('.swatch[data-color]');
			if (!button) return;
			params[key] = button.dataset.color;
			markTouched(key);
			sync();
			saveSettings();
			if (onChange) onChange(params[key]);
		});

		input.addEventListener('input', function () {
			params[key] = input.value;
			markTouched(key);
			custom.style.setProperty('--swatch-color', input.value);
			sync();
			saveSettings();
			if (onChange) onChange(params[key]);
		});

		sync();
		return sync;
	}

	function normaliseHex(value) {
		var hex = String(value || '#000000').replace(/^#/, '');
		if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
		if (hex.length !== 6) return '#000000';
		return '#' + hex;
	}

	function bindCompass(container, key, onChange) {
		function sync() {
			Array.prototype.forEach.call(container.children, function (button) {
				button.classList.toggle('is-active', button.dataset.dir === String(params[key]));
			});
		}
		container.addEventListener('click', function (event) {
			var button = event.target.closest('button[data-dir]');
			if (!button) return;
			params[key] = button.dataset.dir;
			markTouched(key);
			sync();
			saveSettings();
			if (onChange) onChange(params[key]);
		});
		sync();
		return sync;
	}

	/* ------------------------------------------------------------------ *
	 * Scene picker and one-click looks
	 * ------------------------------------------------------------------ */

	/** Renders a tiny preview of a scene so the tiles match the real output. */
	function scenePreviewUrl(id, width, height) {
		try {
			var imageData = Engine.renderScene(id, width, height);
			var canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			canvas.getContext('2d').putImageData(imageData, 0, 0);
			return canvas.toDataURL('image/png');
		} catch (err) {
			Bridge.warn('scene preview failed:', err && err.message);
			return '';
		}
	}

	function buildSceneGrid() {
		el.sceneGrid.innerHTML = '';
		Object.keys(Engine.SCENES).forEach(function (id) {
			var url = scenePreviewUrl(id, 132, 74);
			var tile = document.createElement('button');
			tile.type = 'button';
			tile.className = 'scene-tile';
			tile.dataset.scene = id;
			tile.title = Engine.SCENES[id].label;
			if (url) tile.style.backgroundImage = 'url(' + url + ')';
			tile.innerHTML = '<span>' + escapeHtml(Engine.SCENES[id].label) + '</span>';
			el.sceneGrid.appendChild(tile);
		});
	}

	function syncSceneGrid() {
		Array.prototype.forEach.call(el.sceneGrid.children, function (tile) {
			tile.classList.toggle('is-active', tile.dataset.scene === params.scene);
		});
	}

	function buildPresets() {
		el.presetRow.innerHTML = '';
		Object.keys(LOOKS).forEach(function (id) {
			var look = LOOKS[id];
			// Scene-based looks show the generated backdrop; a flat-colour
			// look shows its colour instead.
			var url = look.scene ? scenePreviewUrl(look.scene, 44, 44) : '';
			var style = url
				? 'background-image:url(' + url + ')'
				: (look.backgroundColor ? 'background-color:' + look.backgroundColor : '');

			var button = document.createElement('button');
			button.type = 'button';
			button.className = 'preset';
			button.dataset.preset = id;
			button.title = 'Apply the ' + look.label + ' look';
			button.innerHTML = '<i' + (style ? ' style="' + style + '"' : '') + '></i>' +
				'<span>' + escapeHtml(look.label) + '</span>';
			el.presetRow.appendChild(button);
		});
	}

	function applyLook(id) {
		var look = LOOKS[id];
		if (!look) return;
		Object.keys(look).forEach(function (key) {
			if (key === 'label') return;
			params[key] = look[key];
			markTouched(key);
		});
		saveSettings();
		applySettingsToControls();
		refreshFieldVisibility();
		renderPreview();
	}

	/**
	 * Background modelling assumes the backdrop is roughly one colour. When
	 * the border ring carries two well-separated colours — a cast shadow, a
	 * graduated studio sweep — the fill can neither remove the darker part
	 * without eating the subject, nor leave it without producing ragged
	 * blobs. Contrast mode splits on brightness instead and handles those
	 * images far better, so say so rather than letting the user fight it.
	 *
	 * The threshold is calibrated against a small reference set (an even
	 * backdrop measures about 0.05, a shadowed one about 0.12) and is only
	 * ever a suggestion, so a false positive costs one click.
	 */
	var BACKDROP_SPREAD_HINT = 0.09;

	function updateDetectionHint(result) {
		// With auto-tune on the tuner has already weighed both methods and
		// chosen; a suggestion on top would only contradict what is on screen.
		if (params.autoTune) {
			el.backdropHint.hidden = true;
			return;
		}

		var d = result && result.diagnostics;
		var show = !!(d && d.mode === 'background' &&
			typeof d.backdropSpread === 'number' && d.backdropSpread >= BACKDROP_SPREAD_HINT);

		el.backdropHint.hidden = !show;
		if (show) {
			el.noteBackdrop.textContent = 'This backdrop is uneven — it holds two quite ' +
				'different colours, such as a cast shadow. Cutting on brightness usually ' +
				'gives a cleaner edge here.';
		}
	}

	/* ------------------------------------------------------------------ *
	 * Automatic tuning
	 * ------------------------------------------------------------------ */

	/**
	 * Reads the image and adopts the settings that suit it, so a batch does
	 * not have to share one recipe. See Engine.autoTune for what is measured
	 * and, just as importantly, what is deliberately left alone.
	 */
	function tunedOptions(image, maxDim) {
		var options = engineOptions(maxDim);
		if (!params.autoTune || !image) return { options: options, report: null };

		try {
			var tuned = Engine.autoTune(image, engineOptions(PREVIEW_MAX));
			Object.keys(tuned).forEach(function (key) {
				if (key === 'report') return;
				options[key] = tuned[key];
			});
			return { options: options, report: tuned.report };
		} catch (err) {
			Bridge.warn('auto-tune failed:', err && err.message);
			return { options: options, report: null };
		}
	}

	/** Adopts the tuned settings globally, for the previewed image. */
	function applyAutoTune(image) {
		var tuned = tunedOptions(image, PREVIEW_MAX);
		if (!tuned.report) return null;
		Object.keys(tuned.options).forEach(function (key) {
			params[key] = tuned.options[key];
		});
		applySettingsToControls();
		refreshFieldVisibility();
		updateAutoTuneNote(tuned.report);
		state.autoWeak = !!(tuned.report && tuned.report.weak);
		return tuned.report;
	}

	/**
	 * Judges settings the user has taken over.
	 *
	 * The tuner only reports on its own choices, so the moment someone sets a
	 * threshold by hand the reliability verdict used to vanish — exactly when
	 * it is most useful. This runs the same measurement over whatever is
	 * actually in force, at analysis size and after a pause, so dragging a
	 * slider does not pay for it on every frame.
	 */
	var assessTimer = null;

	function scheduleAssessment() {
		if (assessTimer) clearTimeout(assessTimer);
		assessTimer = setTimeout(runAssessment, 320);
	}

	function runAssessment() {
		if (params.autoTune || !state.image) return;
		try {
			var verdict = Engine.assess(state.image, engineOptions(PREVIEW_MAX));
			state.autoWeak = !!verdict.weak;
			if (verdict.weak) {
				el.noteWeak.textContent = 'This cut is not following a real edge: shifting the ' +
					'detection level a little moves the outline a long way. The subject and its ' +
					'surroundings are too alike in tone here. A cut-out PNG from an AI background ' +
					'remover drops straight in, and Darkshape will use its transparency as the shape.';
				el.weakHint.hidden = false;
				setStatus('warn', 'Rough cut — nothing solid to separate',
					'See the note under the Mode control.');
			} else {
				el.weakHint.hidden = true;
			}
		} catch (err) {
			Bridge.warn('assessment failed:', err && err.message);
		}
	}

	function updateAutoTuneNote(report) {
		if (!params.autoTune) {
			el.weakHint.hidden = true;
			return;
		}
		if (!report) {
			el.noteAutoTune.textContent = 'Nothing read cleanly — try the controls yourself.';
			el.noteAutoTune.dataset.state = 'muted';
			el.weakHint.hidden = true;
			return;
		}
		var why = report.mode === 'luminance'
			? 'Reading this photo as Contrast — its backdrop holds more than one colour, which background modelling cannot follow.'
			: 'Reading this photo as Background modelling — its backdrop is even.';
		el.noteAutoTune.textContent = why;
		el.noteAutoTune.dataset.state = 'active';

		// A cut that moves when the detection level shifts is not following
		// anything in the picture. Say so rather than let a confident-looking
		// blob pass as an answer.
		if (report.weak) {
			el.noteWeak.textContent = 'Very little to go on here: nudging the detection ' +
				'level moves the outline a long way, which means it is not following a real ' +
				'edge — the subject and its surroundings are too alike in tone. Expect a rough ' +
				'result from this photo. A cut-out PNG from an AI background remover drops ' +
				'straight in, and Darkshape will use its transparency as the shape.';
			el.weakHint.hidden = false;
		} else {
			el.weakHint.hidden = true;
		}
	}

	/* ------------------------------------------------------------------ *
	 * Conditional field visibility
	 * ------------------------------------------------------------------ */

	function refreshFieldVisibility() {
		var mode = params.mode;
		Array.prototype.forEach.call(document.querySelectorAll('[data-when="background"]'), function (node) {
			node.hidden = !(mode === 'background' || mode === 'auto');
		});
		Array.prototype.forEach.call(document.querySelectorAll('[data-when="luminance"]'), function (node) {
			node.hidden = mode !== 'luminance';
		});

		el.fieldPadding.hidden = !params.trim;
		el.swatchesBackground.hidden = params.background !== 'color';
		el.sceneGrid.hidden = params.background !== 'scene';
		el.rimOptions.hidden = !params.rimLight;
		el.fieldGlowContrast.hidden = params.style !== 'luminous';
		syncSceneGrid();

		var help = {
			auto: 'Picks alpha for cut-out PNGs, otherwise models the background.',
			background: 'Models the colours around the border and floods inwards from the frame.',
			luminance: 'Splits the image purely on brightness — ideal for high-contrast subjects.',
			alpha: 'Uses the existing transparency of the file as the silhouette.'
		};
		el.helpMode.textContent = help[mode] || '';

		syncThresholdReadout(null);
	}

	/**
	 * The brightness-split readout: the level in use, and when it is automatic,
	 * what the automatic choice actually resolved to. Without that number the
	 * readout just echoed the button's own label back at the user.
	 */
	function autoThresholdLabel(result) {
		if (params.luminanceThreshold !== 'auto') {
			return String(Math.round(Number(params.luminanceThreshold)));
		}
		var resolved = (result && result.diagnostics) ? result.diagnostics.luminanceThreshold : null;
		return (typeof resolved === 'number') ? 'Auto · ' + Math.round(resolved) : 'Auto';
	}

	function syncThresholdReadout(result) {
		el.outThreshold.textContent = autoThresholdLabel(result);
		// Nothing to reset while the level is already automatic.
		el.btnAutoThreshold.disabled = params.luminanceThreshold === 'auto';
	}

	/* ------------------------------------------------------------------ *
	 * Engine options
	 * ------------------------------------------------------------------ */

	function engineOptions(maxDim) {
		return {
			mode: params.mode,
			tolerance: params.tolerance,
			luminanceThreshold: params.luminanceThreshold,
			luminanceSubject: params.luminanceSubject,
			invert: params.invert,
			edgeSoftness: params.edgeSoftness,
			despeckle: params.despeckle,
			fillHoles: params.fillHoles,
			keepLargest: params.keepLargest,
			style: params.style,
			glowContrast: params.glowContrast,
			fillColor: params.fillColor,
			background: params.background,
			backgroundColor: params.backgroundColor,
			scene: params.scene,
			rimLight: params.rimLight,
			rimIntensity: params.rimIntensity,
			rimWidth: params.rimWidth,
			rimColor: params.rimColor,
			rimDirection: params.rimDirection,
			trim: params.trim,
			padding: params.padding,
			maxDim: maxDim
		};
	}

	/* ------------------------------------------------------------------ *
	 * Sources
	 * ------------------------------------------------------------------ */

	function makeEntry(source) {
		return {
			id: source.id || null,
			name: source.name || 'image',
			ext: source.ext || '',
			filePath: source.filePath || '',
			thumbnailPath: source.thumbnailPath || '',
			fileURL: source.fileURL || '',
			folders: source.folders || [],
			item: source.item || null,
			image: null,
			thumb: null,
			status: 'idle',
			message: '',
			resultId: null
		};
	}

	function setItems(entries, origin) {
		state.items = entries;
		state.activeIndex = entries.length ? 0 : -1;
		state.image = null;
		state.preview = null;
		state.zoom = 1;
		state.panX = 0;
		state.panY = 0;

		el.queueTitle.textContent = origin === 'drop' ? 'Dropped images' : 'Queue';
		renderQueue();
		updateRunButton();

		if (!entries.length) {
			showEmptyState(
				'Select images in Eagle',
				'Choose one photo for a single silhouette, or several for a batch run. You can also drop image files here.'
			);
			updateRefineNotes(null);
			reportQueueEvaluation();
			setStatus('idle', 'Ready', 'No images loaded.');
			return;
		}

		el.stageEmpty.hidden = true;
		el.stageInner.hidden = false;

		setStatus('ready',
			entries.length === 1 ? 'Single image' : 'Batch of ' + entries.length,
			'Rendering preview…');

		activate(0);
		// Check the rest in the background so nothing is a surprise later.
		evaluateQueue();
	}

	function showEmptyState(title, body) {
		el.emptyTitle.textContent = title;
		el.emptyBody.textContent = body;
		el.stageEmpty.hidden = false;
		el.stageInner.hidden = true;
	}

	async function loadSelectedItems(silent) {
		if (!Bridge.available()) {
			showEmptyState(
				'Darkshape is not running inside Eagle',
				'Open this plugin from Eagle’s plugin menu, or drop image files onto this window to try it out.'
			);
			el.emptyTitle.textContent = 'Not running inside Eagle';
			return;
		}

		var result = await Bridge.getSelectedItems();

		if (result.skipped.length) {
			toast(
				'Skipped ' + result.skipped.length + ' item' + (result.skipped.length === 1 ? '' : 's'),
				result.skipped.map(function (s) { return s.name + ' — ' + s.reason; }).join('; '),
				'warn'
			);
		}

		if (!result.items.length) {
			if (!silent) toast('Nothing selected', 'Select one or more images in Eagle first.', 'warn');
			setItems([], 'eagle');
			return;
		}

		setItems(result.items.map(makeEntry), 'eagle');
	}

	async function pickFiles() {
		var paths = await Bridge.chooseImageFiles();
		if (!paths.length) return;
		var entries = paths.map(function (p) {
			return makeEntry({ name: p.name, ext: p.ext, filePath: p.path, folders: [] });
		});
		var merged = state.items.concat(entries);
		setItems(merged, 'drop');
	}

	/** Identifies a selection, so a reload only happens when it really changed. */
	function selectionKey(items) {
		return items.map(function (item) {
			return item.id || item.filePath || item.name;
		}).sort().join('|');
	}

	/**
	 * Picks up a new Eagle selection when the plugin window is brought back
	 * to the front, so switching images in the library and returning here
	 * just works.
	 *
	 * Deliberately conservative: it does nothing when the selection is
	 * unchanged (so tabbing away and back never discards your work), and it
	 * ignores a selection that is only the items this plugin just created —
	 * otherwise handing the results back to Eagle would replace the queue
	 * with its own output every time the window regained focus.
	 */
	async function reloadIfSelectionChanged() {
		if (state.running || !Bridge.available()) return;

		try {
			var result = await Bridge.getSelectedItems();
			if (!result.items.length) return; // nothing selected: leave the queue be
			if (selectionKey(result.items) === selectionKey(state.items)) return;

			if (state.generatedIds.length) {
				var ours = {};
				state.generatedIds.forEach(function (id) { ours[id] = true; });
				var allOurs = result.items.every(function (item) { return ours[item.id]; });
				if (allOurs) return;
			}

			setItems(result.items.map(makeEntry), 'eagle');
		} catch (err) {
			Bridge.warn('selection refresh failed:', err && err.message);
		}
	}

	/* ------------------------------------------------------------------ *
	 * Queue strip
	 * ------------------------------------------------------------------ */

	function renderQueue() {
		el.queue.hidden = state.items.length <= 1;
		el.queueCount.textContent = state.items.length + ' image' + (state.items.length === 1 ? '' : 's');
		el.queueList.innerHTML = '';

		state.items.forEach(function (entry, index) {
			var tile = document.createElement('div');
			tile.className = 'queue-item';
			tile.dataset.index = String(index);
			tile.title = entry.name;
			tile.innerHTML =
				'<div class="queue-thumb-fallback">' + escapeHtml((entry.ext || '?').toUpperCase().slice(0, 4)) + '</div>' +
				'<div class="queue-name">' + escapeHtml(entry.name) + '</div>' +
				'<span class="queue-flag" aria-hidden="true">!</span>' +
				'<span class="queue-badge"></span>';

			tile.addEventListener('click', function () { activate(index); });
			el.queueList.appendChild(tile);

			Bridge.loadThumbnail(entry).then(function (dataUrl) {
				if (!dataUrl || !tile.isConnected) return;
				var img = document.createElement('img');
				img.className = 'queue-thumb';
				img.src = dataUrl;
				img.alt = '';
				var fallback = tile.querySelector('.queue-thumb-fallback');
				if (fallback) fallback.replaceWith(img);
			}).catch(function () { /* keep the fallback */ });
		});

		refreshQueueStates();
	}

	function refreshQueueStates() {
		Array.prototype.forEach.call(el.queueList.children, function (tile, index) {
			var entry = state.items[index];
			if (!entry) return;
			tile.classList.toggle('is-active', index === state.activeIndex);
			tile.classList.toggle('is-working', entry.status === 'working');
			tile.classList.toggle('is-done', entry.status === 'done');
			tile.classList.toggle('is-error', entry.status === 'error');
			tile.classList.toggle('is-weak', entry.weak === true);
			if (entry.weak === true) {
				tile.title = entry.name + ' — cannot be separated cleanly';
			}
			var badge = tile.querySelector('.queue-badge');
			if (badge) {
				badge.textContent = entry.status === 'done' ? '✓'
					: entry.status === 'error' ? '!'
						: entry.status === 'working' ? '' : '';
			}
		});
	}

	/* ------------------------------------------------------------------ *
	 * Queue evaluation
	 * ------------------------------------------------------------------ */

	/**
	 * Checks every queued photo and flags the ones that cannot be separated
	 * cleanly, so a batch is not a surprise discovered one image at a time.
	 *
	 * Runs in the background after the queue loads, a frame apart so the
	 * interface stays responsive, and releases each decoded bitmap as it
	 * goes — holding fifty of them would cost more memory than the whole
	 * render pipeline.
	 */
	async function evaluateQueue() {
		var token = ++state.evalToken;

		if (!params.autoTune || state.items.length < 2) {
			state.evaluating = false;
			reportQueueEvaluation();
			return;
		}

		state.evaluating = true;
		reportQueueEvaluation();

		for (var i = 0; i < state.items.length; i++) {
			if (token !== state.evalToken) return; // queue was replaced
			var entry = state.items[i];
			if (entry.checked) continue;

			try {
				var image = (i === state.activeIndex && state.image)
					? state.image
					: await ensureImage(entry);
				var tuned = Engine.autoTune(image, engineOptions(PREVIEW_MAX));
				entry.checked = true;
				entry.weak = !!(tuned.report && tuned.report.weak);
				entry.stability = tuned.report ? tuned.report.stability : null;
				// Keep only the one on screen.
				if (i !== state.activeIndex) entry.image = null;
			} catch (err) {
				entry.checked = true;
				entry.weak = null;
				Bridge.warn('could not evaluate ' + entry.name + ':', err && err.message);
			}

			if (token !== state.evalToken) return;
			refreshQueueStates();
			reportQueueEvaluation();
			await nextFrame();
		}

		state.evaluating = false;
		reportQueueEvaluation();
	}

	/** How many of the queue cannot be separated, so far. */
	function weakCount() {
		return state.items.filter(function (e) { return e.weak === true; }).length;
	}

	function reportQueueEvaluation() {
		if (!params.autoTune || state.items.length < 2) {
			el.queueWarn.hidden = true;
			return;
		}
		var checked = state.items.filter(function (e) { return e.checked; }).length;
		if (!checked) {
			el.queueWarn.hidden = true;
			return;
		}

		var weak = weakCount();
		el.queueWarn.hidden = false;
		el.queueWarn.classList.toggle('is-warning', weak > 0);

		if (checked < state.items.length) {
			el.queueWarn.textContent = 'Checking ' + checked + ' of ' + state.items.length + '…';
		} else if (weak === 0) {
			el.queueWarn.textContent = 'All ' + checked + ' can be separated';
		} else {
			el.queueWarn.textContent = weak + ' of ' + checked + ' cannot be separated cleanly';
		}
	}

	/* ------------------------------------------------------------------ *
	 * Preview
	 * ------------------------------------------------------------------ */

	async function ensureImage(entry) {
		if (entry.image) return entry.image;
		var image = await Bridge.loadImage(entry);
		entry.image = image;
		return image;
	}

	async function activate(index) {
		if (index < 0 || index >= state.items.length) return;
		state.activeIndex = index;
		state.image = null;
		state.preview = null;
		state.zoom = 1;
		state.panX = 0;
		state.panY = 0;
		refreshQueueStates();

		var entry = state.items[index];
		el.stageEmpty.hidden = true;
		el.stageInner.hidden = false;
		setStatus('busy', 'Loading', entry.name);

		try {
			state.image = await ensureImage(entry);
			applyAutoTune(state.image);
			// renderPreview owns the status from here: it knows the preview
			// size, how long it took, and whether the cut can be trusted.
			renderPreview();
		} catch (err) {
			showEmptyState('That image could not be opened', err.message);
			setStatus('error', 'Could not open image', err.message);
		}
	}

	function schedulePreview() {
		if (previewTimer) clearTimeout(previewTimer);
		previewTimer = setTimeout(renderPreview, 45);
	}

	/**
	 * Reports what the Refine controls actually did to the current image.
	 *
	 * Several of them are conditional by nature: on a clean single-subject
	 * photo there are no stray islands to drop and no enclosed gaps to close,
	 * so a perfectly working slider changes nothing. Without this feedback
	 * that is indistinguishable from a broken one.
	 */
	function updateRefineNotes(result) {
		var notes = { softness: '', despeckle: '', fillHoles: '', largest: '' };
		var states = {};

		function plural(count, word) {
			return count + ' ' + word + (count === 1 ? '' : 's');
		}

		if (result && result.diagnostics) {
			var d = result.diagnostics;
			var islands = d.islands || 0;
			var frame = result.width * result.height;

			if ((d.edgeRadius || 0) >= 0.5) {
				var featherPx = Math.round(d.edgeRadius);
				// Below about 3px the blur is only anti-aliasing, so a contour
				// following fur or fabric texture stays visibly ragged. Say so
				// rather than reporting a number with no sense of scale.
				notes.softness = 'Contour feathered by about ' + featherPx + ' px at this size.' +
					(featherPx < 3 ? ' That is only smoothing the step edges — raise it to soften fur and fabric outlines.' : '');
				states.softness = 'active';
			} else {
				notes.softness = 'Edges left crisp — raise this to soften them.';
				states.softness = 'muted';
			}

			if (d.islandsDropped > 0) {
				notes.despeckle = plural(d.islandsDropped, 'stray island') + ' removed · ' +
					(((d.droppedPixels || 0) / frame) * 100).toFixed(2) + '% of the frame.';
				states.despeckle = 'active';
			} else if (islands === 0) {
				notes.despeckle = 'Nothing detected — check the tolerance or the detection mode.';
				states.despeckle = 'muted';
			} else if (islands === 1) {
				notes.despeckle = 'One clean shape — nothing to remove.';
				states.despeckle = 'muted';
			} else {
				notes.despeckle = plural(islands, 'shape') + ' found, all above the threshold.';
				states.despeckle = 'muted';
			}

			if (d.holes > 0) {
				// Report both halves. Saying only "86 gaps closed" hides the
				// one large gap still letting the backdrop through.
				var closed = d.holesFilled || 0;
				var remaining = d.holes - closed;
				var parts = [];
				if (closed > 0) parts.push(plural(closed, 'gap') + ' closed');
				if (remaining > 0) {
					parts.push(plural(remaining, 'gap') + ' still open — raise the limit');
				}
				notes.fillHoles = parts.join(' · ') + '.';
				states.fillHoles = 'active';
			} else if (d.mode === 'background') {
				notes.fillHoles = 'Background mode cuts from the frame inwards, so shapes come out solid: there is nothing to close. Switch to Contrast or Alpha mode for a source with real gaps.';
				states.fillHoles = 'muted';
			} else {
				notes.fillHoles = 'No enclosed gaps in this shape.';
				states.fillHoles = 'muted';
			}

			if (islands <= 1) {
				notes.largest = islands === 1 ? 'Only one shape to keep.' : 'No shapes found.';
				states.largest = 'muted';
			} else if (params.keepLargest) {
				notes.largest = plural(islands - 1, 'smaller shape') + ' discarded.';
				states.largest = 'active';
			} else {
				notes.largest = plural(islands, 'separate shapes') + ' currently kept.';
				states.largest = 'muted';
			}
		}

		[['noteSoftness', 'softness'], ['noteDespeckle', 'despeckle'],
			['noteFillHoles', 'fillHoles'], ['noteLargest', 'largest']].forEach(function (pair) {
				var node = el[pair[0]];
				node.textContent = notes[pair[1]];
				if (states[pair[1]]) node.dataset.state = states[pair[1]];
				else delete node.dataset.state;
			});
	}

	function renderPreview() {
		if (!state.image) {
			updateRefineNotes(null);
			updateDetectionHint(null);
			return;
		}
		var token = ++previewToken;
		var started = performance.now();

		try {
			var result = Engine.renderToCanvas(state.image, el.canvasResult, engineOptions(PREVIEW_MAX));
			if (token !== previewToken) return;
			state.preview = result;
			drawOriginal(result);
			layoutStage();
			updateRunButton();
			updateRefineNotes(result);
			updateDetectionHint(result);
			syncThresholdReadout(result);
			var subjectLabel = state.items.length <= 1
				? 'Single image'
				: 'Image ' + (state.activeIndex + 1) + ' of ' + state.items.length;
			if (!params.autoTune) {
				// Hand-set values are judged separately, once the dragging stops.
				state.autoWeak = false;
				el.weakHint.hidden = true;
				setStatus('ready', subjectLabel,
					result.width + ' × ' + result.height + ' preview · ' + formatDuration(performance.now() - started));
				scheduleAssessment();
			} else if (state.autoWeak) {
				setStatus('warn', 'Rough cut — nothing to separate in this photo',
					'See the note under the Mode control. A cut-out PNG will work far better.');
			} else {
				setStatus('ready', subjectLabel,
					result.width + ' × ' + result.height + ' preview · ' + formatDuration(performance.now() - started));
			}
		} catch (err) {
			updateRefineNotes(null);
			updateDetectionHint(null);
			setStatus('error', 'Preview failed', err.message);
			Bridge.warn('preview failed:', err && err.message);
		}
	}

	/**
	 * Draws the same crop of the source image as the result, so the split
	 * comparison lines up even when trimming changed the bounds.
	 */
	function drawOriginal(result) {
		var canvas = el.canvasOriginal;
		canvas.width = result.width;
		canvas.height = result.height;
		var ctx = canvas.getContext('2d');
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';

		var scale = result.scale || 1; // processed px per source px
		var bounds = result.bounds;
		ctx.drawImage(
			state.image,
			bounds.x / scale, bounds.y / scale, bounds.width / scale, bounds.height / scale,
			0, 0, result.width, result.height
		);
	}

	function layoutStage() {
		if (!state.preview) return;
		var box = el.stageInner.getBoundingClientRect();
		var availableW = Math.max(60, box.width - 60);
		var availableH = Math.max(60, box.height - 60);

		var w = state.preview.width;
		var h = state.preview.height;
		state.fitScale = Math.min(availableW / w, availableH / h);

		var scale = state.fitScale * state.zoom;
		var stackW = Math.max(1, Math.round(w * scale));
		var stackH = Math.max(1, Math.round(h * scale));

		el.canvasStack.style.width = stackW + 'px';
		el.canvasStack.style.height = stackH + 'px';

		clampPan(stackW, stackH, availableW, availableH);
		el.canvasStack.style.transform = 'translate(' + state.panX + 'px,' + state.panY + 'px)';

		el.outZoom.textContent = state.zoom <= 1.001 ? 'Fit' : Math.round(state.zoom * 100) + '%';
	}

	function clampPan(stackW, stackH, availableW, availableH) {
		var maxX = Math.max(0, (stackW - availableW) / 2);
		var maxY = Math.max(0, (stackH - availableH) / 2);
		state.panX = clamp(state.panX, -maxX, maxX);
		state.panY = clamp(state.panY, -maxY, maxY);
	}

	function setZoom(zoom) {
		state.zoom = clamp(zoom, 1, MAX_ZOOM);
		if (state.zoom <= 1.001) { state.panX = 0; state.panY = 0; }
		layoutStage();
	}

	function setSplit(percent) {
		state.split = clamp(percent, 0, 100);
		el.canvasStack.style.setProperty('--split', state.split + '%');
	}

	function setView(view) {
		state.view = view;
		el.stage.dataset.view = view;
		Array.prototype.forEach.call(el.segView.children, function (button) {
			button.classList.toggle('is-active', button.dataset.value === view);
		});
	}

	/* ------------------------------------------------------------------ *
	 * Stage interactions
	 * ------------------------------------------------------------------ */

	function wireStage() {
		setSplit(state.split);
		setView(state.view);

		// --- split handle ---
		el.splitHandle.addEventListener('pointerdown', function (event) {
			event.preventDefault();
			event.stopPropagation();
			el.splitHandle.setPointerCapture(event.pointerId);

			function move(moveEvent) {
				var rect = el.canvasStack.getBoundingClientRect();
				if (!rect.width) return;
				setSplit(((moveEvent.clientX - rect.left) / rect.width) * 100);
			}
			function up(upEvent) {
				el.splitHandle.releasePointerCapture(upEvent.pointerId);
				el.splitHandle.removeEventListener('pointermove', move);
				el.splitHandle.removeEventListener('pointerup', up);
			}
			el.splitHandle.addEventListener('pointermove', move);
			el.splitHandle.addEventListener('pointerup', up);
		});

		// --- panning when zoomed in ---
		var panning = null;
		el.canvasStack.addEventListener('pointerdown', function (event) {
			if (state.zoom <= 1.001) return;
			event.preventDefault();
			el.canvasStack.setPointerCapture(event.pointerId);
			el.canvasStack.classList.add('is-panning');
			panning = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };

			function move(moveEvent) {
				if (!panning) return;
				state.panX = panning.panX + (moveEvent.clientX - panning.x);
				state.panY = panning.panY + (moveEvent.clientY - panning.y);
				layoutStage();
			}
			function up(upEvent) {
				panning = null;
				el.canvasStack.classList.remove('is-panning');
				el.canvasStack.releasePointerCapture(upEvent.pointerId);
				el.canvasStack.removeEventListener('pointermove', move);
				el.canvasStack.removeEventListener('pointerup', up);
			}
			el.canvasStack.addEventListener('pointermove', move);
			el.canvasStack.addEventListener('pointerup', up);
		});

		// --- wheel zoom ---
		el.stage.addEventListener('wheel', function (event) {
			if (!state.preview) return;
			event.preventDefault();
			var factor = Math.exp(-event.deltaY * 0.0016);
			setZoom(state.zoom * factor);
		}, { passive: false });

		el.btnZoomIn.addEventListener('click', function () { setZoom(state.zoom * 1.25); });
		el.btnZoomOut.addEventListener('click', function () { setZoom(state.zoom / 1.25); });
		el.btnZoomFit.addEventListener('click', function () { setZoom(1); });

		el.segView.addEventListener('click', function (event) {
			var button = event.target.closest('button[data-value]');
			if (button) setView(button.dataset.value);
		});

		// Hold the compare button to reveal the untouched photo.
		var heldView = null;
		function beginCompare(event) {
			event.preventDefault();
			heldView = state.view;
			setView('original');
		}
		function endCompare() {
			if (heldView) { setView(heldView); heldView = null; }
		}
		el.btnCompare.addEventListener('pointerdown', beginCompare);
		el.btnCompare.addEventListener('pointerup', endCompare);
		el.btnCompare.addEventListener('pointerleave', endCompare);
		el.btnCompare.addEventListener('pointercancel', endCompare);

		window.addEventListener('resize', function () { layoutStage(); });

		wireDragAndDrop();
	}

	function wireDragAndDrop() {
		var depth = 0;

		window.addEventListener('dragenter', function (event) {
			event.preventDefault();
			depth++;
			el.stage.classList.add('is-dropping');
		});
		window.addEventListener('dragover', function (event) { event.preventDefault(); });
		window.addEventListener('dragleave', function (event) {
			event.preventDefault();
			depth = Math.max(0, depth - 1);
			if (!depth) el.stage.classList.remove('is-dropping');
		});
		window.addEventListener('drop', async function (event) {
			event.preventDefault();
			depth = 0;
			el.stage.classList.remove('is-dropping');

			var files = Array.prototype.slice.call(event.dataTransfer ? event.dataTransfer.files : []);
			var entries = [];
			var skipped = 0;

			files.forEach(function (file) {
				var ext = String(file.name || '').split('.').pop().toLowerCase();
				if (Bridge.DECODABLE.indexOf(ext) === -1 || !file.path) { skipped++; return; }
				entries.push(makeEntry({ name: file.name, ext: ext, filePath: file.path, folders: [] }));
			});

			if (!entries.length) {
				toast('Nothing to add', skipped ? 'Only decodable image files can be dropped.' : 'No files were dropped.', 'warn');
				return;
			}
			setItems(state.items.concat(entries), 'drop');
			toast('Added ' + entries.length + ' image' + (entries.length === 1 ? '' : 's'), 'Ready to process.', 'success');
		});
	}

	/* ------------------------------------------------------------------ *
	 * Folder options
	 * ------------------------------------------------------------------ */

	function flattenFolders(folders, depth, out) {
		folders.forEach(function (folder) {
			out.push({ id: folder.id, label: '\u00a0\u00a0\u00a0\u00a0'.repeat(depth) + folder.name });
			if (Array.isArray(folder.children) && folder.children.length) {
				flattenFolders(folder.children, depth + 1, out);
			}
		});
		return out;
	}

	async function populateFolders() {
		var folders = await Bridge.getFolders();
		var flat = flattenFolders(folders, 0, []);
		if (!flat.length) return;

		var group = document.createElement('optgroup');
		group.label = 'Eagle folders';
		flat.forEach(function (entry) {
			var option = document.createElement('option');
			option.value = 'folder:' + entry.id;
			option.textContent = entry.label || 'Untitled folder';
			group.appendChild(option);
		});
		el.selectFolder.appendChild(group);
	}

	function resolveFolders(entry) {
		if (params.folderMode === 'root') return [];
		if (params.folderMode.indexOf('folder:') === 0) return [params.folderMode.slice(7)];
		return entry.folders || [];
	}

	/* ------------------------------------------------------------------ *
	 * Export
	 * ------------------------------------------------------------------ */

	function renderExportCanvas(entry, image, options) {
		var result = Engine.render(image, options || engineOptions(EXPORT_MAX));
		var canvas = document.createElement('canvas');
		canvas.width = result.width;
		canvas.height = result.height;
		canvas.getContext('2d').putImageData(result.imageData, 0, 0);
		return { canvas: canvas, result: result };
	}

	function updateRunButton() {
		var count = state.items.length;
		var busy = state.running;
		el.btnRun.disabled = busy || count === 0;
		el.btnExportFolder.disabled = busy || count === 0;
		el.btnReloadSelection.disabled = busy;
		el.runLabel.textContent = count > 1 ? 'Create ' + count + ' silhouettes' : 'Create silhouette';
	}

	async function run(options) {
		var opts = options || {};
		if (state.running || !state.items.length) return;

		if (!Bridge.available() && !opts.toFolder) {
			toast('Eagle is unavailable', 'Silhouettes can only be saved into a library from inside Eagle.', 'error');
			return;
		}

		if (opts.toFolder && !state.exportFolder) {
			state.exportFolder = await Bridge.chooseDirectory();
			if (!state.exportFolder) return;
		}

		state.running = true;
		updateRunButton();
		setStatus('busy', opts.toFolder ? 'Exporting PNG files' : 'Creating silhouettes', 'Starting…');

		var succeeded = 0;
		var failed = 0;
		var newIds = [];
		var started = performance.now();
		var tags = parseTags(params.tags);
		var targets = state.items.slice();

		// Reset statuses for this pass.
		targets.forEach(function (entry) { entry.status = 'idle'; entry.message = ''; entry.resultId = null; });
		refreshQueueStates();

		for (var i = 0; i < targets.length; i++) {
			var entry = targets[i];
			entry.status = 'working';
			refreshQueueStates();
			setProgress(i / targets.length);
			setStatus('busy',
				'Processing ' + (i + 1) + ' of ' + targets.length,
				entry.name);
			await nextFrame();

			try {
				var image = await ensureImage(entry);
				// Tuned per image, so a batch is not forced to share one recipe.
				var rendered = renderExportCanvas(entry, image, tunedOptions(image, EXPORT_MAX).options);
				var name = Bridge.sanitizeName(baseName(entry) + params.suffix);

				if (opts.toFolder) {
					var fullPath = await Bridge.saveCanvasToFolder(rendered.canvas, state.exportFolder, name);
					entry.message = fullPath;
				} else {
					var id = await Bridge.addCanvasToLibrary(rendered.canvas, {
						name: name,
						folders: resolveFolders(entry),
						tags: tags,
						annotation: 'Silhouette by Darkshape — ' + rendered.result.width + '×' + rendered.result.height
					});
					entry.resultId = id;
					if (id) newIds.push(id);
				}

				entry.status = 'done';
				succeeded++;

				// Release the decoded bitmap unless it is the one on screen.
				if (i !== state.activeIndex) entry.image = null;
			} catch (err) {
				entry.status = 'error';
				entry.message = (err && err.message) || String(err);
				failed++;
				Bridge.warn('failed on', entry.name, entry.message);
			}

			refreshQueueStates();
			setProgress((i + 1) / targets.length);
			await nextFrame();
		}

		var elapsed = formatDuration(performance.now() - started);

		state.generatedIds = newIds.slice();

		if (!opts.toFolder && newIds.length && params.selectAfter) {
			await Bridge.selectItems(newIds);
		}

		state.running = false;
		setProgress(null);
		updateRunButton();

		if (failed === 0) {
			var shaky = targets.filter(function (e) { return e.weak === true; });
			var note = shaky.length
				? ' · ' + shaky.length + ' could not be separated cleanly: ' +
					shaky.map(function (e) { return e.name; }).join(', ')
				: '';
			setStatus('done', 'Finished',
				succeeded + ' silhouette' + (succeeded === 1 ? '' : 's') + ' in ' + elapsed + note);
			toast(
				opts.toFolder ? 'Exported ' + succeeded + ' PNG file' + (succeeded === 1 ? '' : 's') : 'Silhouette' + (succeeded === 1 ? '' : 's') + ' created',
				opts.toFolder ? state.exportFolder : (succeeded + ' new item' + (succeeded === 1 ? '' : 's') + ' added to the library.'),
				'success'
			);
			if (shaky.length) {
				toast('Some photos had nothing to separate',
					shaky.map(function (e) { return e.name; }).join(', ') +
					' — the shape came from an arbitrary threshold. A cut-out PNG will do better.',
					'warn');
			}
			Bridge.notify('Darkshape', succeeded + ' silhouette' + (succeeded === 1 ? '' : 's') + ' created');
		} else {
			setStatus('error', 'Finished with errors',
				succeeded + ' done, ' + failed + ' failed in ' + elapsed);
			toast('Finished with errors', succeeded + ' succeeded, ' + failed + ' failed.', 'error');
		}
	}

	async function exportToFolder() {
		// Ask every time so the destination can be changed freely.
		state.exportFolder = await Bridge.chooseDirectory();
		if (!state.exportFolder) return;
		await run({ toFolder: true });
	}

	/* ------------------------------------------------------------------ *
	 * Wiring
	 * ------------------------------------------------------------------ */

	function renderAll() {
		refreshFieldVisibility();
		renderPreview();
	}

	function wireControls() {
		bindSwitch(el.swAutoTune, 'autoTune', function (on) {
			if (on && state.image) {
				applyAutoTune(state.image);
				renderPreview();
			} else if (!on) {
				el.noteAutoTune.textContent = '';
				delete el.noteAutoTune.dataset.state;
				el.weakHint.hidden = true;
			}
		});

		bindSegmented(el.segMode, 'mode', renderAll);
		bindSegmented(el.segLumSubject, 'luminanceSubject', renderAll);
		bindSegmented(el.segStyle, 'style', function () {
			refreshFieldVisibility();
			schedulePreview();
		});
		bindSegmented(el.segBackground, 'background', renderAll);

		bindRange(el.rangeTolerance, el.outTolerance, { key: 'tolerance', onChange: schedulePreview });

		bindRange(el.rangeThreshold, el.outThreshold, {
			key: 'luminanceThreshold',
			toInput: function (value) { return value === 'auto' ? 128 : value; },
			fromInput: function (value) { return Number(value); },
			format: function (value) { return value === 'auto' ? 'Auto' : String(value); },
			onChange: function () { refreshFieldVisibility(); schedulePreview(); }
		});

		el.btnAutoThreshold.addEventListener('click', function () {
			params.luminanceThreshold = 'auto';
			saveSettings();
			refreshFieldVisibility();
			schedulePreview();
		});

		el.btnTryContrast.addEventListener('click', function () {
			// Use the backdrop's own brightness to pick the subject side: a
			// light backdrop means a dark subject, and vice versa.
			var backdropL = state.preview && state.preview.diagnostics
				? state.preview.diagnostics.backdropLuminance
				: null;
			params.mode = 'luminance';
			params.luminanceThreshold = 'auto';
			params.luminanceSubject = (typeof backdropL === 'number' && backdropL < 0.5) ? 'light' : 'dark';
			saveSettings();
			applySettingsToControls();
			refreshFieldVisibility();
			renderPreview();
		});

		bindSwitch(el.swInvert, 'invert', schedulePreview);
		bindRange(el.rangeSoftness, el.outSoftness, {
			key: 'edgeSoftness',
			format: function (value) { return Number(value).toFixed(1); },
			onChange: schedulePreview
		});
		bindRange(el.rangeDespeckle, el.outDespeckle, {
			key: 'despeckle',
			toInput: function (value) { return Math.round(Number(value) / 0.005); },
			fromInput: function (value) { return Number(value) * 0.005; },
			format: function (value) { return Number(value).toFixed(2) + '%'; },
			onChange: schedulePreview
		});
		bindRange(el.rangeFillHoles, el.outFillHoles, {
			key: 'fillHoles',
			format: function (value) { return Number(value).toFixed(value % 1 ? 1 : 0) + '%'; },
			onChange: schedulePreview
		});
		bindSwitch(el.swLargest, 'keepLargest', schedulePreview);

		bindRange(el.rangeGlowContrast, el.outGlowContrast, {
			key: 'glowContrast',
			format: function (value) { return Math.round(value) + '%'; },
			onChange: schedulePreview
		});

		buildSwatches(el.swatchesFill, FILL_SWATCHES, 'fillColor', schedulePreview);
		buildSwatches(el.swatchesBackground, BACKGROUND_SWATCHES, 'backgroundColor', schedulePreview);
		buildSwatches(el.swatchesRim, RIM_SWATCHES, 'rimColor', schedulePreview);

		el.sceneGrid.addEventListener('click', function (event) {
			var tile = event.target.closest('.scene-tile');
			if (!tile) return;
			params.scene = tile.dataset.scene;
			saveSettings();
			syncSceneGrid();
			schedulePreview();
		});

		el.presetRow.addEventListener('click', function (event) {
			var button = event.target.closest('.preset');
			if (button) applyLook(button.dataset.preset);
		});

		bindSwitch(el.swRim, 'rimLight', function () {
			refreshFieldVisibility();
			schedulePreview();
		});
		bindRange(el.rangeRimIntensity, el.outRimIntensity, {
			key: 'rimIntensity',
			format: function (value) { return Math.round(value) + '%'; },
			onChange: schedulePreview
		});
		bindRange(el.rangeRimWidth, el.outRimWidth, {
			key: 'rimWidth',
			format: function (value) { return String(Math.round(value)); },
			onChange: schedulePreview
		});
		bindCompass(el.compass, 'rimDirection', schedulePreview);

		bindSwitch(el.swTrim, 'trim', function () { refreshFieldVisibility(); schedulePreview(); });
		bindRange(el.rangePadding, el.outPadding, {
			key: 'padding',
			format: function (value) { return Math.round(value) + '%'; },
			onChange: schedulePreview
		});

		el.inputSuffix.addEventListener('input', function () {
			params.suffix = el.inputSuffix.value;
			markTouched('suffix');
			saveSettings();
		});

		el.selectFolder.addEventListener('change', function () {
			params.folderMode = el.selectFolder.value;
			markTouched('folderMode');
			saveSettings();
		});

		el.inputTags.addEventListener('input', function () {
			params.tags = el.inputTags.value;
			markTouched('tags');
			saveSettings();
		});

		bindSwitch(el.swSelect, 'selectAfter');

		// The stage view control is owned by setView(), which keeps
		// `state.view` and the stage attribute in sync.

		el.btnReset.addEventListener('click', function () {
			params = Object.assign({}, DEFAULTS);
			// Nothing is the user's own choice any more, so the next default
			// change should reach them again.
			userTouched = {};
			saveSettings();
			applySettingsToControls();
			renderAll();
			toast('Settings reset', 'Every control is back to its default.', 'success');
		});

		el.btnRun.addEventListener('click', function () { run({}); });
		el.btnExportFolder.addEventListener('click', exportToFolder);
		el.btnReloadSelection.addEventListener('click', function () { loadSelectedItems(false); });
		el.btnReload.addEventListener('click', function () { loadSelectedItems(false); });
		el.btnPickFiles.addEventListener('click', pickFiles);
	}

	/** Mirrors `params` back into every control (used after a reset). */
	function applySettingsToControls() {
		// Segmented groups
		[['mode', el.segMode], ['luminanceSubject', el.segLumSubject], ['style', el.segStyle], ['background', el.segBackground]]
			.forEach(function (pair) {
				Array.prototype.forEach.call(pair[1].children, function (button) {
					button.classList.toggle('is-active', button.dataset.value === String(params[pair[0]]));
				});
			});

		// Switches
		[['invert', el.swInvert], ['keepLargest', el.swLargest], ['trim', el.swTrim],
			['rimLight', el.swRim], ['selectAfter', el.swSelect]]
			.forEach(function (pair) {
				pair[1].classList.toggle('is-on', !!params[pair[0]]);
				pair[1].setAttribute('aria-checked', params[pair[0]] ? 'true' : 'false');
			});

		// Ranges
		var ranges = [
			[el.rangeTolerance, el.outTolerance, params.tolerance, function (v) { return v; }],
			[el.rangeThreshold, el.outThreshold, params.luminanceThreshold === 'auto' ? 128 : params.luminanceThreshold, function () { return autoThresholdLabel(null); }],
			[el.rangeSoftness, el.outSoftness, params.edgeSoftness, function (v) { return Number(v).toFixed(1); }],
			[el.rangeDespeckle, el.outDespeckle, Math.round(params.despeckle / 0.005), function () { return Number(params.despeckle).toFixed(2) + '%'; }],
			[el.rangeFillHoles, el.outFillHoles, params.fillHoles, function (v) { return Number(v) + '%'; }],
			[el.rangePadding, el.outPadding, params.padding, function (v) { return Math.round(v) + '%'; }],
			[el.rangeRimIntensity, el.outRimIntensity, params.rimIntensity, function (v) { return Math.round(v) + '%'; }],
			[el.rangeRimWidth, el.outRimWidth, params.rimWidth, function (v) { return String(Math.round(v)); }],
			[el.rangeGlowContrast, el.outGlowContrast, params.glowContrast, function (v) { return Math.round(v) + '%'; }]
		];
		ranges.forEach(function (row) {
			row[0].value = row[2];
			paintRange(row[0]);
			row[1].textContent = row[3](row[2]);
		});

		el.inputSuffix.value = params.suffix;
		el.inputTags.value = params.tags;
		el.selectFolder.value = params.folderMode;
		buildSwatches(el.swatchesFill, FILL_SWATCHES, 'fillColor', schedulePreview);
		buildSwatches(el.swatchesBackground, BACKGROUND_SWATCHES, 'backgroundColor', schedulePreview);
		buildSwatches(el.swatchesRim, RIM_SWATCHES, 'rimColor', schedulePreview);
		Array.prototype.forEach.call(el.compass.children, function (button) {
			button.classList.toggle('is-active', button.dataset.dir === params.rimDirection);
		});
		syncSceneGrid();
	}

	function wireKeyboard() {
		window.addEventListener('keydown', function (event) {
			var target = event.target;
			if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) return;

			if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
				event.preventDefault();
				run({});
				return;
			}
			if (event.key === '+' || event.key === '=') { setZoom(state.zoom * 1.25); return; }
			if (event.key === '-' || event.key === '_') { setZoom(state.zoom / 1.25); return; }
			if (event.key === '0' || event.key.toLowerCase() === 'f') { setZoom(1); return; }

			if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
				event.preventDefault();
				if (state.items.length > 1) activate((state.activeIndex + 1) % state.items.length);
			}
			if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
				event.preventDefault();
				if (state.items.length > 1) activate((state.activeIndex - 1 + state.items.length) % state.items.length);
			}
		});
	}

	/* ------------------------------------------------------------------ *
	 * Boot
	 * ------------------------------------------------------------------ */

	/**
	 * Shows which build is running. Without it there is no way to tell an
	 * updated install from a stale one, which makes "it still looks the same"
	 * impossible to diagnose.
	 */
	function showVersion() {
		var manifest = Bridge.manifest();
		var version = (manifest && manifest.version) || (Engine && Engine.VERSION) || '';
		el.brandVersion.textContent = version ? 'v' + version : '';
	}

	async function showLibraryName() {
		try {
			if (!window.eagle || !eagle.library || typeof eagle.library.info !== 'function') return;
			var info = await eagle.library.info();
			var name = info && (info.name || info.library && info.library.name);
			if (name) el.libraryName.textContent = name;
		} catch (err) { /* the chip is decorative */ }
	}

	function boot() {
		applyTheme(Bridge.theme());
		Bridge.onThemeChanged(applyTheme);

		wireWindowChrome();
		wireStage();

		// Scene tiles and look presets carry rendered previews, so they must
		// exist before the controls are synchronised with the settings.
		buildSceneGrid();
		buildPresets();

		wireControls();
		wireKeyboard();

		applySettingsToControls();
		refreshFieldVisibility();
		updateRunButton();
		setItems([], 'eagle');
		showVersion();
		showLibraryName();

		Bridge.sweepTempDir();
		Bridge.onPluginCreate(function () { refreshStageSize(); });

		// Eagle fires plugin-run immediately after plugin-create, so the
		// selection is loaded from there. The fallback covers a reused
		// window that receives no run event.
		var runEventSeen = false;
		Bridge.onPluginRun(function () {
			runEventSeen = true;
			loadSelectedItems(true);
			refreshStageSize();
		});

		// Coming back to the window with a different selection picks it up.
		Bridge.onPluginShow(function () {
			reloadIfSelectionChanged();
			refreshStageSize();
		});

		populateFolders();

		if (!Bridge.available()) {
			showEmptyState(
				'Not running inside Eagle',
				'This window is a preview build. Drop image files here to try the silhouette engine, or open the plugin from Eagle to work on library items.'
			);
			setStatus('idle', 'Standalone preview', 'Drop images onto the canvas to test.');
		} else {
			showEmptyState(
				'Select images in Eagle',
				'Choose one photo for a single silhouette, or several for a batch run.'
			);
			setTimeout(function () {
				if (!runEventSeen) loadSelectedItems(true);
			}, 350);
		}
	}

	function refreshStageSize() {
		requestAnimationFrame(function () { layoutStage(); });
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}
})();


