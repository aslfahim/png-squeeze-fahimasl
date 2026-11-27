[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/png-squeeze-01-run-20261127)

# png-squeeze-fahimasl

Adaptive per-row PNG filter selection + colour-type reduction + multi-strategy
zlib, for make.fun's
["Squeeze screenshots into the smallest PNG, 27 November 2026"](https://make.fun/bounty/png-squeeze-01-run-20261127)
bounty ($100 in USDC).

## How it works

`main.ts` (Node 22, built-ins only: `fs`, `zlib`, `path`) reads
`/input/<id>/image.png` for each of the 8 screenshots and writes the smallest
lossless PNG it can to `/output/<id>/image.png`:

1. **Decode** the input PNG to RGBA (any accepted colour type, bit depth 8).
2. **Analyse** in one pass: distinct colours, whether R=G=B everywhere
   (grey), whether alpha is all 255.
3. **Reduce the colour type**, deterministically:
   - palette (type 3 + tRNS) when there are at most 256 distinct colours,
     with the palette ordered by a greedy nearest-neighbour chain (plus a
     luminance ordering as a second candidate — the smaller output wins);
   - grey (type 0) when R=G=B and alpha is all 255;
   - grey+alpha (type 4) when R=G=B and alpha varies;
   - RGB (type 2) when alpha is all 255;
   - RGBA (type 6) only when alpha varies.
4. **Filter** each row with the filter (None / Sub / Up / Average / Paeth)
   whose filtered bytes have the smallest sum of |signed byte|.
5. **Compress** with zlib level 9 under several strategies (default /
   filtered / Huffman-only, plus RLE for small buffers) and keep the
   smallest IDAT.

Output is fully deterministic: no clock, no randomness, fixed work per image.
Runs well inside the 60 s wall for the whole set of 8.

## Run locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
