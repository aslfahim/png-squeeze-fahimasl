// png-squeeze probe (@fahimasl): adaptive per-row filter + colour-type reduction
// + multi-strategy zlib, all from scratch with Node built-ins only (fs, zlib, path).
//
// Strategy:
//  - Decode the input PNG (any accepted colour type, bit depth 8) to RGBA.
//  - Analyse the pixels: distinct colours, grey (R=G=B), alpha behaviour.
//  - Pick ONE reduced representation, deterministically:
//      palette (type 3 + tRNS) when <= 256 distinct colours, palette ordered by a
//        greedy nearest-neighbour chain so neighbouring palette entries are
//        similar colours (small filtered index deltas);
//      grey (type 0) when R=G=B and alpha is all 255;
//      grey+alpha (type 4) when R=G=B and alpha varies;
//      RGB (type 2) when alpha is all 255;
//      RGBA (type 6) only when alpha varies.
//  - Filter each row with the filter (None/Sub/Up/Average/Paeth) whose filtered
//    bytes have the smallest sum of |signed byte| (ties -> lowest filter type).
//  - Compress the filtered data with zlib level 9 under several strategies
//    (default / filtered / Huffman-only, plus RLE for small raw buffers) and
//    keep the smallest IDAT. No clock, no randomness: output is deterministic.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// ---- CRC-32 (PNG, ISO 3309) ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---- PNG chunk writer ----
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
function pngOf(chunks) {
  let size = 8;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  out.set(SIG, 0);
  let at = 8;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---- PNG decoder (to RGBA) ----
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes) {
  if (bytes.length < 8 || SIG.some((b, i) => bytes[i] !== b)) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9] };
      if (header.depth !== 8) throw new Error('bit depth != 8');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    } else {
      throw new Error('unsupported chunk ' + type);
    }
  }
  if (!header || idat.length === 0) throw new Error('missing IHDR/IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('IDAT inflates to wrong length');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else {
      throw new Error('bad filter type ' + ft);
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = palette[e * 3]; rgba[d + 1] = palette[e * 3 + 1]; rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---- Filtering: per-row minimum sum of |signed filtered byte| ----
// Filter one row of `cur` (stride samples) with filter `type` into `out`.
function filterRowInto(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    if (prev === null) { out.set(cur); return; }
    for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((a + b) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Filter a whole sample plane with per-row min-|signed| choice. Returns raw
// (filter byte + filtered row per row). Reuses five trial buffers.
function filterAdaptive(samples, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    let bestType = 0;
    let bestScore = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRowInto(t, cur, prev, bpp, trial[t]);
      const s = signedSum(trial[t]);
      if (s < bestScore) { bestScore = s; bestType = t; }
    }
    raw[y * (stride + 1)] = bestType;
    raw.set(trial[bestType], y * (stride + 1) + 1);
  }
  return raw;
}

// ---- zlib: try several strategies at level 9, keep the smallest ----
function bestDeflate(raw) {
  // RLE only helps small, repetitive buffers; skip it for big raw planes to
  // keep the 60 s wall comfortably in reach (fixed work, never clock-based).
  const strategies = raw.length <= 1500000 ? [0, 1, 2, 3] : [0, 1, 2];
  let best = null;
  for (const strategy of strategies) {
    const out = deflateSync(raw, { level: 9, strategy });
    if (best === null || out.length < best.length) best = out;
  }
  return best;
}

function buildPng(width, height, colourType, raw, extraChunks) {
  const idat = bestDeflate(raw);
  const chunks = [['IHDR', ihdrOf(width, height, colourType)]];
  for (const [t, d] of extraChunks) chunks.push([t, d]);
  chunks.push(['IDAT', new Uint8Array(idat)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks.map(([t, d]) => chunk(t, d)));
}

// ---- Palette ordering: greedy nearest-neighbour chain ----
// Start from the most frequent colour, then repeatedly append the closest
// unvisited colour (squared RGBA distance). Neighbouring palette entries are
// then similar colours, so adjacent pixels that share a colour family get
// small index deltas under the Sub filter.
function orderPaletteGreedy(colours, counts) {
  const n = colours.length;
  const used = new Uint8Array(n);
  const order = new Int32Array(n);
  let start = 0;
  for (let i = 1; i < n; i++) if (counts[i] > counts[start]) start = i;
  order[0] = start;
  used[start] = 1;
  for (let k = 1; k < n; k++) {
    const last = colours[order[k - 1]];
    const lr = last >>> 24, lg = (last >>> 16) & 255, lb = (last >>> 8) & 255, la = last & 255;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const c = colours[i];
      const dr = (c >>> 24) - lr, dg = ((c >>> 16) & 255) - lg;
      const db = ((c >>> 8) & 255) - lb, da = (c & 255) - la;
      const d = dr * dr + dg * dg + db * db + da * da;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    order[k] = bestIdx;
    used[bestIdx] = 1;
  }
  return order;
}

// Luminance order as a second candidate: cheap, and often good for gradients.
function orderPaletteLuminance(colours) {
  const idx = colours.map((_, i) => i);
  idx.sort((a, b) => {
    const ca = colours[a], cb = colours[b];
    const la = ((ca >>> 24) * 299 + ((ca >>> 16) & 255) * 587 + ((ca >>> 8) & 255) * 114) / 1000;
    const lb = ((cb >>> 24) * 299 + ((cb >>> 16) & 255) * 587 + ((cb >>> 8) & 255) * 114) / 1000;
    if (la !== lb) return la - lb;
    return ca - cb;
  });
  return Int32Array.from(idx);
}

// ---- Encode one image: analyse, reduce, filter, compress ----
function encodeImage(rgba, width, height) {
  const n = width * height;
  // Single pass: distinct colours, grey check, alpha check.
  const colourIndex = new Map();
  const colours = [];
  const counts = [];
  let isGrey = true;
  let alphaAll255 = true;
  let firstAlpha = -1;
  let over256 = false;
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    const r = rgba[d], g = rgba[d + 1], b = rgba[d + 2], a = rgba[d + 3];
    if (r !== g || g !== b) isGrey = false;
    if (a !== 255) alphaAll255 = false;
    if (firstAlpha < 0) firstAlpha = a;
    if (over256) continue;
    const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    let idx = colourIndex.get(key);
    if (idx === undefined) {
      if (colours.length >= 256) {
        // 257th distinct colour: palette is impossible; stop tracking.
        over256 = true;
        colourIndex.clear();
      } else {
        idx = colours.length;
        colourIndex.set(key, idx);
        colours.push(key);
        counts.push(1);
      }
    } else {
      counts[idx]++;
    }
  }
  const distinct = over256 ? 257 : colours.length;

  // --- Palette path (<= 256 distinct colours) ---
  if (distinct <= 256) {
    // Rebuild the index map (it was cleared only when >256, so it is intact).
    const indexOf = new Map();
    for (let i = 0; i < distinct; i++) indexOf.set(colours[i], i);
    const indices = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const d = i * 4;
      const key = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
      indices[i] = indexOf.get(key);
    }
    // Two palette orderings; keep whichever compresses smaller.
    const orders = [orderPaletteGreedy(colours, counts), orderPaletteLuminance(colours)];
    let bestPng = null;
    for (const order of orders) {
      const plte = new Uint8Array(distinct * 3);
      const trnsFull = new Uint8Array(distinct);
      const remap = new Uint8Array(distinct);
      for (let p = 0; p < distinct; p++) {
        const c = colours[order[p]];
        plte[p * 3] = c >>> 24;
        plte[p * 3 + 1] = (c >>> 16) & 255;
        plte[p * 3 + 2] = (c >>> 8) & 255;
        trnsFull[p] = c & 255;
        remap[order[p]] = p;
      }
      const samples = new Uint8Array(n);
      for (let i = 0; i < n; i++) samples[i] = remap[indices[i]];
      // tRNS: trim trailing opaque entries (decoder defaults them to 255).
      let trnsLen = distinct;
      while (trnsLen > 0 && trnsFull[trnsLen - 1] === 255) trnsLen--;
      const extra = [];
      if (trnsLen > 0) extra.push(['tRNS', trnsFull.subarray(0, trnsLen)]);
      const raw = filterAdaptive(samples, width, height, 1);
      const png = buildPng(width, height, 3, raw, [['PLTE', plte], ...extra]);
      if (bestPng === null || png.length < bestPng.length) bestPng = png;
    }
    return bestPng;
  }

  // --- Grey path ---
  if (isGrey) {
    if (alphaAll255) {
      const samples = new Uint8Array(n);
      for (let i = 0; i < n; i++) samples[i] = rgba[i * 4];
      return buildPng(width, height, 0, filterAdaptive(samples, width, height, 1), []);
    }
    const samples = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      samples[i * 2] = rgba[i * 4];
      samples[i * 2 + 1] = rgba[i * 4 + 3];
    }
    return buildPng(width, height, 4, filterAdaptive(samples, width, height, 2), []);
  }

  // --- RGB path (opaque) ---
  if (alphaAll255) {
    const samples = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      samples[i * 3] = rgba[i * 4];
      samples[i * 3 + 1] = rgba[i * 4 + 1];
      samples[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return buildPng(width, height, 2, filterAdaptive(samples, width, height, 3), []);
  }

  // --- RGBA fallback (alpha varies) ---
  return buildPng(width, height, 6, filterAdaptive(rgba, width, height, 4), []);
}

// ---- Main: /input/<id>/image.png -> /output/<id>/image.png ----
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const out = encodeImage(image.rgba, image.width, image.height);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), out);
}
