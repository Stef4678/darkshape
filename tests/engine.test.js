/*
 * Head-less functional tests for the Darkshape silhouette engine.
 *
 * The engine is browser code, so we supply a minimal ImageData + canvas
 * polyfill (nearest-neighbour drawImage) and drive the real pipeline over
 * synthetic images whose ground truth we know exactly.
 *
 * Run:  node tests/engine.test.js
 */
'use strict';

/* ----------------------------- DOM polyfill ----------------------------- */

class ImageDataPoly {
	constructor(a, b, c) {
		if (a instanceof Uint8ClampedArray) {
			this.data = a; this.width = b; this.height = c;
		} else {
			this.width = a; this.height = b;
			this.data = new Uint8ClampedArray(a * b * 4);
		}
	}
}
globalThis.ImageData = ImageDataPoly;

function makeCanvas() {
	const canvas = {
		width: 0,
		height: 0,
		_source: null,
		getContext() {
			const self = this;
			return {
				imageSmoothingEnabled: true,
				imageSmoothingQuality: 'high',
				clearRect() { },
				drawImage(image) {
					self._source = image._source;
				},
				getImageData(x, y, w, h) {
					const src = self._source;
					const out = new ImageDataPoly(w, h);
					for (let yy = 0; yy < h; yy++) {
						for (let xx = 0; xx < w; xx++) {
							const s = (Math.min(yy, src.height - 1) * src.width + Math.min(xx, src.width - 1)) * 4;
							const d = (yy * w + xx) * 4;
							out.data[d] = src.data[s];
							out.data[d + 1] = src.data[s + 1];
							out.data[d + 2] = src.data[s + 2];
							out.data[d + 3] = src.data[s + 3];
						}
					}
					return out;
				},
				putImageData(imageData) { self._rendered = imageData; }
			};
		}
	};
	return canvas;
}

globalThis.document = { createElement: (tag) => (tag === 'canvas' ? makeCanvas() : {}) };
globalThis.window = globalThis;

require('../js/engine.js');
const Engine = globalThis.DarkshapeEngine;

/* ------------------------------- helpers -------------------------------- */

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
	if (condition) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}${detail ? ' \u2014 ' + detail : ''}`);
	}
}

function section(title) {
	console.log(`\n${title}`);
}

function makeImage(w, h, painter) {
	const img = new ImageDataPoly(w, h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			const c = painter(x, y);
			img.data[i] = c[0];
			img.data[i + 1] = c[1];
			img.data[i + 2] = c[2];
			img.data[i + 3] = c.length > 3 ? c[3] : 255;
		}
	}
	img._source = img;
	return img;
}

/** Deterministic pseudo-random noise, so results are reproducible. */
function makeRandom(seed) {
	let state = seed >>> 0;
	return function () {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

function iou(a, b) {
	let intersection = 0, union = 0;
	for (let i = 0; i < a.length; i++) {
		const pa = a[i] > 127 ? 1 : 0;
		const pb = b[i] > 127 ? 1 : 0;
		if (pa & pb) intersection++;
		if (pa | pb) union++;
	}
	return union === 0 ? 1 : intersection / union;
}

const BASE_OPTIONS = {
	mode: 'background',
	tolerance: 32,
	invert: false,
	despeckle: 0.02,
	fillHoles: 2,
	keepLargest: false,
	edgeSoftness: 0, // keep the mask binary so IoU is meaningful
	style: 'solid'
};

/* ---------------------------- test fixtures ----------------------------- */

const W = 200, H = 150;
const CX = 100, CY = 80, RX = 45, RY = 55;

function insideEllipse(x, y) {
	const dx = (x - CX) / RX;
	const dy = (y - CY) / RY;
	return dx * dx + dy * dy <= 1;
}

function ellipseTruth(w = W, h = H) {
	const truth = new Uint8ClampedArray(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) truth[y * w + x] = insideEllipse(x, y) ? 255 : 0;
	}
	return truth;
}

/* =============================== tests ================================== */

section('1. Flat background, subject cut-out');
{
	const random = makeRandom(12345);
	const image = makeImage(W, H, (x, y) => {
		const n = Math.round((random() - 0.5) * 14);
		if (insideEllipse(x, y)) return [34 + n, 32 + n, 44 + n];
		return [232 + n, 233 + n, 236 + n];
	});
	const mask = Engine.computeMask(image, BASE_OPTIONS);
	const score = iou(mask, ellipseTruth());
	check('mask matches ground truth (IoU > 0.97)', score > 0.97, `IoU = ${score.toFixed(4)}`);
	check('centre is subject', mask[Math.round(CY) * W + CX] > 127);
	check('corner is background', mask[0] < 128);
}

section('2. Graduated background (exercises adaptive growth)');
{
	const image = makeImage(W, H, (x, y) => {
		// Sky-like vertical gradient across 200 levels of luminance.
		const t = y / (H - 1);
		const base = 150 + t * 100;
		if (insideEllipse(x, y)) return [30, 28, 36];
		return [base, base, base + 6];
	});
	const mask = Engine.computeMask(image, Object.assign({}, BASE_OPTIONS, { tolerance: 10 }));
	const score = iou(mask, ellipseTruth());
	check('gradient removed without eating the subject (IoU > 0.93)', score > 0.93, `IoU = ${score.toFixed(4)}`);
}

section('3. Alpha channel is used verbatim');
{
	const image = makeImage(W, H, (x, y) => (insideEllipse(x, y) ? [10, 10, 10, 255] : [0, 0, 0, 0]));
	const mask = Engine.computeMask(image, Object.assign({}, BASE_OPTIONS, { mode: 'alpha' }));
	check('alpha mode reproduces the ground truth exactly', iou(mask, ellipseTruth()) === 1);
	check('auto mode detects the alpha channel', iou(
		Engine.computeMask(image, Object.assign({}, BASE_OPTIONS, { mode: 'auto' })),
		ellipseTruth()
	) === 1);
}

section('4. Luminance thresholding with automatic Otsu level');
{
	const image = makeImage(W, H, (x, y) => (insideEllipse(x, y) ? [40, 40, 40] : [220, 220, 220]));
	const auto = Engine.otsuThreshold(image);
	check('Otsu level separates the two populations', auto >= 40 && auto < 220, `threshold = ${auto}`);
	const mask = Engine.computeMask(image, Object.assign({}, BASE_OPTIONS, {
		mode: 'luminance', luminanceThreshold: 'auto', luminanceSubject: 'dark'
	}));
	const score = iou(mask, ellipseTruth());
	check('dark-subject threshold matches (IoU > 0.99)', score > 0.99, `IoU = ${score.toFixed(4)}`);

	const light = Engine.computeMask(image, Object.assign({}, BASE_OPTIONS, {
		mode: 'luminance', luminanceThreshold: 'auto', luminanceSubject: 'light'
	}));
	check('light-subject threshold selects the inverse', iou(light, ellipseTruth()) < 0.02);
}

section('5. Invert');
{
	const image = makeImage(W, H, (x, y) => (insideEllipse(x, y) ? [20, 20, 20] : [240, 240, 240]));
	const normal = Engine.computeMask(image, BASE_OPTIONS);
	const inverted = Engine.computeMask(image, Object.assign({}, BASE_OPTIONS, { invert: true }));
	// The inverted mask includes the frame, so compare inside the ellipse only.
	check('inverted centre is background', inverted[Math.round(CY) * W + CX] < 128);
	check('inverted corner is subject', inverted[10 * W + 10] > 127);
	check('normal centre is subject', normal[Math.round(CY) * W + CX] > 127);
}

section('6. Despeckle and largest-island selection');
{
	const image = makeImage(W, H, (x, y) => {
		// 3x3 stray speck in the upper-left corner
		if (x >= 6 && x <= 8 && y >= 6 && y <= 8) return [30, 30, 30];
		if (insideEllipse(x, y)) return [30, 30, 30];
		return [235, 235, 235];
	});
	const kept = Engine.computeMask(image, Object.assign({}, BASE_OPTIONS, { despeckle: 0 }));
	check('speck survives when despeckle is off', kept[7 * W + 7] > 127);

	const cleaned = Engine.computeMask(image, Object.assign({}, BASE_OPTIONS, { despeckle: 0.05 }));
	check('speck removed by despeckle', cleaned[7 * W + 7] < 128);
	check('subject survives despeckle', cleaned[Math.round(CY) * W + CX] > 127);
	check('despeckled mask matches ground truth', iou(cleaned, ellipseTruth()) > 0.97);
}

section('7. Hole filling');
{
	// In background mode an enclosed region of background colour is never
	// reachable from the frame, so it stays part of the subject: silhouettes
	// are solid by construction.
	const image = makeImage(W, H, (x, y) => {
		if (!insideEllipse(x, y)) return [235, 235, 235];
		const dx = x - CX, dy = y - CY;
		if (dx * dx + dy * dy <= 12 * 12) return [235, 235, 235]; // enclosed cavity
		return [30, 30, 30];
	});
	const solid = Engine.computeMask(image, Object.assign({}, BASE_OPTIONS, { fillHoles: 0 }));
	check('enclosed cavity is solid in background mode', solid[CY * W + CX] > 127);
	check('solid result matches ground truth', iou(solid, ellipseTruth()) > 0.97);

	// With an explicit alpha channel the cavity is genuinely transparent, so
	// hole filling is what makes the shape solid again.
	const donut = makeImage(W, H, (x, y) => {
		if (!insideEllipse(x, y)) return [0, 0, 0, 0];
		const dx = x - CX, dy = y - CY;
		if (dx * dx + dy * dy <= 12 * 12) return [0, 0, 0, 0];
		return [30, 30, 30, 255];
	});
	const open = Engine.computeMask(donut, Object.assign({}, BASE_OPTIONS, { mode: 'alpha', fillHoles: 0 }));
	check('alpha cavity is preserved when filling is off', open[CY * W + CX] < 128);

	const filled = Engine.computeMask(donut, Object.assign({}, BASE_OPTIONS, { mode: 'alpha', fillHoles: 5 }));
	check('alpha cavity is filled when filling is on', filled[CY * W + CX] > 127);
	check('filled donut matches ground truth', iou(filled, ellipseTruth()) > 0.97);
}

section('8. Full render pipeline');
{
	const image = makeImage(W, H, (x, y) => (insideEllipse(x, y) ? [200, 120, 60] : [240, 240, 240]));
	image.naturalWidth = W;
	image.naturalHeight = H;

	const result = Engine.render(image, {
		mode: 'background',
		tolerance: 32,
		despeckle: 0.02,
		fillHoles: 2,
		edgeSoftness: 1.4,
		fillColor: '#000000',
		background: 'transparent',
		trim: false,
		maxDim: 4096
	});

	check('output keeps the source dimensions', result.width === W && result.height === H,
		`${result.width}x${result.height}`);
	const out = result.imageData.data;
	const centre = (CY * W + CX) * 4;
	const corner = (5 * W + 5) * 4;
	check('subject is opaque black', out[centre] === 0 && out[centre + 1] === 0 && out[centre + 2] === 0 && out[centre + 3] > 250,
		`rgba(${out[centre]},${out[centre + 1]},${out[centre + 2]},${out[centre + 3]})`);
	check('background is fully transparent', out[corner + 3] === 0, `alpha = ${out[corner + 3]}`);
	check('alpha ramp exists on the edge (anti-aliased)',
		(() => {
			for (let i = 3; i < out.length; i += 4) if (out[i] > 0 && out[i] < 255) return true;
			return false;
		})());
	check('coverage is close to the true area ratio',
		Math.abs(result.coverage - (Math.PI * RX * RY) / (W * H)) < 0.03,
		`coverage = ${result.coverage.toFixed(3)}`);
}

section('9. Solid background and custom fill colour');
{
	const image = makeImage(W, H, (x, y) => (insideEllipse(x, y) ? [20, 20, 20] : [245, 245, 245]));
	image.naturalWidth = W;
	image.naturalHeight = H;

	const result = Engine.render(image, {
		mode: 'background',
		tolerance: 32,
		despeckle: 0.02,
		fillHoles: 2,
		edgeSoftness: 0,
		fillColor: '#ff0044',
		background: 'solid',
		backgroundColor: '#ffffff',
		trim: false,
		maxDim: 4096
	});
	const out = result.imageData.data;
	const centre = (CY * W + CX) * 4;
	const corner = (5 * W + 5) * 4;
	check('fill colour applied to the subject', out[centre] === 255 && out[centre + 1] === 0 && out[centre + 2] === 68);
	check('background colour applied', out[corner] === 255 && out[corner + 1] === 255 && out[corner + 2] === 255 && out[corner + 3] === 255);
}

section('10. Trim to content bounds');
{
	const image = makeImage(W, H, (x, y) => (insideEllipse(x, y) ? [20, 20, 20] : [245, 245, 245]));
	image.naturalWidth = W;
	image.naturalHeight = H;

	const result = Engine.render(image, {
		mode: 'background',
		tolerance: 32,
		despeckle: 0.02,
		fillHoles: 2,
		edgeSoftness: 0,
		fillColor: '#000000',
		background: 'transparent',
		trim: true,
		padding: 0,
		maxDim: 4096
	});
	check('trimmed width matches the ellipse bounding box', Math.abs(result.width - (2 * RX + 1)) <= 2,
		`width = ${result.width}, expected ~${2 * RX + 1}`);
	check('trimmed height matches the ellipse bounding box', Math.abs(result.height - (2 * RY + 1)) <= 2,
		`height = ${result.height}, expected ~${2 * RY + 1}`);
}

section('11. Colour parsing');
{
	check('#000 -> black', JSON.stringify(Engine.parseColor('#000')) === JSON.stringify([0, 0, 0, 255]));
	check('#ff0044 -> rgb', JSON.stringify(Engine.parseColor('#ff0044')) === JSON.stringify([255, 0, 68, 255]));
	check('8-digit hex carries alpha', Engine.parseColor('#11223380')[3] === 128);
	check('garbage falls back to opaque black', JSON.stringify(Engine.parseColor('nonsense')) === JSON.stringify([0, 0, 0, 255]));
}

section('12. Tolerance mapping is monotonic and bounded');
{
	const lo = Engine.toleranceToLab(0);
	const mid = Engine.toleranceToLab(50);
	const hi = Engine.toleranceToLab(100);
	check('increases with the slider', lo < mid && mid < hi, `${lo.toFixed(3)} < ${mid.toFixed(3)} < ${hi.toFixed(3)}`);
	check('stays within a sane OKLab range', lo > 0 && hi < 0.4);
}

/* ------------------------------ new features ---------------------------- */

function luminance(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

function pixelAt(result, x, y) {
	const i = (y * result.width + x) * 4;
	const d = result.imageData.data;
	return { r: d[i], g: d[i + 1], b: d[i + 2], a: d[i + 3], lum: luminance(d[i], d[i + 1], d[i + 2]) };
}

/** A flat-backdrop subject used by the scene and rim tests. */
function sceneSubject() {
	const image = makeImage(W, H, (x, y) => (insideEllipse(x, y) ? [30, 28, 38] : [238, 238, 241]));
	image.naturalWidth = W;
	image.naturalHeight = H;
	return image;
}

function renderWith(overrides) {
	return Engine.render(sceneSubject(), Object.assign({
		mode: 'background',
		tolerance: 32,
		despeckle: 0.02,
		fillHoles: 2,
		edgeSoftness: 0,
		fillColor: '#000000',
		background: 'scene',
		scene: 'sunset',
		trim: false,
		maxDim: 4096
	}, overrides));
}

section('13. Procedural scene backgrounds');
{
	const ids = Object.keys(Engine.SCENES);
	check('four scenes are available', ids.length === 4, ids.join(', '));
	check('every scene has a label and colour stops',
		ids.every((id) => Engine.SCENES[id].label && Engine.SCENES[id].stops.length >= 3));

	ids.forEach((id) => {
		const scene = Engine.renderScene(id, 120, 80);
		let opaque = true;
		for (let i = 3; i < scene.data.length; i += 4) if (scene.data[i] !== 255) { opaque = false; break; }
		check(`scene "${id}" renders fully opaque at the requested size`,
			scene.width === 120 && scene.height === 80 && opaque);
	});

	const sunset = Engine.renderScene('sunset', 120, 80);
	const top = luminance(sunset.data[0], sunset.data[1], sunset.data[2]);
	const bottomIndex = (79 * 120 + 60) * 4;
	const bottom = luminance(sunset.data[bottomIndex], sunset.data[bottomIndex + 1], sunset.data[bottomIndex + 2]);
	check('sunset brightens towards the horizon', bottom > top + 40, `top=${top.toFixed(0)} bottom=${bottom.toFixed(0)}`);

	const studio = Engine.renderScene('studio', 120, 80);
	let studioMin = 255;
	for (let i = 0; i < studio.data.length; i += 4) {
		studioMin = Math.min(studioMin, studio.data[i], studio.data[i + 1], studio.data[i + 2]);
	}
	check('studio white stays bright to the edges', studioMin > 180, `darkest channel = ${studioMin}`);

	const deep = Engine.renderScene('deep', 120, 80);
	let deepMax = 0;
	for (let i = 0; i < deep.data.length; i += 4) {
		deepMax = Math.max(deepMax, deep.data[i], deep.data[i + 1], deep.data[i + 2]);
	}
	check('deep gradient stays dark overall', deepMax < 130, `brightest channel = ${deepMax}`);

	const corners = ids.map((id) => {
		const s = Engine.renderScene(id, 8, 8);
		return s.data[0] + ',' + s.data[1] + ',' + s.data[2];
	});
	check('the scenes are visually distinct', new Set(corners).size === ids.length, corners.join(' | '));
}

section('14. Scene composited behind a solid silhouette');
{
	const result = renderWith({ scene: 'sunset' });

	check('every output pixel is opaque with a scene',
		(() => {
			for (let i = 3; i < result.imageData.data.length; i += 4) if (result.imageData.data[i] !== 255) return false;
			return true;
		})());

	const centre = pixelAt(result, CX, CY);
	const corner = pixelAt(result, 5, 5);
	check('subject stays pitch black', centre.r === 0 && centre.g === 0 && centre.b === 0,
		`rgb(${centre.r},${centre.g},${centre.b})`);
	check('backdrop is the generated scene, not black', corner.lum > 5,
		`rgb(${corner.r},${corner.g},${corner.b})`);
	check('contrast between silhouette and backdrop is extreme', centre.lum === 0 && corner.lum > 5);
}

section('15. Studio white delivers maximum separation');
{
	const result = renderWith({ scene: 'studio' });
	const centre = pixelAt(result, CX, CY);
	const nearEdge = pixelAt(result, 5, 5);
	check('silhouette is pure black', centre.lum === 0);
	check('backdrop is near white', nearEdge.lum > 200, `luminance = ${nearEdge.lum.toFixed(0)}`);
	check('separation exceeds 200 levels of luminance', nearEdge.lum - centre.lum > 200);
}

section('16. Rim light');
{
	const off = renderWith({ scene: 'deep', rimLight: false });
	const on = renderWith({ scene: 'deep', rimLight: true, rimIntensity: 90, rimWidth: 40, rimDirection: 'all' });

	// Just outside the ellipse's right edge (centre 100,80; rx 45).
	const probeX = 149, probeY = CY;
	const before = pixelAt(off, probeX, probeY).lum;
	const after = pixelAt(on, probeX, probeY).lum;
	check('halo brightens the backdrop next to the edge', after > before + 8,
		`${before.toFixed(0)} -> ${after.toFixed(0)}`);

	const far = pixelAt(on, 4, 4).lum;
	check('halo fades away from the subject', after > far + 8, `edge=${after.toFixed(0)} corner=${far.toFixed(0)}`);

	const centre = pixelAt(on, CX, CY);
	check('silhouette stays solid pitch black under the rim',
		centre.r === 0 && centre.g === 0 && centre.b === 0 && centre.a === 255,
		`rgba(${centre.r},${centre.g},${centre.b},${centre.a})`);
}

section('17. Rim direction is one sided');
{
	const base = { scene: 'deep', rimLight: true, rimIntensity: 90, rimWidth: 40 };
	// Mirror probe points through the shape's centre, which is not the
	// image centre: the ellipse sits at (CX, CY) in a W x H frame.
	const mirrorX = (x) => 2 * CX - x;
	const mirrorY = (y) => 2 * CY - y;

	const lit = renderWith(Object.assign({}, base, { rimDirection: 'top' }));
	const above = pixelAt(lit, CX, 21).lum;
	const below = pixelAt(lit, CX, mirrorY(21)).lum;
	check('light from above brightens the top rim', above > below * 1.4,
		`top=${above.toFixed(0)} bottom=${below.toFixed(0)}`);

	const litRight = renderWith(Object.assign({}, base, { rimDirection: 'right' }));
	const right = pixelAt(litRight, 149, CY).lum;
	const left = pixelAt(litRight, mirrorX(149), CY).lum;
	check('light from the right brightens the right rim', right > left * 1.4,
		`right=${right.toFixed(0)} left=${left.toFixed(0)}`);

	const all = renderWith(Object.assign({}, base, { rimDirection: 'all' }));
	const allRight = pixelAt(all, 149, CY).lum;
	const allLeft = pixelAt(all, mirrorX(149), CY).lum;
	check('"all around" treats both sides alike', Math.abs(allRight - allLeft) < 3,
		`right=${allRight.toFixed(0)} left=${allLeft.toFixed(0)}`);
}

section('18. Rim intensity scales the halo');
{
	const low = renderWith({ scene: 'deep', rimLight: true, rimIntensity: 20, rimWidth: 40 });
	const high = renderWith({ scene: 'deep', rimLight: true, rimIntensity: 95, rimWidth: 40 });
	const lowLum = pixelAt(low, 149, CY).lum;
	const highLum = pixelAt(high, 149, CY).lum;
	check('a higher intensity produces a brighter halo', highLum > lowLum + 10,
		`${lowLum.toFixed(0)} -> ${highLum.toFixed(0)}`);

	const zero = renderWith({ scene: 'deep', rimLight: true, rimIntensity: 0, rimWidth: 40 });
	const off = renderWith({ scene: 'deep', rimLight: false });
	check('zero intensity matches rim off',
		Math.abs(pixelAt(zero, 149, CY).lum - pixelAt(off, 149, CY).lum) < 0.5);
}

section('19. Rim light over a transparent background');
{
	const result = renderWith({
		background: 'transparent', rimLight: true, rimIntensity: 85, rimWidth: 40
	});
	const nearEdge = pixelAt(result, 150, CY);
	const far = pixelAt(result, 4, 4);
	check('halo is partially transparent near the edge',
		nearEdge.a > 10 && nearEdge.a < 250, `alpha = ${nearEdge.a}`);
	check('background stays fully transparent away from the subject', far.a === 0, `alpha = ${far.a}`);
	const centre = pixelAt(result, CX, CY);
	check('subject is still opaque black', centre.a === 255 && centre.lum === 0);
}

section('20. Existing looks are unchanged by the new pipeline');
{
	// Regression guard: the flat-colour and transparent paths must still
	// produce exactly what they did before scenes and rim light existed.
	const flat = renderWith({ background: 'color', backgroundColor: '#ffffff' });
	check('flat white backdrop', pixelAt(flat, 5, 5).r === 255 && pixelAt(flat, 5, 5).a === 255);
	check('silhouette black on flat backdrop', pixelAt(flat, CX, CY).lum === 0);

	const clear = renderWith({ background: 'transparent' });
	check('transparent backdrop stays clear', pixelAt(clear, 5, 5).a === 0);
	check('silhouette opaque on transparency', pixelAt(clear, CX, CY).a === 255);
}

/** Subject with its own internal luminance ramp, on a light backdrop. */
function luminousSource() {
	const image = makeImage(W, H, (x, y) => {
		const dx = (x - CX) / RX;
		const dy = (y - CY) / RY;
		const r = Math.sqrt(dx * dx + dy * dy);
		if (r <= 1) {
			// 255 at the core down to 60 at the rim: the subject carries its
			// own brightness structure, like a lit plume.
			const v = Math.round(255 - r * 195);
			return [v, v, v];
		}
		return [235, 235, 238];
	});
	image.naturalWidth = W;
	image.naturalHeight = H;
	return image;
}

const LUM_BASE = {
	mode: 'background', tolerance: 32, despeckle: 0.02, fillHoles: 2,
	style: 'luminous', glowContrast: 0, fillColor: '#ffffff',
	background: 'color', backgroundColor: '#000000', trim: false, maxDim: 4096
};

function midtoneShare(result) {
	const d = result.imageData.data;
	let count = 0;
	for (let i = 0; i < d.length; i += 4) {
		const l = luminance(d[i], d[i + 1], d[i + 2]);
		if (l > 24 && l < 200) count++;
	}
	return count / (result.width * result.height);
}

section('21. Luminous rendering');
{
	const linear = Engine.render(luminousSource(), LUM_BASE);
	const solid = Engine.render(luminousSource(), Object.assign({}, LUM_BASE, {
		style: 'solid', edgeSoftness: 0
	}));
	const hard = Engine.render(luminousSource(), Object.assign({}, LUM_BASE, { glowContrast: 90 }));

	const core = pixelAt(linear, CX, CY);
	const mid = pixelAt(linear, CX + 31, CY);
	const midSolid = pixelAt(solid, CX + 31, CY);

	check('the glowing core reaches pure white', core.lum > 250, core.lum.toFixed(0));
	check('internal brightness structure survives (mid-tone kept)',
		mid.lum > 40 && mid.lum < 190, `luminous=${mid.lum.toFixed(0)}`);
	check('solid mode flattens the same point to white',
		midSolid.lum > 250, midSolid.lum.toFixed(0));
	check('luminous keeps the subject darker than solid does', mid.lum < midSolid.lum - 40);
	check('raising glow contrast darkens the mid-tone',
		pixelAt(hard, CX + 31, CY).lum < mid.lum,
		`${mid.lum.toFixed(0)} -> ${pixelAt(hard, CX + 31, CY).lum.toFixed(0)}`);
	check('the core stays white at high contrast', pixelAt(hard, CX, CY).lum > 240);
	check('luminous has a far softer falloff than a hard cutout',
		midtoneShare(linear) > midtoneShare(solid) * 3,
		`luminous=${(midtoneShare(linear) * 100).toFixed(1)}% solid=${(midtoneShare(solid) * 100).toFixed(1)}%`);
}

section('22. Luminous keeps the chosen backdrop intact');
{
	// Regression: a pixel crushed to black by the glow must still receive the
	// chosen background rather than being left transparent.
	const crushed = Engine.render(luminousSource(), Object.assign({}, LUM_BASE, {
		glowContrast: 100, backgroundColor: '#ff0000'
	}));
	const pixel = pixelAt(crushed, CX + 42, CY);
	check('crushed subject pixel is still opaque', pixel.a === 255, `alpha=${pixel.a}`);
	check('crushed subject pixel shows the backdrop colour',
		pixel.r > 240 && pixel.g < 20 && pixel.b < 20,
		`rgb(${pixel.r},${pixel.g},${pixel.b})`);

	const clear = Engine.render(luminousSource(), Object.assign({}, LUM_BASE, {
		glowContrast: 100, background: 'transparent'
	}));
	check('over transparency the same pixel is clear',
		pixelAt(clear, CX + 42, CY).a === 0, `alpha=${pixelAt(clear, CX + 42, CY).a}`);
}

/** Main subject plus three 5x5 specks: 25 px each, 75 px total. */
function speckledSource() {
	const specks = [[20, 20], [30, 26], [24, 34]];
	const image = makeImage(W, H, (x, y) => {
		for (const [sx, sy] of specks) {
			if (Math.abs(x - sx) <= 2 && Math.abs(y - sy) <= 2) return [30, 30, 30];
		}
		return insideEllipse(x, y) ? [30, 30, 30] : [236, 236, 236];
	});
	image.naturalWidth = W;
	image.naturalHeight = H;
	return image;
}

/** Dark subject enclosing a light cavity: a genuine hole in contrast mode. */
function holedSource() {
	const image = makeImage(W, H, (x, y) => {
		if (!insideEllipse(x, y)) return [236, 236, 236];
		const dx = x - CX, dy = y - CY;
		if (dx * dx + dy * dy <= 14 * 14) return [236, 236, 236];
		return [30, 30, 30];
	});
	image.naturalWidth = W;
	image.naturalHeight = H;
	return image;
}

const FLAT = { style: 'solid', fillColor: '#000000', background: 'color', backgroundColor: '#ffffff' };

section('23. Refine diagnostics are reported and truthful');
{
	const off = Engine.render(speckledSource(), Object.assign({}, BASE_OPTIONS, FLAT, {
		despeckle: 0, fillHoles: 2
	}));
	const on = Engine.render(speckledSource(), Object.assign({}, BASE_OPTIONS, FLAT, {
		despeckle: 0.5, fillHoles: 2
	}));

	check('diagnostics are returned', !!off.diagnostics && !!on.diagnostics);
	check('auto mode reports the mode it resolved to',
		off.diagnostics.mode === 'background', off.diagnostics.mode);

	// The feather radius must track the control, including being zero, and
	// must scale with image size. The tiny fixture floors it at 1px, so a
	// larger source is used to prove the scaling.
	const noFeather = Engine.render(speckledSource(), Object.assign({}, BASE_OPTIONS, FLAT, { edgeSoftness: 0 }));
	const smallFeather = Engine.render(speckledSource(), Object.assign({}, BASE_OPTIONS, FLAT, { edgeSoftness: 3 }));
	check('no feather is reported when softness is zero',
		noFeather.diagnostics.edgeRadius === 0, String(noFeather.diagnostics.edgeRadius));
	check('a floor of one pixel is reported on a small image',
		smallFeather.diagnostics.edgeRadius === 1, String(smallFeather.diagnostics.edgeRadius));

	const large = makeImage(1000, 1000, (x, y) => (
		(x > 200 && x < 800 && y > 200 && y < 800) ? [30, 30, 30] : [236, 236, 236]));
	large.naturalWidth = 1000;
	large.naturalHeight = 1000;
	const largeFeather = Engine.render(large, Object.assign({}, BASE_OPTIONS, FLAT, { edgeSoftness: 3 }));
	check('the reported feather scales with image size',
		largeFeather.diagnostics.edgeRadius >= 2.5,
		String(largeFeather.diagnostics.edgeRadius));

	// Regression: the radius used to clamp at 6, so on a small image every
	// setting past that produced an identical, far too narrow feather and a
	// contour that could never be smoothed.
	const small = makeImage(280, 220, (x, y) => (
		(x > 60 && x < 220 && y > 40 && y < 180) ? [30, 30, 30] : [236, 236, 236]));
	small.naturalWidth = 280;
	small.naturalHeight = 220;
	const mid = Engine.render(small, Object.assign({}, BASE_OPTIONS, FLAT, { edgeSoftness: 12 }));
	const high = Engine.render(small, Object.assign({}, BASE_OPTIONS, FLAT, { edgeSoftness: 20 }));
	check('feather keeps growing past the old six-unit cap',
		high.diagnostics.edgeRadius > mid.diagnostics.edgeRadius + 1,
		`12 -> ${mid.diagnostics.edgeRadius.toFixed(1)}px, 20 -> ${high.diagnostics.edgeRadius.toFixed(1)}px`);

	check('four islands are found with the specks present',
		off.diagnostics.islands === 4, String(off.diagnostics.islands));
	check('nothing is dropped with despeckle off',
		off.diagnostics.islandsDropped === 0 && off.diagnostics.droppedPixels === 0,
		`${off.diagnostics.islandsDropped} / ${off.diagnostics.droppedPixels}px`);

	check('exactly the three specks are dropped with despeckle on',
		on.diagnostics.islandsDropped === 3, String(on.diagnostics.islandsDropped));
	check('the dropped pixel count matches the specks exactly',
		on.diagnostics.droppedPixels === 75, `${on.diagnostics.droppedPixels}px vs 75px`);
	check('the main subject is not dropped',
		on.diagnostics.islands - on.diagnostics.islandsDropped === 1);

	// The reported drop must be visible in the mask itself.
	const b = Engine.computeMask(speckledSource(), Object.assign({}, BASE_OPTIONS, { despeckle: 0 }));
	const a = Engine.computeMask(speckledSource(), Object.assign({}, BASE_OPTIONS, { despeckle: 0.5 }));
	let changed = 0;
	for (let i = 0; i < a.length; i++) if (b[i] !== a[i]) changed++;
	check('the reported drop is real in the mask', changed === 75, changed + ' px changed');

	check('background mode reports no enclosed gaps',
		on.diagnostics.holes === 0, String(on.diagnostics.holes));

	// Contrast mode is where an enclosed cavity genuinely exists.
	const hOff = Engine.render(holedSource(), Object.assign({}, BASE_OPTIONS, FLAT, {
		mode: 'luminance', luminanceThreshold: 128, fillHoles: 0
	}));
	const hOn = Engine.render(holedSource(), Object.assign({}, BASE_OPTIONS, FLAT, {
		mode: 'luminance', luminanceThreshold: 128, fillHoles: 10
	}));
	check('contrast mode finds the enclosed cavity',
		hOff.diagnostics.holes === 1, String(hOff.diagnostics.holes));
	check('at zero nothing is filled',
		hOff.diagnostics.holesFilled === 0, String(hOff.diagnostics.holesFilled));
	check('raising the limit fills it and says so',
		hOn.diagnostics.holesFilled === 1, String(hOn.diagnostics.holesFilled));
	check('the filled pixel count is reported',
		hOn.diagnostics.holesFilledPixels > 500,
		`${hOn.diagnostics.holesFilledPixels}px`);
	check('the fill is real in the output', hOn.coverage > hOff.coverage,
		`${hOff.coverage.toFixed(4)} -> ${hOn.coverage.toFixed(4)}`);
}

section('24. An uneven backdrop is detected');
{
	// One flat colour: the case background modelling handles well.
	const even = makeImage(W, H, (x, y) => (insideEllipse(x, y) ? [30, 30, 30] : [236, 236, 236]));
	even.naturalWidth = W;
	even.naturalHeight = H;
	const evenResult = Engine.render(even, Object.assign({}, BASE_OPTIONS, FLAT));

	// Light down one side, much darker down the other: a cast shadow.
	const uneven = makeImage(W, H, (x, y) => {
		if (insideEllipse(x, y)) return [30, 30, 30];
		const v = Math.round(150 + (x / (W - 1)) * 90);
		return [v, v, v];
	});
	uneven.naturalWidth = W;
	uneven.naturalHeight = H;
	const unevenResult = Engine.render(uneven, Object.assign({}, BASE_OPTIONS, FLAT));

	const evenSpread = evenResult.diagnostics.backdropSpread;
	const unevenSpread = unevenResult.diagnostics.backdropSpread;

	check('an even backdrop reports almost no spread',
		evenSpread < 0.05, evenSpread.toFixed(3));
	check('an uneven backdrop reports a large spread',
		unevenSpread >= 0.09, unevenSpread.toFixed(3));
	check('the two cases are clearly separated',
		unevenSpread > evenSpread * 2,
		`even=${evenSpread.toFixed(3)} uneven=${unevenSpread.toFixed(3)}`);

	check('the backdrop side is reported for an even backdrop',
		evenResult.diagnostics.backdropLuminance > 0.5,
		evenResult.diagnostics.backdropLuminance.toFixed(3));
	check('the dark subject on a light backdrop resolves the right side',
		evenResult.diagnostics.mode === 'background' &&
		evenResult.diagnostics.backdropLuminance > 0.5);

	// Contrast mode is the recommended fallback, so it must actually work here.
	const viaContrast = Engine.render(uneven, Object.assign({}, BASE_OPTIONS, FLAT, {
		mode: 'luminance', luminanceThreshold: 'auto', luminanceSubject: 'dark'
	}));
	check('contrast mode cuts the uneven-backdrop image cleanly',
		iou(viaContrast.imageData.data.length ? maskOf(viaContrast) : new Uint8ClampedArray(0),
			ellipseTruth()) > 0.95,
		'iou ' + iou(maskOf(viaContrast), ellipseTruth()).toFixed(4));
	check('contrast mode reports which mode it used',
		viaContrast.diagnostics.mode === 'luminance', viaContrast.diagnostics.mode);
}

/** Recovers a 0/255 subject mask from a rendered result. */
function maskOf(result) {
	const d = result.imageData.data;
	const out = new Uint8ClampedArray(result.width * result.height);
	for (let i = 0; i < out.length; i++) {
		out[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3 < 128 ? 255 : 0;
	}
	return out;
}

/** A subject with a separate object joined to it by a one-pixel bridge. */
function bridgedSource() {
	const image = makeImage(W, H, (x, y) => {
		if (insideEllipse(x, y)) return [30, 30, 30];
		if (x >= 160 && x <= 178 && y >= 70 && y <= 92) return [30, 30, 30];
		if (y === 80 && x > CX && x < 160) return [30, 30, 30];
		return [236, 236, 236];
	});
	image.naturalWidth = W;
	image.naturalHeight = H;
	return image;
}

section('25. Objects joined by a hairline bridge come apart');
{
	const base = Object.assign({}, BASE_OPTIONS, FLAT, {
		mode: 'luminance', luminanceThreshold: 128, luminanceSubject: 'dark',
		despeckle: 0, fillHoles: 0
	});
	const kept = Engine.render(bridgedSource(), Object.assign({}, base, { keepLargest: false }));
	const pruned = Engine.render(bridgedSource(), Object.assign({}, base, { keepLargest: true }));

	const sqX = 169, sqY = 81, bridgeX = 152;

	check('the attached object is present without largest-only',
		pixelAt(kept, sqX, sqY).lum < 100, pixelAt(kept, sqX, sqY).lum.toFixed(0));
	check('largest-only drops the attached object',
		pixelAt(pruned, sqX, sqY).lum > 200, pixelAt(pruned, sqX, sqY).lum.toFixed(0));
	check('the one-pixel bridge goes with it',
		pixelAt(pruned, bridgeX, CY).lum > 200, pixelAt(pruned, bridgeX, CY).lum.toFixed(0));
	check('the main subject survives intact',
		pixelAt(pruned, CX, CY).lum < 100, pixelAt(pruned, CX, CY).lum.toFixed(0));
	check('the two objects were reported as separate',
		pruned.diagnostics.islandsDropped >= 1 &&
		pruned.diagnostics.islands >= 2,
		`islands ${pruned.diagnostics.islands}, dropped ${pruned.diagnostics.islandsDropped}`);

	// Without the erosion the bridge would fuse them into one island and
	// largest-only would have nothing to drop.
	check('the drop is substantial rather than a stray speck',
		pruned.diagnostics.droppedPixels > 300,
		pruned.diagnostics.droppedPixels + 'px');
}

section('26. The brightness split is reported');
{
	const opts = Object.assign({}, BASE_OPTIONS, FLAT, {
		mode: 'luminance', luminanceThreshold: 'auto', luminanceSubject: 'dark'
	});
	const auto = Engine.render(speckledSource(), opts);
	const level = auto.diagnostics.luminanceThreshold;

	check('the automatic level is reported as a number',
		typeof level === 'number' && level > 0 && level < 255, String(level));
	check('it is flagged as having been chosen automatically',
		auto.diagnostics.luminanceAuto === true);

	const manual = Engine.render(speckledSource(), Object.assign({}, opts, { luminanceThreshold: 90 }));
	check('a hand-set level is reported verbatim',
		manual.diagnostics.luminanceThreshold === 90,
		String(manual.diagnostics.luminanceThreshold));
	check('a hand-set level is not flagged automatic',
		manual.diagnostics.luminanceAuto === false);

	// Background and alpha modes have no brightness split to report.
	const bg = Engine.render(speckledSource(), Object.assign({}, BASE_OPTIONS, FLAT));
	check('no split is reported for background mode',
		bg.diagnostics.luminanceThreshold === undefined);
}

/** A dark subject with a light cavity, on a shadowed backdrop. */
function unevenHoledSource() {
	const image = makeImage(W, H, (x, y) => {
		const v = Math.round(150 + (x / (W - 1)) * 90);
		if (!insideEllipse(x, y)) return [v, v, v];
		const dx = x - CX, dy = y - CY;
		if (dx * dx + dy * dy <= 14 * 14) return [v, v, v];
		return [30, 30, 30];
	});
	image.naturalWidth = W;
	image.naturalHeight = H;
	return image;
}

/** A backdrop the flood fill cannot model: high-frequency colour noise. */
function noisyBackdropSource() {
	const rnd = makeRandom(777);
	const image = makeImage(W, H, (x, y) => {
		if (insideEllipse(x, y)) return [28, 28, 30];
		const v = Math.round(120 + rnd() * 120);
		return [v, v, Math.max(0, v - Math.round(rnd() * 60))];
	});
	image.naturalWidth = W;
	image.naturalHeight = H;
	return image;
}

section('27. Automatic tuning reads each image');
{
	// An even backdrop with a stray object welded on by a hairline.
	const even = Engine.autoTune(bridgedSource(), {});
	check('an even backdrop is handled by background modelling',
		even.mode === 'background', String(even.mode));
	check('the stray object is dropped automatically',
		even.keepLargest === true, String(even.keepLargest));
	check('the backdrop measurement is reported',
		typeof even.report.backdropSpread === 'number',
		String(even.report.backdropSpread));

	// The choice is measured, not assumed. What matters is that whichever
	// method wins actually finds the subject — so check the outcome against
	// ground truth rather than the name of the method.
	const unevenSource = unevenHoledSource();
	const uneven = Engine.autoTune(unevenSource, {});
	const unevenApplied = Engine.render(unevenSource, Object.assign({}, BASE_OPTIONS, FLAT, {
		mode: uneven.mode,
		luminanceSubject: uneven.luminanceSubject,
		luminanceThreshold: uneven.luminanceThreshold,
		tolerance: uneven.tolerance,
		keepLargest: uneven.keepLargest,
		fillHoles: uneven.fillHoles
	}));
	check('the method chosen for an uneven backdrop actually finds the subject',
		iou(maskOf(unevenApplied), ellipseTruth()) > 0.95,
		iou(maskOf(unevenApplied), ellipseTruth()).toFixed(4) + ' via ' + uneven.mode);

	// A backdrop the flood fill cannot follow must fall to brightness instead.
	const noisy = Engine.autoTune(noisyBackdropSource(), {});
	check('a backdrop the fill cannot model falls back to Contrast',
		noisy.mode === 'luminance', String(noisy.mode));
	check('the subject side is read from the backdrop',
		noisy.luminanceSubject === 'dark', String(noisy.luminanceSubject));

	check('the report says how many methods were tried',
		typeof uneven.report.candidates === 'number' && uneven.report.candidates >= 1,
		String(uneven.report.candidates));
	check('purity is reported', typeof uneven.report.purity === 'number',
		String(uneven.report.purity));

	// Edge softness is deliberately left alone: measurement cannot tell fur
	// noise from a wispy plume, so it stays a per-shoot preference.
	check('edge softness is not set by the tuner',
		uneven.edgeSoftness === undefined, String(uneven.edgeSoftness));
	check('a clean separation is not flagged as weak',
		even.report.weak === false, 'stability ' + even.report.stability.toFixed(3));

	// A dark but uneven backdrop must resolve to a light subject.
	const darkUneven = makeImage(W, H, (x, y) => {
		if (insideEllipse(x, y)) return [230, 230, 232];
		const v = Math.round(12 + (x / (W - 1)) * 58);
		return [v, v, v + 3];
	});
	darkUneven.naturalWidth = W;
	darkUneven.naturalHeight = H;
	const darkTune = Engine.autoTune(darkUneven, {});
	check('a dark uneven backdrop resolves to a light subject',
		darkTune.mode === 'background' || darkTune.luminanceSubject === 'light',
		darkTune.mode + ' / ' + String(darkTune.luminanceSubject));

	// The tuned settings must actually produce a mask.
	const applied = Engine.render(unevenHoledSource(), Object.assign({}, BASE_OPTIONS, FLAT, {
		mode: uneven.mode,
		luminanceSubject: uneven.luminanceSubject,
		luminanceThreshold: uneven.luminanceThreshold,
		keepLargest: uneven.keepLargest,
		fillHoles: uneven.fillHoles
	}));
	check('the tuned settings render a mask of the right shape',
		iou(maskOf(applied), ellipseTruth()) > 0.93,
		'iou ' + iou(maskOf(applied), ellipseTruth()).toFixed(4));
}

/**
 * A subject only a dozen levels from its backdrop, with more noise than
 * separation: no threshold finds the shape, so the boundary lands wherever
 * the level happens to fall. A grey cat on grey paving is the photographic
 * version of this.
 */
function mushSource() {
	const rnd = makeRandom(4242);
	const image = makeImage(W, H, (x, y) => {
		const noise = Math.round((rnd() - 0.5) * 20);
		const v = (insideEllipse(x, y) ? 120 : 132) + noise;
		return [v, v, v];
	});
	image.naturalWidth = W;
	image.naturalHeight = H;
	return image;
}

section('28. A cut that cannot be trusted is reported as such');
{
	const weak = Engine.autoTune(mushSource(), {});
	check('an untrustworthy cut is flagged',
		weak.report.weak === true, 'stability ' + weak.report.stability.toFixed(3));
	check('its instability is reported',
		weak.report.stability < 0.8, weak.report.stability.toFixed(3));

	// A clean separation at the same size must not be flagged.
	const clean = Engine.autoTune(bridgedSource(), {});
	check('a trustworthy cut is not flagged',
		clean.report.weak === false, 'stability ' + clean.report.stability.toFixed(3));
	check('the two differ by a wide margin',
		clean.report.stability - weak.report.stability > 0.1,
		`clean ${clean.report.stability.toFixed(3)} vs weak ${weak.report.stability.toFixed(3)}`);

	// A flat two-tone image has a whole range of working levels, and the
	// automatic choice can land on that range's edge. Nudging past it must
	// not be mistaken for an unstable boundary.
	const flat = makeImage(W, H, (x, y) => (insideEllipse(x, y) ? [30, 30, 30] : [200, 200, 200]));
	flat.naturalWidth = W;
	flat.naturalHeight = H;
	const flatTune = Engine.autoTune(flat, {});
	check('a wide tonal gap is not mistaken for instability',
		flatTune.report.weak === false, 'stability ' + flatTune.report.stability.toFixed(3));
}

section('29. Settings are judged whoever chose them');
{
	// The tuner's verdict used to vanish the moment someone took manual
	// control — precisely when the warning is most useful. assess() runs the
	// same measurement over whatever is actually in force.
	const mush = mushSource();
	const manual = Engine.assess(mush, {
		mode: 'luminance', luminanceThreshold: 'auto', luminanceSubject: 'dark'
	});
	check('hand-set values on an unseparable photo are still flagged',
		manual.weak === true, 'stability ' + manual.stability.toFixed(3) +
		' purity ' + manual.purity.toFixed(3));
	check('the verdict reports both measures',
		typeof manual.stability === 'number' && typeof manual.purity === 'number');
	check('the verdict reports coverage too', manual.coverage > 0,
		manual.coverage.toFixed(3));

	// The same judgement must not fire on a photo that separates cleanly.
	const clean = Engine.assess(bridgedSource(), { mode: 'background', tolerance: 32 });
	check('hand-set values on a separable photo are not flagged',
		clean.weak === false, 'stability ' + clean.stability.toFixed(3) +
		' purity ' + clean.purity.toFixed(3));

	// Alpha mode has no detection level to be unstable about.
	const cutout = makeImage(W, H, (x, y) => (insideEllipse(x, y) ? [40, 40, 40, 255] : [0, 0, 0, 0]));
	cutout.naturalWidth = W;
	cutout.naturalHeight = H;
	const alpha = Engine.assess(cutout, { mode: 'alpha' });
	check('alpha mode is treated as inherently stable',
		alpha.stability === 1, String(alpha.stability));
	check('an alpha cut-out is not flagged',
		alpha.weak === false, 'purity ' + alpha.purity.toFixed(3));
}

/* -------------------------------- summary ------------------------------- */

console.log(`\n${'-'.repeat(52)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
