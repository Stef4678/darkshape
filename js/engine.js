/*!
 * Darkshape — Silhouette Engine
 * ---------------------------------------------------------------
 * Converts a photograph into a clean silhouette by modelling the
 * background and cutting the subject out of it.
 *
 * Pipeline:
 *   1. source preparation   (alpha detection / downscale)
 *   2. background modelling (perceptual clustering of the border ring)
 *   3. seeded flood fill    (global tolerance + adaptive gradient growth)
 *   4. component clean-up   (despeckle, hole filling, largest-island)
 *   5. edge treatment       (separable blur + smoothstep re-threshold)
 *   6. compositing          (solid / outline, colour + background)
 *
 * Colour work happens in OKLab, which is perceptually uniform, so a
 * single tolerance value behaves consistently across hues and
 * brightness levels instead of drifting the way raw RGB distance does.
 *
 * Pure computation only — no DOM access beyond ImageData/canvas, so the
 * whole module can be unit-tested head-less.
 */
(function (global) {
	'use strict';

	/* ------------------------------------------------------------------ *
	 * Colour space
	 * ------------------------------------------------------------------ */

	var SRGB_TO_LINEAR = new Float32Array(256);
	(function buildLut() {
		for (var i = 0; i < 256; i++) {
			var c = i / 255;
			SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
		}
	})();

	/**
	 * sRGB byte triple -> OKLab. Writes into `out` to avoid allocation
	 * inside the flood fill's hot loop.
	 */
	function rgbToOklab(r, g, b, out) {
		var lr = SRGB_TO_LINEAR[r];
		var lg = SRGB_TO_LINEAR[g];
		var lb = SRGB_TO_LINEAR[b];

		var l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
		var m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
		var s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

		var l_ = Math.cbrt(l);
		var m_ = Math.cbrt(m);
		var s_ = Math.cbrt(s);

		out[0] = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
		out[1] = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
		out[2] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
		return out;
	}

	function labDistance(a0, a1, a2, b0, b1, b2) {
		var d0 = a0 - b0;
		var d1 = a1 - b1;
		var d2 = a2 - b2;
		return Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
	}

	/* ------------------------------------------------------------------ *
	 * Small helpers
	 * ------------------------------------------------------------------ */

	function clamp(v, lo, hi) {
		return v < lo ? lo : (v > hi ? hi : v);
	}

	function smoothstep(edge0, edge1, x) {
		var t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
		return t * t * (3 - 2 * t);
	}

	/** Non-linear tolerance curve: fine control at the low end. */
	function toleranceToLab(t) {
		var n = clamp(t, 0, 100) / 100;
		return 0.018 + Math.pow(n, 1.55) * 0.30;
	}

	/**
	 * Relative px radius, so preview and export agree at any resolution.
	 *
	 * The upper clamp allows up to 2% of the longest edge. It used to stop at
	 * 0.6%, which meant a small source could never be smoothed: a 280px photo
	 * topped out at 1.7px of feather no matter how far the slider was pushed,
	 * leaving every fur bump in the contour.
	 */
	function softnessToRadius(softness, maxDim) {
		return (clamp(softness, 0, 20) / 1000) * maxDim;
	}

	/* ------------------------------------------------------------------ *
	 * 1. Source preparation
	 * ------------------------------------------------------------------ */

	/**
	 * Draws an image into a reusable offscreen canvas, optionally
	 * downscaling so the longest edge is at most `maxDim`. Downscaling uses
	 * the browser's high quality resampler, which also pre-filters sensor
	 * noise. The canvas is shared between calls because the live preview
	 * re-renders on every slider tick.
	 */
	var scratchCanvas = null;

	function prepareSource(image, maxDim) {
		var w = image.naturalWidth || image.width;
		var h = image.naturalHeight || image.height;
		if (!w || !h) throw new Error('Image has no intrinsic size.');

		var scale = Math.min(1, maxDim / Math.max(w, h));
		var tw = Math.max(1, Math.round(w * scale));
		var th = Math.max(1, Math.round(h * scale));

		if (!scratchCanvas) scratchCanvas = document.createElement('canvas');
		var canvas = scratchCanvas;

		// Resizing is also how the previous frame's backing store is released
		// before a smaller one is allocated.
		if (canvas.width !== tw) canvas.width = tw;
		if (canvas.height !== th) canvas.height = th;

		var ctx = canvas.getContext('2d', { willReadFrequently: true });
		ctx.clearRect(0, 0, tw, th);
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(image, 0, 0, tw, th);

		return { imageData: ctx.getImageData(0, 0, tw, th), width: tw, height: th, canvas: canvas };
	}

	/**
	 * True when the source carries a real alpha channel (a pre-cut PNG),
	 * in which case the alpha *is* the silhouette and we can skip all
	 * background modelling.
	 */
	function hasMeaningfulAlpha(imageData) {
		var d = imageData.data;
		var total = imageData.width * imageData.height;
		var transparent = 0;
		var step = total > 400000 ? 3 : 1;
		var sampled = 0;

		for (var i = 3; i < d.length; i += 4 * step) {
			sampled++;
			if (d[i] < 250) transparent++;
		}
		return sampled > 0 && transparent / sampled > 0.02;
	}

	/* ------------------------------------------------------------------ *
	 * 2. Background modelling
	 * ------------------------------------------------------------------ */

	/**
	 * Collects the dominant colours of the border ring and returns them as
	 * a small set of OKLab cluster centroids. Quantising before clustering
	 * keeps JPEG noise from fragmenting one background into many clusters.
	 *
	 * Also reports how far the ring strays from its own model. A backdrop
	 * that varies a lot — a soft shadow, a graduated studio sweep — is the
	 * case background modelling handles worst, and the interface uses this
	 * to say so rather than leaving the user with a ragged cut.
	 */
	function buildBackgroundModel(imageData, stats) {
		var w = imageData.width;
		var h = imageData.height;
		var d = imageData.data;

		var ring = Math.max(1, Math.round(Math.min(w, h) * 0.008));
		var binsL = 26, binsA = 13, binsB = 13;
		var buckets = new Map();
		var lab = [0, 0, 0];
		var samples = 0;

		// Retain a bounded subsample of ring colours for the spread measure.
		var ringPixels = 2 * ring * w + 2 * ring * Math.max(0, h - 2 * ring);
		var stride = Math.max(1, Math.floor(ringPixels / 20000));
		var keptL = [], keptA = [], keptB = [];

		function sample(x, y) {
			var p = (y * w + x) * 4;
			if (d[p + 3] < 8) return; // fully transparent border pixel
			rgbToOklab(d[p], d[p + 1], d[p + 2], lab);
			if (samples % stride === 0) {
				keptL.push(lab[0]); keptA.push(lab[1]); keptB.push(lab[2]);
			}
			samples++;

			var kL = clamp(Math.floor((lab[0]) * binsL), 0, binsL - 1);
			var kA = clamp(Math.floor((lab[1] + 0.4) / 0.8 * binsA), 0, binsA - 1);
			var kB = clamp(Math.floor((lab[2] + 0.4) / 0.8 * binsB), 0, binsB - 1);
			var key = (kL * binsA + kA) * binsB + kB;

			var bucket = buckets.get(key);
			if (!bucket) {
				bucket = { n: 0, L: 0, a: 0, b: 0 };
				buckets.set(key, bucket);
			}
			bucket.n++;
			bucket.L += lab[0];
			bucket.a += lab[1];
			bucket.b += lab[2];
		}

		var x, y;
		for (y = 0; y < ring; y++) {
			for (x = 0; x < w; x++) { sample(x, y); sample(x, h - 1 - y); }
		}
		for (y = ring; y < h - ring; y++) {
			for (x = 0; x < ring; x++) { sample(x, y); sample(w - 1 - x, y); }
		}

		if (!samples) return [{ L: 0, a: 0, b: 0, weight: 1 }];

		var list = [];
		buckets.forEach(function (bucket) {
			list.push({
				L: bucket.L / bucket.n,
				a: bucket.a / bucket.n,
				b: bucket.b / bucket.n,
				n: bucket.n
			});
		});
		list.sort(function (p, q) { return q.n - p.n; });

		// Keep the dominant clusters, discarding background noise far below
		// the leading cluster's population.
		var minCount = samples * 0.004;
		var kept = list.filter(function (c) { return c.n >= minCount; }).slice(0, 6);
		if (!kept.length) kept = [list[0]];

		// Weight each cluster by population so gradients bias correctly.
		var sum = 0;
		kept.forEach(function (c) { sum += c.n; });
		kept.forEach(function (c) { c.weight = c.n / sum; });

		// How uneven is this backdrop? Measured as the distance from the
		// dominant backdrop colour to the furthest *other* backdrop colour
		// that still holds a real share of the border. A shadow or a studio
		// sweep becomes its own cluster, so measuring the ring against the
		// cluster set would score it as "close" — the separation between
		// clusters is what actually predicts a ragged cut.
		if (stats) {
			var dominant = kept[0];
			var spread = 0;
			for (var c = 1; c < kept.length; c++) {
				if (kept[c].weight < 0.05) continue;
				var d = labDistance(kept[c].L, kept[c].a, kept[c].b,
					dominant.L, dominant.a, dominant.b);
				if (d > spread) spread = d;
			}
			stats.backdropSpread = spread;
			// Which side of a brightness split the backdrop is on, so a
			// suggestion to switch modes can also pick the right subject side.
			stats.backdropLuminance = dominant.L;
		}

		return kept;
	}

	function distanceToModel(model, L, a, b) {
		var best = Infinity;
		for (var i = 0; i < model.length; i++) {
			var m = model[i];
			var d = labDistance(L, a, b, m.L, m.a, m.b);
			if (d < best) best = d;
		}
		return best;
	}

	/* ------------------------------------------------------------------ *
	 * 3. Seeded flood fill
	 * ------------------------------------------------------------------ */

	/**
	 * Grows the background inward from every border pixel.
	 *
	 * A pixel joins the background when either
	 *   (a) it matches the global model within `tol`, or
	 *   (b) it is nearly identical to the neighbour that reached it AND
	 *       has not drifted more than `globalBound` from the model.
	 *
	 * Rule (b) is what lets a graduated sky or a soft studio backdrop be
	 * removed in one piece, while the drift cap stops the fill from
	 * walking straight into the subject.
	 */
	function floodBackground(imageData, model, options) {
		var w = imageData.width;
		var h = imageData.height;
		var n = w * h;
		var d = imageData.data;

		var tol = toleranceToLab(options.tolerance);
		// Two different questions, two different scales.
		//
		// `tol` / `globalBound` ask "how far from the modelled backdrop may a
		// background pixel sit?" — that legitimately grows with the slider, so
		// a soft shadow or a graduated sky can be removed.
		//
		// `gradient` asks "is this step small enough to be a smooth
		// continuation?" — that must stay small and roughly constant. Scaling
		// it with the tolerance was a bug: by the time the tolerance was high
		// enough to clear a graduated backdrop, the step test was loose enough
		// to walk straight across the subject's own fur or fabric texture,
		// chewing holes in it.
		var gradient = Math.min(tol * 0.55, 0.03);
		var globalBound = tol * 2.15;

		var isBackground = new Uint8Array(n);

		// Growable FIFO of pixel indices plus their cached OKLab values.
		var capacity = Math.min(n, 1 << 16);
		var qIndex = new Int32Array(capacity);
		var qLab = new Float32Array(capacity * 3);
		var head = 0, tail = 0;
		var lab = [0, 0, 0];

		function push(index, L, a, b) {
			if (tail === capacity) {
				if (capacity >= n) return;
				var newCap = Math.min(n, capacity * 2);
				var ni = new Int32Array(newCap); ni.set(qIndex); qIndex = ni;
				var nl = new Float32Array(newCap * 3); nl.set(qLab); qLab = nl;
				capacity = newCap;
			}
			qIndex[tail] = index;
			var o = tail * 3;
			qLab[o] = L; qLab[o + 1] = a; qLab[o + 2] = b;
			tail++;
		}

		function seed(x, y) {
			var index = y * w + x;
			if (isBackground[index]) return;
			var p = index * 4;
			rgbToOklab(d[p], d[p + 1], d[p + 2], lab);
			if (distanceToModel(model, lab[0], lab[1], lab[2]) <= tol) {
				isBackground[index] = 1;
				push(index, lab[0], lab[1], lab[2]);
			}
		}

		var x, y;
		for (x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
		for (y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

		while (head < tail) {
			var index = qIndex[head];
			var o = head * 3;
			var pL = qLab[o], pA = qLab[o + 1], pB = qLab[o + 2];
			head++;

			var px = index % w;
			var py = (index - px) / w;

			for (var k = 0; k < 4; k++) {
				var nx = px + (k === 0 ? -1 : k === 1 ? 1 : 0);
				var ny = py + (k === 2 ? -1 : k === 3 ? 1 : 0);
				if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;

				var nIndex = ny * w + nx;
				if (isBackground[nIndex]) continue;

				var np = nIndex * 4;
				rgbToOklab(d[np], d[np + 1], d[np + 2], lab);
				var L = lab[0], A = lab[1], B = lab[2];
				var dModel = distanceToModel(model, L, A, B);

				var accepted = dModel <= tol;
				if (!accepted && dModel <= globalBound) {
					accepted = labDistance(L, A, B, pL, pA, pB) <= gradient;
				}
				if (accepted) {
					isBackground[nIndex] = 1;
					push(nIndex, L, A, B);
				}
			}
		}

		return isBackground;
	}

	/* ------------------------------------------------------------------ *
	 * 4. Component clean-up
	 * ------------------------------------------------------------------ */

	/**
	 * @param scratch optional Int32Array(n) reused across calls — the
	 *        traversal stack is the largest allocation in the pipeline and
	 *        this avoids paying for it twice per clean-up.
	 */
	function labelComponents(binary, w, h, scratch) {
		var n = w * h;
		var labels = new Int32Array(n);
		var stack = scratch && scratch.length >= n ? scratch : new Int32Array(n);
		var components = [];
		var current = 0;

		for (var start = 0; start < n; start++) {
			if (!binary[start] || labels[start]) continue;
			current++;
			var sp = 0;
			stack[sp++] = start;
			labels[start] = current;
			var area = 0;
			var minX = w, minY = h, maxX = -1, maxY = -1;
			var touchesBorder = false;

			while (sp > 0) {
				var index = stack[--sp];
				area++;
				var x = index % w;
				var y = (index - x) / w;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
				if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;

				if (x > 0) { var a1 = index - 1; if (binary[a1] && !labels[a1]) { labels[a1] = current; stack[sp++] = a1; } }
				if (x < w - 1) { var a2 = index + 1; if (binary[a2] && !labels[a2]) { labels[a2] = current; stack[sp++] = a2; } }
				if (y > 0) { var a3 = index - w; if (binary[a3] && !labels[a3]) { labels[a3] = current; stack[sp++] = a3; } }
				if (y < h - 1) { var a4 = index + w; if (binary[a4] && !labels[a4]) { labels[a4] = current; stack[sp++] = a4; } }
			}

			components.push({
				label: current, area: area, touchesBorder: touchesBorder,
				minX: minX, minY: minY, maxX: maxX, maxY: maxY
			});
		}

		return { labels: labels, components: components };
	}

	/**
	 * Labels the distinct objects in a subject mask.
	 *
	 * Labels are seeded from a one-pixel-eroded copy. Where a dark object
	 * merely happens to touch the subject — a door frame against a cat, a
	 * chair leg against a coat — a hairline of mid-grey pixels fuses them
	 * into a single island, which defeats both the speck filter and "largest
	 * island only". Eroding first breaks those hairlines. The labels are then
	 * grown back out through the original mask, so no boundary pixel is lost
	 * and the measured areas still describe the real shapes.
	 */
	function labelObjects(binary, w, h, scratch) {
		var n = w * h;
		var i, x, y;

		var seed = new Uint8Array(n);
		for (y = 1; y < h - 1; y++) {
			var row = y * w;
			for (x = 1; x < w - 1; x++) {
				i = row + x;
				if (binary[i] && binary[i - 1] && binary[i + 1] &&
					binary[i - w] && binary[i + w]) {
					seed[i] = 1;
				}
			}
		}

		var labelled = labelComponents(seed, w, h, scratch);
		var labels = labelled.labels;
		var stack = (scratch && scratch.length >= n) ? scratch : new Int32Array(n);
		var sp = 0;

		for (i = 0; i < n; i++) if (labels[i]) stack[sp++] = i;

		while (sp > 0) {
			var index = stack[--sp];
			var label = labels[index];
			var px = index % w;
			if (px > 0) { var a = index - 1; if (binary[a] && !labels[a]) { labels[a] = label; stack[sp++] = a; } }
			if (px < w - 1) { var b = index + 1; if (binary[b] && !labels[b]) { labels[b] = label; stack[sp++] = b; } }
			if (index >= w) { var c = index - w; if (binary[c] && !labels[c]) { labels[c] = label; stack[sp++] = c; } }
			if (index < n - w) { var d = index + w; if (binary[d] && !labels[d]) { labels[d] = label; stack[sp++] = d; } }
		}

		// Re-measure against the grown labels.
		var areas = new Int32Array(labelled.components.length + 1);
		var touches = new Uint8Array(labelled.components.length + 1);
		for (y = 0; y < h; y++) {
			var r2 = y * w;
			for (x = 0; x < w; x++) {
				var l = labels[r2 + x];
				if (!l) continue;
				areas[l]++;
				if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches[l] = 1;
			}
		}

		var components = [];
		for (i = 1; i < areas.length; i++) {
			if (!areas[i]) continue;
			components.push({ label: i, area: areas[i], touchesBorder: !!touches[i] });
		}
		return { labels: labels, components: components };
	}

	/**
	 * @param mask  Uint8ClampedArray alpha mask, modified in place
	 * @param stats optional object filled in with what the clean-up actually
	 *        did, so the interface can report it instead of leaving the user
	 *        guessing whether a control had any effect.
	 */
	function cleanUp(mask, w, h, options, stats) {
		var n = w * h;
		var binary = new Uint8Array(n);
		var scratch = new Int32Array(n);
		var i;
		for (i = 0; i < n; i++) binary[i] = mask[i] > 127 ? 1 : 0;

		var labelled = labelObjects(binary, w, h, scratch);
		var labels = labelled.labels;
		var components = labelled.components;

		if (stats) {
			stats.islands = components.length;
			stats.islandsDropped = 0;
			stats.droppedPixels = 0;
			stats.holes = 0;
			stats.holesFilled = 0;
			stats.holesFilledPixels = 0;
			stats.largestIsland = 0;
			stats.subjectPixels = 0;
			stats.largestHolePixels = 0;
			stats.dominantTouchesBorder = false;
			var dominantLabel = 0;
			for (i = 0; i < components.length; i++) {
				stats.subjectPixels += components[i].area;
				if (components[i].area > stats.largestIsland) {
					stats.largestIsland = components[i].area;
					dominantLabel = components[i].label;
				}
			}
			for (i = 0; i < components.length; i++) {
				if (components[i].label === dominantLabel) {
					stats.dominantTouchesBorder = components[i].touchesBorder;
				}
			}
		}
		if (!components.length) return;

		var subjectIslands = components;
		var minArea = Math.max(6, (options.despeckle / 100) * n);

		var largest = subjectIslands[0];
		for (i = 1; i < subjectIslands.length; i++) {
			if (subjectIslands[i].area > largest.area) largest = subjectIslands[i];
		}

		var drop = new Set();
		var droppedPixels = 0;
		for (i = 0; i < subjectIslands.length; i++) {
			var c = subjectIslands[i];
			if (options.keepLargest) {
				if (c.label !== largest.label) { drop.add(c.label); droppedPixels += c.area; }
			} else if (c.area < minArea) {
				drop.add(c.label);
				droppedPixels += c.area;
			}
		}
		if (drop.size || options.keepLargest) {
			for (i = 0; i < n; i++) {
				if (labels[i]) {
					if (drop.has(labels[i])) binary[i] = 0;
				} else if (options.keepLargest) {
					// Pixels the erosion orphaned: fragments too thin to belong
					// to any surviving object.
					binary[i] = 0;
				}
			}
		}
		if (stats) {
			stats.islandsDropped = drop.size;
			stats.droppedPixels = droppedPixels;
		}
		labels = null;
		labelled = null;

		// Hole filling: enclosed background islands that are not connected to
		// the frame. Re-labelling inverted keeps the logic in one place. The
		// pass runs even at zero so the count of enclosed gaps can be
		// reported; with fillHoles at 0 nothing is actually changed.
		var fillPercent = options.fillHoles;
		var inverted = new Uint8Array(n);
		for (i = 0; i < n; i++) inverted[i] = binary[i] ? 0 : 1;

		var holes = labelComponents(inverted, w, h, scratch);
		var holeLabels = holes.labels;
		var maxHole = (fillPercent / 100) * n;
		var fill = new Set();
		var enclosed = 0;
		var filledCount = 0;
		var filledPixels = 0;

		for (i = 0; i < holes.components.length; i++) {
			var hole = holes.components[i];
			if (hole.touchesBorder) continue;
			enclosed++;
			if (stats && hole.area > stats.largestHolePixels) stats.largestHolePixels = hole.area;
			if (fillPercent > 0 && hole.area <= maxHole) {
				fill.add(hole.label);
				filledCount++;
				filledPixels += hole.area;
			}
		}
		if (fill.size) {
			for (i = 0; i < n; i++) {
				if (holeLabels[i] && fill.has(holeLabels[i])) binary[i] = 1;
			}
		}
		if (stats) {
			stats.holes = enclosed;
			stats.holesFilled = filledCount;
			stats.holesFilledPixels = filledPixels;
		}

		for (i = 0; i < n; i++) mask[i] = binary[i] ? 255 : 0;
	}

	/* ------------------------------------------------------------------ *
	 * 5. Edge treatment
	 * ------------------------------------------------------------------ */

	/**
	 * Separable box blur over a float field, repeated to approximate a
	 * Gaussian. Ping-pongs between two buffers and never mutates the input,
	 * so it can be reused for both the alpha mask and the rim-light field.
	 */
	function blurField(field, w, h, radius, passes) {
		if (radius < 0.5) return field;

		var r = Math.max(1, Math.round(radius));
		var win = 2 * r + 1;
		var n = w * h;
		var a = new Float32Array(n);
		a.set(field);
		var b = new Float32Array(n);
		var x, y, k, sum;

		for (var pass = 0; pass < passes; pass++) {
			for (y = 0; y < h; y++) {
				var row = y * w;
				sum = 0;
				for (k = -r; k <= r; k++) sum += a[row + clamp(k, 0, w - 1)];
				for (x = 0; x < w; x++) {
					b[row + x] = sum / win;
					sum += a[row + clamp(x + r + 1, 0, w - 1)] - a[row + clamp(x - r, 0, w - 1)];
				}
			}
			for (x = 0; x < w; x++) {
				sum = 0;
				for (k = -r; k <= r; k++) sum += b[clamp(k, 0, h - 1) * w + x];
				for (y = 0; y < h; y++) {
					a[y * w + x] = sum / win;
					sum += b[clamp(y + r + 1, 0, h - 1) * w + x] - b[clamp(y - r, 0, h - 1) * w + x];
				}
			}
		}

		return a;
	}

	/** In-place blur of a 0..255 alpha mask. */
	function blurAlpha(mask, w, h, radius, passes) {
		if (radius < 0.5) return;
		var n = w * h;
		var field = new Float32Array(n);
		for (var i = 0; i < n; i++) field[i] = mask[i];
		var blurred = blurField(field, w, h, radius, passes);
		for (i = 0; i < n; i++) mask[i] = clamp(blurred[i], 0, 255);
	}

	/* ------------------------------------------------------------------ *
	 * 6. Scene backgrounds
	 * ------------------------------------------------------------------ */

	/**
	 * Procedural backdrops, each a vertical colour-stop gradient plus
	 * optional radial glows. Generating them means no bundled assets, no
	 * network, and a backdrop that stays smooth at any output size.
	 */
	var SCENES = {
		sunset: {
			label: 'Vibrant sunset',
			stops: [
				[0.00, [22, 9, 52]],
				[0.26, [92, 32, 104]],
				[0.48, [186, 52, 110]],
				[0.66, [232, 92, 74]],
				[0.82, [250, 150, 62]],
				[1.00, [255, 206, 122]]
			],
			glows: [
				{ x: 0.50, y: 0.94, radius: 0.72, color: [255, 206, 138], strength: 0.55 },
				{ x: 0.50, y: 0.88, radius: 0.22, color: [255, 246, 222], strength: 0.55 }
			]
		},
		golden: {
			label: 'Golden hour',
			stops: [
				[0.00, [42, 28, 20]],
				[0.32, [110, 66, 34]],
				[0.60, [190, 122, 60]],
				[0.82, [228, 172, 98]],
				[1.00, [246, 216, 158]]
			],
			glows: [
				{ x: 0.54, y: 0.80, radius: 0.82, color: [255, 224, 164], strength: 0.40 }
			]
		},
		deep: {
			label: 'Deep gradient',
			stops: [
				[0.00, [5, 7, 16]],
				[0.42, [15, 19, 42]],
				[0.76, [27, 36, 72]],
				[1.00, [9, 11, 24]]
			],
			glows: [
				{ x: 0.50, y: 0.64, radius: 0.95, color: [56, 78, 152], strength: 0.36 }
			]
		},
		studio: {
			label: 'Studio white',
			stops: [
				[0.00, [255, 255, 255]],
				[0.58, [250, 250, 253]],
				[1.00, [230, 232, 239]]
			],
			glows: [
				{ x: 0.50, y: 0.40, radius: 0.80, color: [255, 255, 255], strength: 0.55 }
			],
			vignette: { color: [203, 207, 220], start: 0.50, end: 1.30, strength: 0.85 }
		}
	};

	function sampleStops(stops, t) {
		if (t <= stops[0][0]) return stops[0][1];
		var last = stops[stops.length - 1];
		if (t >= last[0]) return last[1];

		for (var i = 1; i < stops.length; i++) {
			if (t <= stops[i][0]) {
				var a = stops[i - 1];
				var b = stops[i];
				var span = b[0] - a[0];
				var k = span <= 0 ? 0 : (t - a[0]) / span;
				return [
					a[1][0] + (b[1][0] - a[1][0]) * k,
					a[1][1] + (b[1][1] - a[1][1]) * k,
					a[1][2] + (b[1][2] - a[1][2]) * k
				];
			}
		}
		return last[1];
	}

	/**
	 * Builds a per-pixel sampler for a scene in output pixel space, so a
	 * backdrop always fills the final frame exactly — trimmed or not.
	 */
	function makeSceneSampler(id, width, height) {
		var scene = SCENES[id] || SCENES.deep;

		// The vertical gradient depends only on y, so precompute it.
		var lutSize = Math.max(2, Math.min(height, 2048));
		var lut = new Float32Array(lutSize * 3);
		for (var i = 0; i < lutSize; i++) {
			var c = sampleStops(scene.stops, i / (lutSize - 1));
			lut[i * 3] = c[0];
			lut[i * 3 + 1] = c[1];
			lut[i * 3 + 2] = c[2];
		}
		var lutScale = (lutSize - 1) / Math.max(1, height - 1);

		// Glow radii scale with the shorter edge, so a sun keeps its shape
		// and relative size at any resolution.
		var ref = Math.min(width, height);
		var glows = (scene.glows || []).map(function (g) {
			var r = g.radius * ref;
			return {
				px: g.x * width,
				py: g.y * height,
				invR2: 1 / Math.max(1, r * r),
				color: g.color,
				strength: g.strength
			};
		});

		var vig = scene.vignette || null;
		var halfDiag = Math.sqrt(width * width + height * height) / 2;
		var cx = width / 2;
		var cy = height / 2;

		return function (x, y, out) {
			var li = (y * lutScale) | 0;
			if (li < 0) li = 0;
			else if (li >= lutSize) li = lutSize - 1;
			var o = li * 3;
			var r = lut[o], g = lut[o + 1], b = lut[o + 2];

			for (var k = 0; k < glows.length; k++) {
				var gl = glows[k];
				var dx = x - gl.px;
				var dy = y - gl.py;
				var t = 1 - (dx * dx + dy * dy) * gl.invR2;
				if (t > 0) {
					var f = t * t * gl.strength;
					r += gl.color[0] * f;
					g += gl.color[1] * f;
					b += gl.color[2] * f;
				}
			}

			if (vig) {
				var ddx = x - cx;
				var ddy = y - cy;
				var d = Math.sqrt(ddx * ddx + ddy * ddy) / halfDiag;
				var vk = smoothstep(vig.start, vig.end, d) * vig.strength;
				if (vk > 0) {
					r += (vig.color[0] - r) * vk;
					g += (vig.color[1] - g) * vk;
					b += (vig.color[2] - b) * vk;
				}
			}

			out[0] = r > 255 ? 255 : r;
			out[1] = g > 255 ? 255 : g;
			out[2] = b > 255 ? 255 : b;
		};
	}

	/** A scene on its own — used for the picker thumbnails. */
	function renderScene(id, width, height) {
		var out = new ImageData(width, height);
		var data = out.data;
		var sample = makeSceneSampler(id, width, height);
		var rgb = [0, 0, 0];
		for (var y = 0; y < height; y++) {
			var row = y * width * 4;
			for (var x = 0; x < width; x++) {
				sample(x, y, rgb);
				var o = row + x * 4;
				data[o] = rgb[0];
				data[o + 1] = rgb[1];
				data[o + 2] = rgb[2];
				data[o + 3] = 255;
			}
		}
		return out;
	}

	/* ------------------------------------------------------------------ *
	 * 7. Rim light
	 * ------------------------------------------------------------------ */

	/** Unit vector towards the light, in image coordinates (y points down). */
	var RIM_DIRECTIONS = {
		'all': null,
		'top': [0, -1],
		'top-right': [0.7071, -0.7071],
		'right': [1, 0],
		'bottom-right': [0.7071, 0.7071],
		'bottom': [0, 1],
		'bottom-left': [-0.7071, 0.7071],
		'left': [-1, 0],
		'top-left': [-0.7071, -0.7071]
	};

	/**
	 * A halo that hugs the subject outline, brightest on the side the light
	 * comes from. Deriving it from a blurred mask makes it follow any
	 * contour without tracing paths; because the opaque subject is
	 * composited on top, only the outward half of the band survives, which
	 * reads as backlight rather than a glow over the silhouette.
	 */
	function computeRimField(mask, w, h, options) {
		var n = w * h;
		var radius = Math.max(1, (options.rimWidth / 1000) * Math.max(w, h) * 0.5);

		var field = new Float32Array(n);
		for (var i = 0; i < n; i++) field[i] = mask[i] / 255;
		var soft = blurField(field, w, h, radius, 2);

		var direction = RIM_DIRECTIONS[options.rimDirection];
		var ambient = 0.18;
		var rim = new Float32Array(n);
		var x, y;

		for (y = 0; y < h; y++) {
			for (x = 0; x < w; x++) {
				var index = y * w + x;
				var b = soft[index];
				// Peaks exactly on the 50% contour, i.e. on the subject edge.
				var edge = 4 * b * (1 - b);
				if (edge <= 0.004) continue;

				var weight = 1;
				if (direction) {
					// The gradient points into the subject, so the outward
					// normal is its negation.
					var xm = x > 0 ? x - 1 : x;
					var xp = x < w - 1 ? x + 1 : x;
					var ym = y > 0 ? y - 1 : y;
					var yp = y < h - 1 ? y + 1 : y;
					var gx = soft[y * w + xp] - soft[y * w + xm];
					var gy = soft[yp * w + x] - soft[ym * w + x];
					var len = Math.sqrt(gx * gx + gy * gy);
					if (len > 1e-6) {
						var facing = -(gx * direction[0] + gy * direction[1]) / len;
						if (facing < 0) facing = 0;
						weight = ambient + (1 - ambient) * facing;
					} else {
						weight = ambient;
					}
				}
				rim[index] = edge * weight;
			}
		}

		// Normalise so the intensity slider means brightness rather than
		// something that shifts with edge sharpness.
		var peak = 0;
		for (i = 0; i < n; i++) if (rim[i] > peak) peak = rim[i];
		if (peak > 0) {
			var scale = 1 / peak;
			for (i = 0; i < n; i++) rim[i] *= scale;
		}
		return rim;
	}

	/* ------------------------------------------------------------------ *
	 * 8. Compositing
	 * ------------------------------------------------------------------ */

	function parseColor(value) {
		if (typeof value !== 'string') return [0, 0, 0, 255];
		var hex = value.trim().replace(/^#/, '');
		if (!/^[0-9a-fA-F]+$/.test(hex)) return [0, 0, 0, 255];
		if (hex.length === 3 || hex.length === 4) {
			hex = hex.split('').map(function (c) { return c + c; }).join('');
		}
		if (hex.length !== 6 && hex.length !== 8) return [0, 0, 0, 255];
		return [
			parseInt(hex.slice(0, 2), 16),
			parseInt(hex.slice(2, 4), 16),
			parseInt(hex.slice(4, 6), 16),
			hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255
		];
	}

	function trimBounds(mask, w, h, paddingPercent) {
		var minX = w, minY = h, maxX = -1, maxY = -1;
		for (var y = 0; y < h; y++) {
			var row = y * w;
			for (var x = 0; x < w; x++) {
				if (mask[row + x] > 8) {
					if (x < minX) minX = x;
					if (x > maxX) maxX = x;
					if (y < minY) minY = y;
					if (y > maxY) maxY = y;
				}
			}
		}
		if (maxX < 0) return { x: 0, y: 0, width: w, height: h };

		var pad = Math.round((paddingPercent / 100) * Math.max(maxX - minX + 1, maxY - minY + 1));
		var x0 = clamp(minX - pad, 0, w - 1);
		var y0 = clamp(minY - pad, 0, h - 1);
		var x1 = clamp(maxX + pad, 0, w - 1);
		var y1 = clamp(maxY + pad, 0, h - 1);
		return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
	}

	/* ------------------------------------------------------------------ *
	 * Luminance thresholding (Otsu)
	 * ------------------------------------------------------------------ */

	function otsuThreshold(imageData) {
		var d = imageData.data;
		var histogram = new Uint32Array(256);
		var total = 0;
		for (var i = 0; i < d.length; i += 4) {
			if (d[i + 3] < 8) continue;
			var lum = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
			histogram[Math.min(255, lum)]++;
			total++;
		}
		if (!total) return 128;

		var sum = 0;
		for (var t = 0; t < 256; t++) sum += t * histogram[t];

		var variance = new Float64Array(256);
		var sumB = 0, wB = 0, bestVar = -1;
		for (var k = 0; k < 256; k++) {
			wB += histogram[k];
			if (!wB) { variance[k] = -1; continue; }
			var wF = total - wB;
			if (!wF) { variance[k] = -1; break; }
			sumB += k * histogram[k];
			var mB = sumB / wB;
			var mF = (sum - sumB) / wF;
			var between = wB * wF * (mB - mF) * (mB - mF);
			variance[k] = between;
			if (between > bestVar) bestVar = between;
		}
		if (bestVar <= 0) return 128;

		// Take the middle of the plateau of near-optimal levels, not its first
		// member. Where subject and backdrop are cleanly separated the
		// between-class variance is flat across the whole gap between them,
		// and returning the plateau's low edge puts the split right on the
		// boundary of what works: one nudge further and the mask collapses.
		// The middle is the honest answer, and on a real photograph — where
		// the curve has a single peak — it is the peak.
		var epsilon = bestVar * 0.999;
		var lo = -1;
		var hi = -1;
		for (k = 0; k < 256; k++) {
			if (variance[k] >= epsilon) {
				if (lo < 0) lo = k;
				hi = k;
			}
		}
		if (lo < 0) return 128;
		return Math.round((lo + hi) / 2);
	}

	/* ------------------------------------------------------------------ *
	 * Mask computation
	 * ------------------------------------------------------------------ */

	/**
	 * @param stats optional object filled in with a report of what happened,
	 *        including which mode `auto` resolved to.
	 */
	function computeMask(imageData, options, stats) {
		var w = imageData.width;
		var h = imageData.height;
		var n = w * h;
		var d = imageData.data;
		var mask = new Uint8ClampedArray(n);
		var i;

		var mode = options.mode;
		if (mode === 'auto') {
			mode = hasMeaningfulAlpha(imageData) ? 'alpha' : 'background';
		}
		if (stats) stats.mode = mode;

		if (mode === 'alpha') {
			for (i = 0; i < n; i++) mask[i] = d[i * 4 + 3];
		} else if (mode === 'luminance') {
			var threshold = options.luminanceThreshold;
			var wasAuto = (threshold === 'auto' || threshold == null);
			if (wasAuto) threshold = otsuThreshold(imageData);
			threshold = Number(threshold);
			// Report the level actually used, so the interface can show what
			// the automatic choice resolved to instead of just saying "Auto".
			if (stats) {
				stats.luminanceThreshold = threshold;
				stats.luminanceAuto = wasAuto;
			}
			var darkSubject = options.luminanceSubject !== 'light';
			for (i = 0; i < n; i++) {
				var p = i * 4;
				var alpha = d[p + 3];
				if (alpha < 8) { mask[i] = 0; continue; }
				var lum = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
				var isSubject = darkSubject ? lum <= threshold : lum > threshold;
				mask[i] = isSubject ? alpha : 0;
			}
		} else {
			var model = buildBackgroundModel(imageData, stats);
			var isBackground = floodBackground(imageData, model, options);
			for (i = 0; i < n; i++) {
				var a = d[i * 4 + 3];
				if (a < 8) { mask[i] = 0; continue; }
				mask[i] = isBackground[i] ? 0 : a;
			}
		}

		if (options.invert) {
			for (i = 0; i < n; i++) {
				var alpha2 = d[i * 4 + 3];
				if (alpha2 < 8) { mask[i] = 0; continue; }
				mask[i] = (255 - mask[i]) * (alpha2 / 255);
			}
		}

		cleanUp(mask, w, h, options, stats);

		var maxDim = Math.max(w, h);
		var radius = 0;
		if (options.edgeSoftness > 0) {
			// Scale the contour smoothing with resolution, but never drop below
			// 1px so the silhouette edge is always anti-aliased rather than
			// stair-stepped.
			radius = Math.max(1, softnessToRadius(options.edgeSoftness, maxDim));
		}
		if (options.style === 'outline') {
			// The outline is derived from the blurred edge, so it needs a
			// minimum band width to exist at all.
			radius = Math.max(radius, softnessToRadius(1.2, maxDim), 1);
		} else if (options.style === 'luminous') {
			// Luminous output keeps the blurred ramp instead of re-thresholding
			// it, so the feather *is* the glow and needs real width to read.
			radius = Math.max(radius, softnessToRadius(4, maxDim), 2);
		}
		if (radius >= 0.5) {
			if (options.style === 'outline') {
				// A band centred on the 50% contour: 4·v·(1−v) peaks at the edge.
				blurAlpha(mask, w, h, radius, 2);
				for (i = 0; i < n; i++) {
					var v = mask[i] / 255;
					mask[i] = clamp(v * (1 - v) * 4, 0, 1) * 255;
				}
			} else if (options.style === 'luminous') {
				// Keeps the blurred ramp: the feather *is* the glow.
				blurAlpha(mask, w, h, radius, 2);
			} else {
				// Two stages, because one cannot do both jobs. Blurring and
				// ramping in a single step means the radius wide enough to
				// erase fur bumps also leaves the whole edge soft and hazy.
				//
				// Stage one: a majority filter. Blur wide, then take the 50%
				// level set, which is a smooth curve. That is the contour
				// smoothing proper.
				blurAlpha(mask, w, h, radius, 2);
				for (i = 0; i < n; i++) mask[i] = mask[i] >= 128 ? 255 : 0;

				// Stage two: a small blur restores anti-aliasing without
				// softening the contour back up.
				blurAlpha(mask, w, h, 1.2, 1);
				for (i = 0; i < n; i++) {
					mask[i] = smoothstep(0.36, 0.64, mask[i] / 255) * 255;
				}
			}
		}
		if (stats) stats.edgeRadius = radius;

		return mask;
	}

	/* ------------------------------------------------------------------ *
	 * Public entry point
	 * ------------------------------------------------------------------ */

	/**
	 * Runs the full pipeline over an HTMLImageElement.
	 *
	 * @returns {{imageData: ImageData, width: number, height: number,
	 *            bounds: Object, scale: number, coverage: number}}
	 */
	function render(image, options) {
		var opts = Object.assign({
			mode: 'auto',
			tolerance: 32,
			luminanceThreshold: 'auto',
			luminanceSubject: 'dark',
			invert: false,
			despeckle: 0.03,
			fillHoles: 2,
			keepLargest: false,
			edgeSoftness: 1.4,
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
			maxDim: 4096
		}, options || {});

		var source = prepareSource(image, opts.maxDim);
		var w = source.width;
		var h = source.height;
		var imageData = source.imageData;

		var diagnostics = {};
		var mask = computeMask(imageData, opts, diagnostics);

		// The rim is derived from the finished mask, before any cropping.
		var rimStrength = clamp(opts.rimIntensity, 0, 100) / 100;
		var rim = (opts.rimLight && rimStrength > 0)
			? computeRimField(mask, w, h, opts)
			: null;
		var rimColor = parseColor(opts.rimColor);

		var bounds = { x: 0, y: 0, width: w, height: h };
		if (opts.trim) bounds = trimBounds(mask, w, h, opts.padding);

		var outW = bounds.width;
		var outH = bounds.height;
		var out = new ImageData(outW, outH);
		var outData = out.data;

		var fill = parseColor(opts.fillColor);
		var fillAlpha = fill[3] / 255;

		// Luminous output drives the subject's opacity from its own brightness,
		// so wispy edges and internal structure survive instead of being
		// flattened into one solid shape. The contrast control pushes the
		// black and white points together to blow the form out.
		var luminous = opts.style === 'luminous';
		var glowBlack = 0;
		var glowWhite = 1;
		if (luminous) {
			var contrast = clamp(opts.glowContrast, 0, 100) / 100;
			glowBlack = 0.48 * contrast;
			glowWhite = Math.max(glowBlack + 0.04, 1 - 0.48 * contrast);
		}
		var srcData = imageData.data;
		var glowRange = glowWhite - glowBlack;

		// Three layers, back to front: background, rim halo, subject.
		var isScene = opts.background === 'scene';
		var isTransparent = opts.background === 'transparent';
		var solidBackground = !isScene && !isTransparent;
		var sceneSample = isScene ? makeSceneSampler(opts.scene, outW, outH) : null;
		var bgColor = parseColor(opts.backgroundColor);
		var rgb = [0, 0, 0];

		var covered = 0;
		for (var y = 0; y < outH; y++) {
			var srcRow = (y + bounds.y) * w + bounds.x;
			var dstRow = y * outW * 4;
			for (var x = 0; x < outW; x++) {
				var index = srcRow + x;
				var alpha = mask[index];
				if (alpha > 0) covered++;

				var br, bg, bb, ba;
				if (sceneSample) {
					sceneSample(x, y, rgb);
					br = rgb[0]; bg = rgb[1]; bb = rgb[2]; ba = 1;
				} else if (solidBackground) {
					br = bgColor[0]; bg = bgColor[1]; bb = bgColor[2]; ba = bgColor[3] / 255;
				} else {
					br = 0; bg = 0; bb = 0; ba = 0;
				}

				if (rim) {
					var rimA = rim[index] * rimStrength;
					if (rimA > 0.002) {
						var rimOut = rimA + ba * (1 - rimA);
						if (rimOut > 0) {
							br = (rimColor[0] * rimA + br * ba * (1 - rimA)) / rimOut;
							bg = (rimColor[1] * rimA + bg * ba * (1 - rimA)) / rimOut;
							bb = (rimColor[2] * rimA + bb * ba * (1 - rimA)) / rimOut;
						}
						ba = rimOut;
					}
				}

				var o = dstRow + x * 4;
				var sa = (alpha / 255) * fillAlpha;

				if (luminous && sa > 0) {
					var sp = index * 4;
					var lum = (0.2126 * srcData[sp] + 0.7152 * srcData[sp + 1] + 0.0722 * srcData[sp + 2]) / 255;
					var adj = (lum - glowBlack) / glowRange;
					// Crushed pixels fall through to the background rather than
					// being skipped, so an opaque backdrop still fills them.
					if (adj <= 0) sa = 0;
					else sa *= (adj > 1 ? 1 : adj);
				}

				if (sa <= 0) {
					if (ba <= 0) continue; // stays fully transparent
					outData[o] = br;
					outData[o + 1] = bg;
					outData[o + 2] = bb;
					outData[o + 3] = ba * 255;
					continue;
				}

				var outA = sa + ba * (1 - sa);
				if (outA <= 0) continue;
				outData[o] = (fill[0] * sa + br * ba * (1 - sa)) / outA;
				outData[o + 1] = (fill[1] * sa + bg * ba * (1 - sa)) / outA;
				outData[o + 2] = (fill[2] * sa + bb * ba * (1 - sa)) / outA;
				outData[o + 3] = outA * 255;
			}
		}

		return {
			imageData: out,
			width: outW,
			height: outH,
			bounds: bounds,
			scale: w / (image.naturalWidth || image.width),
			coverage: covered / (outW * outH),
			diagnostics: diagnostics
		};
	}

	/** Renders straight into a canvas element. */
	function renderToCanvas(image, canvas, options) {
		var result = render(image, options);
		canvas.width = result.width;
		canvas.height = result.height;
		var ctx = canvas.getContext('2d');
		ctx.putImageData(result.imageData, 0, 0);
		return result;
	}

	/** The alpha mask alone, as a grayscale ImageData (used by the viewer). */
	function renderMask(image, options) {
		var opts = Object.assign({}, options, { maxDim: (options && options.maxDim) || 1024 });
		var source = prepareSource(image, opts.maxDim);
		var mask = computeMask(source.imageData, opts);
		var out = new ImageData(source.width, source.height);
		for (var i = 0; i < mask.length; i++) {
			var o = i * 4;
			out.data[o] = out.data[o + 1] = out.data[o + 2] = mask[i];
			out.data[o + 3] = 255;
		}
		return { imageData: out, width: source.width, height: source.height };
	}

	/* ------------------------------------------------------------------ *
	 * 9. Automatic tuning
	 * ------------------------------------------------------------------ */

	/** Analysis runs small: these decisions are about shape, not detail. */
	var TUNE_MAX = 256;
	var TUNE_TOLERANCE = 32;

	/**
	 * A backdrop holding two well-separated colours — a cast shadow, a
	 * graduated sweep, a wall plus a door frame — defeats background
	 * modelling: the fill can neither remove the darker part without eating
	 * the subject, nor leave it without ragged blobs. Measured on the border
	 * ring alone, before any mask exists (see `backdropSpread`). Calibrated
	 * against a reference set: an even backdrop measures about 0.05, a
	 * shadowed one about 0.12 and up.
	 */
	var UNEVEN_BACKDROP = 0.09;

	/** How far the detection level is nudged when testing a cut's stability. */
	var TUNE_NUDGE = 10;

	/**
	 * A cut that survives only at exactly one setting is not a cut.
	 *
	 * Agreement between the masks either side of a nudge, below which the
	 * boundary is taken to be arbitrary rather than following the picture.
	 * Calibrated against a reference set: cases that separate cleanly score
	 * 0.86 to 0.97, while a grey cat on grey paving — where no colour rule
	 * finds the animal at all — scores 0.68.
	 */
	var STABILITY_FLOOR = 0.8;

	/**
	 * How much of a subject must be colours the backdrop does not use.
	 *
	 * A mask that selected the *backdrop* rather than the subject is one
	 * object with a stable boundary, so it passes every shape test there is.
	 * What gives it away is that it is made of the backdrop's own colours.
	 * Below this, the cut is taken to have picked the wrong side, and the
	 * tuner is flagged even if the boundary holds still.
	 */
	var PURITY_FLOOR = 0.85;

	/** Below this the method found almost nothing and does not count. */
	var MIN_SUBJECT_COVERAGE = 0.03;

	/**
	 * How far another method must beat background modelling before it is
	 * preferred.
	 *
	 * A tie goes to background modelling, because it uses colour *and*
	 * connectivity whereas a brightness split only looks at tone and ignores
	 * whether anything is joined to the frame. On a waterfall plate both
	 * score equally well by the numbers, but background modelling keeps the
	 * whole plume and its spray while the brightness split clips the base
	 * away. Only switch when the alternative is clearly better.
	 */
	var BACKGROUND_PREFERENCE = 0.15;

	/**
	 * Fraction of a subject that is *not* any of the backdrop's colours.
	 *
	 * The test that catches a mask which selected the backdrop instead of the
	 * subject. Such a mask scores well on every shape measure — it is a single
	 * object, its boundary holds still under a nudge — but it is made of the
	 * very colours the backdrop is made of. Measured on a grey cat peering
	 * over a blue sofa against a white wall, cutting on brightness scores 0.31
	 * (the "subject" is 69% sofa) while modelling the backdrop scores 0.99.
	 */
	function subjectPurity(imageData, mask, model, tolerance) {
		var d = imageData.data;
		var lab = [0, 0, 0];
		var subject = 0;
		var foreign = 0;
		for (var i = 0; i < mask.length; i++) {
			if (mask[i] <= 127) continue;
			subject++;
			var p = i * 4;
			rgbToOklab(d[p], d[p + 1], d[p + 2], lab);
			if (distanceToModel(model, lab[0], lab[1], lab[2]) > tolerance) foreign++;
		}
		return subject ? foreign / subject : 0;
	}

	/** Intersection over union of two masks. */
	function maskIoU(a, b) {
		var inter = 0;
		var union = 0;
		for (var i = 0; i < a.length; i++) {
			var pa = a[i] > 127;
			var pb = b[i] > 127;
			if (pa && pb) inter++;
			if (pa || pb) union++;
		}
		return union ? inter / union : 1;
	}

	/**
	 * Whether a nudged pair is worth comparing at all.
	 *
	 * Where the tonal gap between subject and backdrop is wide — a flat
	 * graphic, a hard-lit product shot — a whole range of levels works
	 * equally well, and the automatic choice can land on the range's own
	 * edge. Nudging past it empties the mask, which looks like instability
	 * but is really a parameter that simply ran out of road. Only compare
	 * when both nudges still describe something.
	 */
	function usableNudge(a, b, total) {
		var ca = 0;
		var cb = 0;
		for (var i = 0; i < a.length; i++) {
			if (a[i] > 127) ca++;
			if (b[i] > 127) cb++;
		}
		function ok(c) { return c > total * 0.005 && c < total * 0.995; }
		return ok(ca) && ok(cb);
	}

	/**
	 * Runs one candidate method and measures the result.
	 *
	 * Shared by the tuner, which compares candidates against each other, and
	 * by assess(), which judges whatever settings are actually in force —
	 * including ones the user set by hand.
	 */
	function measureCandidate(imageData, model, probe, candidate, total) {
		var stats = {};
		var mask = computeMask(imageData, Object.assign({}, probe, candidate), stats);
		var coverage = (stats.subjectPixels || 0) / total;
		// Found nothing, claimed everything, or barely anything.
		if (coverage < MIN_SUBJECT_COVERAGE || coverage > 0.95) return null;

		var purity = subjectPurity(imageData, mask, model, toleranceToLab(TUNE_TOLERANCE));

		// Alpha mode takes its shape straight from the file, so there is no
		// detection level to nudge and nothing to be unstable about.
		var stability = 1;
		if (stats.mode !== 'alpha') {
			var a, b;
			if (stats.mode === 'luminance') {
				var level = typeof stats.luminanceThreshold === 'number' ? stats.luminanceThreshold : 128;
				a = computeMask(imageData, Object.assign({}, probe, candidate, {
					luminanceThreshold: Math.max(1, level - TUNE_NUDGE)
				}));
				b = computeMask(imageData, Object.assign({}, probe, candidate, {
					luminanceThreshold: Math.min(254, level + TUNE_NUDGE)
				}));
			} else {
				var t = typeof candidate.tolerance === 'number' ? candidate.tolerance : TUNE_TOLERANCE;
				a = computeMask(imageData, Object.assign({}, probe, candidate, {
					tolerance: Math.max(1, t - 10)
				}));
				b = computeMask(imageData, Object.assign({}, probe, candidate, {
					tolerance: Math.min(100, t + 10)
				}));
			}
			stability = usableNudge(a, b, total) ? maskIoU(a, b) : 1;
		}

		return {
			candidate: candidate, stats: stats, mask: mask, coverage: coverage,
			purity: purity, stability: stability, score: purity * stability
		};
	}

	/**
	 * Judges the settings actually in force, without changing them.
	 *
	 * The tuner's judgement must not disappear the moment someone takes manual
	 * control. A cut made by hand needs the same scrutiny as one made
	 * automatically — and it is precisely while hunting for a threshold that
	 * "this boundary is not following anything" is worth saying.
	 */
	function assess(image, options) {
		var opts = Object.assign({}, options || {});
		var source = prepareSource(image, TUNE_MAX);
		var imageData = source.imageData;
		var total = source.width * source.height;

		var model = buildBackgroundModel(imageData, {});
		var candidate = {
			mode: opts.mode || 'background',
			tolerance: typeof opts.tolerance === 'number' ? opts.tolerance : TUNE_TOLERANCE,
			luminanceThreshold: opts.luminanceThreshold != null ? opts.luminanceThreshold : 'auto',
			luminanceSubject: opts.luminanceSubject || 'dark'
		};

		var measured = measureCandidate(imageData, model, { invert: !!opts.invert }, candidate, total);
		if (!measured) {
			return { stability: 1, purity: 0, coverage: 0, weak: true };
		}
		return {
			stability: measured.stability,
			purity: measured.purity,
			coverage: measured.coverage,
			weak: measured.stability < STABILITY_FLOOR && measured.purity < PURITY_FLOOR
		};
	}

	/**
	 * Reads an image and derives the settings that suit it, so a batch does
	 * not have to share one recipe.
	 *
	 * Only decisions that can actually be measured are made here:
	 *
	 *   mode / subject side  from the border ring — which *is* the backdrop,
	 *                        so a light backdrop means a dark subject
	 *   keepLargest          from how the mask splits into objects
	 *   fillHoles            from the enclosed gaps actually present
	 *
	 * Edge softness is deliberately *not* set. How much to smooth is a matter
	 * of taste that measurement cannot settle: the same rule that correctly
	 * asks for a wide feather on a cat's fur asks for one on a waterfall's
	 * wisps, where it washes out the very detail that makes the picture. It
	 * is a per-*shoot* preference rather than a per-photo one, and it
	 * persists.
	 *
	 * @returns settings to merge over the caller's options, plus a short
	 *          report of what was decided.
	 */
	function autoTune(image, baseOptions) {
		var opts = Object.assign({}, baseOptions || {});
		opts.maxDim = TUNE_MAX;

		var source = prepareSource(image, TUNE_MAX);
		var w = source.width;
		var h = source.height;
		var imageData = source.imageData;
		var total = w * h;

		// The baseline mask settings: no clean-up, so the measurements below
		// describe the method itself rather than what clean-up rescued.
		var probe = {
			invert: !!opts.invert,
			despeckle: 0, fillHoles: 0, keepLargest: false,
			edgeSoftness: 0, style: 'solid',
			luminanceThreshold: 'auto', luminanceSubject: 'dark'
		};

		// Which side of a brightness split holds the subject is not a guess:
		// the border ring is the backdrop.
		var modelStats = {};
		var model = buildBackgroundModel(imageData, modelStats);
		var spread = modelStats.backdropSpread || 0;
		var backdropL = modelStats.backdropLuminance;
		var subjectSide = (typeof backdropL === 'number' && backdropL < 0.5) ? 'light' : 'dark';

		// Candidates are measured with the same routine that judges settings
		// already in force, so the two can never drift apart.
		function tryCandidate(candidate) {
			return measureCandidate(imageData, model, probe, candidate, total);
		}

		var tried = [
			tryCandidate({ mode: 'background', tolerance: TUNE_TOLERANCE }),
			tryCandidate({ mode: 'luminance', luminanceSubject: subjectSide }),
			tryCandidate({ mode: 'luminance', luminanceSubject: subjectSide === 'dark' ? 'light' : 'dark' })
		].filter(Boolean);

		tried.sort(function (a, b) { return b.score - a.score; });
		var winner = tried[0];

		// Prefer background modelling unless something clearly beats it.
		var backgroundTried = null;
		for (var ci = 0; ci < tried.length; ci++) {
			if (tried[ci].candidate.mode === 'background') { backgroundTried = tried[ci]; break; }
		}
		if (backgroundTried && winner !== backgroundTried &&
			winner.score - backgroundTried.score < BACKGROUND_PREFERENCE) {
			winner = backgroundTried;
		}

		// Nothing produced a usable mask at all: fall back to a plain, honest
		// guess and let the report say so.
		if (!winner) {
			return {
				mode: 'background',
				tolerance: TUNE_TOLERANCE,
				luminanceThreshold: 'auto',
				keepLargest: false,
				fillHoles: 5,
				report: {
					mode: 'background', subject: null,
					backdropSpread: spread, backdropLuminance: backdropL,
					share: 0, islands: 0, coverage: 0, holePercent: 0,
					purity: 0, stability: 1, candidates: 0, weak: true
				}
			};
		}

		var chosen = winner.candidate;
		var stats = winner.stats;
		var coverage = winner.coverage;
		var stability = winner.stability;
		var purity = winner.purity;
		var share = (stats.largestIsland || 0) / Math.max(1, stats.subjectPixels);
		var islands = stats.islands || 0;

		// Keep one object when there is a clear dominant one plus smaller
		// strays. Below 0.7 two objects are comparable, which usually means a
		// genuine second subject rather than clutter.
		var keepLargest = islands > 1 && share >= 0.7 && share < 0.995;

		// Close the enclosed gaps that are actually there, with headroom.
		var holePercent = ((stats.largestHolePixels || 0) / total) * 100;
		var fillHoles = holePercent > 0
			? clamp(Math.ceil(holePercent * 4) / 2, 2, 10)
			: 5;

		// Is this cut following the picture, or is it arbitrary? Nudge the
		// setting the method depends on and see whether the mask holds still.
		// Two extra passes at analysis size, which is cheap and worth it: it
		// is the only way to tell a real silhouette from a plausible-looking
		// mess, and without it a photo with no separation at all comes back
		// looking like a confident answer.
		var stability = 1;
		if (chosen.mode === 'luminance') {
			var level = typeof stats.luminanceThreshold === 'number' ? stats.luminanceThreshold : 128;
			var lowMask = computeMask(imageData, Object.assign({}, probe, chosen, {
				luminanceThreshold: Math.max(1, level - TUNE_NUDGE)
			}));
			var highMask = computeMask(imageData, Object.assign({}, probe, chosen, {
				luminanceThreshold: Math.min(254, level + TUNE_NUDGE)
			}));
			stability = usableNudge(lowMask, highMask, total)
				? maskIoU(lowMask, highMask) : 1;
		} else {
			var tol = chosen.tolerance;
			var loose = computeMask(imageData, Object.assign({}, probe, chosen, {
				tolerance: Math.max(1, tol - 10)
			}));
			var tight = computeMask(imageData, Object.assign({}, probe, chosen, {
				tolerance: Math.min(100, tol + 10)
			}));
			stability = usableNudge(loose, tight, total)
				? maskIoU(loose, tight) : 1;
		}

		var settings = {
			mode: chosen.mode,
			luminanceThreshold: 'auto',
			keepLargest: keepLargest,
			fillHoles: fillHoles,
			report: {
				mode: chosen.mode,
				subject: chosen.luminanceSubject || null,
				backdropSpread: spread,
				backdropLuminance: backdropL,
				share: share,
				islands: islands,
				coverage: coverage,
				holePercent: holePercent,
				stability: stability,
				purity: purity,
				candidates: tried.length,
				// Untrustworthy when the boundary is arbitrary *and* the object
				// it found is mostly backdrop colours. Either alone produces
				// false alarms: a small subject moves a lot under a nudge while
				// still being right, and a settled boundary can be settled on
				// the wrong side of the split.
				weak: stability < STABILITY_FLOOR && purity < PURITY_FLOOR
			}
		};
		if (chosen.mode === 'background') settings.tolerance = chosen.tolerance;
		if (chosen.luminanceSubject) settings.luminanceSubject = chosen.luminanceSubject;
		return settings;
	}


	global.DarkshapeEngine = {
		render: render,
		renderToCanvas: renderToCanvas,
		renderMask: renderMask,
		renderScene: renderScene,
		autoTune: autoTune,
		assess: assess,
		prepareSource: prepareSource,
		computeMask: computeMask,
		computeRimField: computeRimField,
		otsuThreshold: otsuThreshold,
		hasMeaningfulAlpha: hasMeaningfulAlpha,
		toleranceToLab: toleranceToLab,
		parseColor: parseColor,
		SCENES: SCENES,
		RIM_DIRECTIONS: RIM_DIRECTIONS,
		VERSION: '1.17.0'
	};
})(typeof window !== 'undefined' ? window : this);















