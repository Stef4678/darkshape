/*
 * Head-less renderer — runs the real Darkshape engine over a PNG on disk.
 *
 *   node tools/render.js <input.png> <output.png> [options-json]
 *
 * Examples:
 *   node tools/render.js in.png out.png '{"style":"luminous","fillColor":"#ffffff","background":"color","backgroundColor":"#000000"}'
 *   node tools/render.js in.png out.png '{"background":"transparent","trim":true}'
 *
 * Eagle's renderer is Chromium, so a small canvas shim stands in for it
 * here: drawImage does a real box-filter downscale and getImageData hands
 * the pixels to the engine. Everything downstream — background modelling,
 * flood fill, clean-up, edge treatment, scenes, rim light, compositing — is
 * the shipping code.
 *
 * Also prints a short luminance summary so a render can be judged
 * numerically as well as by eye.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { PNG } = require(path.join(ROOT, '.devtools', 'node_modules', 'pngjs'));
const jpeg = require(path.join(ROOT, '.devtools', 'node_modules', 'jpeg-js'));

/* ----------------------------- canvas shim ------------------------------ */

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

/** Box-filter resample of a source rect into dw x dh. */
function resample(src, sx, sy, sw, sh, dw, dh) {
	const out = new ImageDataPoly(Math.max(1, Math.round(dw)), Math.max(1, Math.round(dh)));
	const sData = src._data;
	const sW = src._width;
	const sH = src._height;
	const scaleX = sw / out.width;
	const scaleY = sh / out.height;

	for (let y = 0; y < out.height; y++) {
		const y0 = Math.max(0, Math.floor(sy + y * scaleY));
		const y1 = Math.min(sH, Math.max(y0 + 1, Math.floor(sy + (y + 1) * scaleY)));
		for (let x = 0; x < out.width; x++) {
			const x0 = Math.max(0, Math.floor(sx + x * scaleX));
			const x1 = Math.min(sW, Math.max(x0 + 1, Math.floor(sx + (x + 1) * scaleX)));
			let r = 0, g = 0, b = 0, a = 0, n = 0;
			for (let yy = y0; yy < y1; yy++) {
				const row = yy * sW;
				for (let xx = x0; xx < x1; xx++) {
					const i = (row + xx) * 4;
					r += sData[i]; g += sData[i + 1]; b += sData[i + 2]; a += sData[i + 3];
					n++;
				}
			}
			const o = (y * out.width + x) * 4;
			if (n) {
				out.data[o] = r / n; out.data[o + 1] = g / n;
				out.data[o + 2] = b / n; out.data[o + 3] = a / n;
			}
		}
	}
	return out;
}

function makeCanvas() {
	return {
		width: 0,
		height: 0,
		__drawn: null,
		__put: null,
		getContext() {
			const canvas = this;
			return {
				imageSmoothingEnabled: true,
				imageSmoothingQuality: 'high',
				clearRect() { },
				drawImage(image) {
					const args = Array.prototype.slice.call(arguments, 1);
					let sx = 0, sy = 0, sw = image._width, sh = image._height;
					let dw, dh;
					if (args.length >= 8) {
						sx = args[0]; sy = args[1]; sw = args[2]; sh = args[3];
						dw = args[6]; dh = args[7];
					} else {
						dw = args[2]; dh = args[3];
					}
					canvas.__drawn = resample(image, sx, sy, sw, sh, dw, dh);
				},
				getImageData(x, y, w, h) {
					const drawn = canvas.__drawn;
					if (drawn && drawn.width === w && drawn.height === h) return drawn;
					return new ImageDataPoly(w, h);
				},
				putImageData(imageData) { canvas.__put = imageData; }
			};
		}
	};
}

globalThis.window = globalThis;
globalThis.ImageData = ImageDataPoly;
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? makeCanvas() : {}) };

require(path.join(ROOT, 'js', 'engine.js'));
const Engine = globalThis.DarkshapeEngine;

/* -------------------------------- helpers ------------------------------- */

/** Decodes a PNG or JPEG file into an engine-ready image object. */
function loadImage(file) {
	const buffer = fs.readFileSync(file);
	const isPng = buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47;
	const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;

	let width, height, data;
	if (isPng) {
		const png = PNG.sync.read(buffer);
		width = png.width; height = png.height; data = png.data;
	} else if (isJpeg) {
		const decoded = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
		width = decoded.width; height = decoded.height; data = decoded.data;
	} else {
		throw new Error('unsupported image format (expected PNG or JPEG): ' + file);
	}

	return {
		naturalWidth: width,
		naturalHeight: height,
		width: width,
		height: height,
		_data: new Uint8ClampedArray(data),
		_width: width,
		_height: height
	};
}

/** Composites straight-alpha RGBA over a flat colour for previewing. */
function flatten(imageData, hex) {
	const [br, bg, bb] = Engine.parseColor(hex);
	const out = new ImageDataPoly(imageData.width, imageData.height);
	const src = imageData.data;
	const dst = out.data;
	for (let i = 0; i < src.length; i += 4) {
		const a = src[i + 3] / 255;
		dst[i] = src[i] * a + br * (1 - a);
		dst[i + 1] = src[i + 1] * a + bg * (1 - a);
		dst[i + 2] = src[i + 2] * a + bb * (1 - a);
		dst[i + 3] = 255;
	}
	return out;
}

function summarise(imageData) {
	const d = imageData.data;
	const n = imageData.width * imageData.height;
	let sum = 0, max = 0, bright = 0, transparent = 0;
	const histogram = new Uint32Array(16);
	for (let i = 0; i < d.length; i += 4) {
		const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
		sum += lum;
		if (lum > max) max = lum;
		if (lum > 200) bright++;
		if (d[i + 3] < 8) transparent++;
		histogram[Math.min(15, (lum / 16) | 0)]++;
	}
	const bars = Array.from(histogram).map((v) => {
		const share = v / n;
		return share > 0.02 ? Math.round(share * 40) : 0;
	});
	return {
		mean: sum / n,
		max,
		brightShare: bright / n,
		transparentShare: transparent / n,
		histogram: bars
	};
}

/* ---------------------------------- main -------------------------------- */

/**
 * Renders a PNG on disk through the engine and writes the result.
 * Also usable as a module: `require('./render.js').renderFile(src, dst, opts)`.
 */
function renderFile(input, output, options) {
	const opts = Object.assign({}, options);
	const flattenHex = opts.__flatten;
	delete opts.__flatten;

	const image = loadImage(input);
	const started = Date.now();
	const result = Engine.render(image, opts);
	const elapsed = Date.now() - started;

	const written = flattenHex ? flatten(result.imageData, flattenHex) : result.imageData;
	if (output) {
		const png = new PNG({ width: written.width, height: written.height });
		Buffer.from(written.data.buffer, written.data.byteOffset, written.data.length).copy(png.data);
		fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
		fs.writeFileSync(output, PNG.sync.write(png));
	}

	const stats = summarise(written);
	stats.elapsed = elapsed;
	stats.width = result.width;
	stats.height = result.height;
	return { result, imageData: written, stats };
}

/** 16-bin luminance histogram, as percentages. */
function histogram(imageData) {
	const d = imageData.data;
	const n = imageData.width * imageData.height;
	const bins = new Array(16).fill(0);
	for (let i = 0; i < d.length; i += 4) {
		const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
		bins[Math.min(15, (lum / 16) | 0)]++;
	}
	return bins.map((v) => (v / n) * 100);
}

function readPng(file) {
	const png = PNG.sync.read(fs.readFileSync(file));
	return new ImageDataPoly(new Uint8ClampedArray(png.data), png.width, png.height);
}

module.exports = { renderFile, histogram, readPng, loadImage, summarise, Engine };

if (require.main === module) {
	const [input, output, optionsJson] = process.argv.slice(2);
	if (!input || !output) {
		console.log('usage: node tools/render.js <input.png> <output.png> [options-json]');
		process.exit(1);
	}

	const report = renderFile(input, output, optionsJson ? JSON.parse(optionsJson) : {});
	console.log(`rendered ${report.stats.width}x${report.stats.height} in ${report.stats.elapsed} ms`);
	console.log(`  mean luminance : ${report.stats.mean.toFixed(1)}`);
	console.log(`  max luminance  : ${report.stats.max.toFixed(0)}`);
	console.log(`  bright (>200)  : ${(report.stats.brightShare * 100).toFixed(2)}%`);
	console.log(`  transparent    : ${(report.stats.transparentShare * 100).toFixed(2)}%`);
	console.log(`  histogram      : [${report.stats.histogram.join(' ')}]`);
	console.log(`  wrote ${output}`);
}
