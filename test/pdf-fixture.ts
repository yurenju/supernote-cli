// Builds small PDFs shaped like Supernote Cloud's /file/pdfwithmark/to/pdf output:
// each annotated page carries a full-page Stamp whose appearance draws one image
// (RGB plus an SMask for transparency). Also decodes the PNGs the code under test writes.

import { deflateSync, inflateSync } from "node:zlib";

export interface Bitmap {
  width: number;
  height: number;
  /** width * height * 4 bytes, RGBA. */
  rgba: Uint8Array;
}

export interface FixturePage {
  /** Handwriting on this page, if any. */
  handwriting?: Bitmap;
  /** Write the Stamp's image /Length as an indirect object, as some writers do. */
  indirectLength?: boolean;
  /**
   * Write the SMask as a 1-bit CCITT Group 4 image with these bytes, as Supernote Cloud
   * does for some pages, instead of 8-bit Flate. The bytes must encode the handwriting's
   * alpha: black transparent, or opaque with `blackIs1`.
   */
  ccittMask?: { data: Uint8Array; blackIs1?: boolean };
  /** A /Decode array for the SMask, such as "[1 0]" to invert it. */
  maskDecode?: string;
}

const PAGE_W = 446.88;
const PAGE_H = 595.92;

/** A handwriting image of the given size, transparent except for the listed pixels. */
export function handwritingImage(width: number, height: number, dots: { x: number; y: number; rgba: number[] }[]): Bitmap {
  const rgba = new Uint8Array(width * height * 4);
  for (const { x, y, rgba: px } of dots) rgba.set(px, (y * width + x) * 4);
  return { width, height, rgba };
}

export function buildPdf(pages: FixturePage[]): Uint8Array {
  const objects: (string | { dict: string; data: Uint8Array })[] = [];
  const add = (obj: string | { dict: string; data: Uint8Array }) => objects.push(obj);
  const reserve = () => add("null");

  const catalog = reserve();
  const pagesId = reserve();
  const kids: number[] = [];
  for (const page of pages) {
    const content = add({ dict: "", data: new TextEncoder().encode("0 0 m\n") });
    let annots = "";
    if (page.handwriting) {
      const { width, height, rgba } = page.handwriting;
      const rgb = new Uint8Array(width * height * 3);
      const alpha = new Uint8Array(width * height);
      for (let i = 0; i < width * height; i++) {
        rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
        alpha[i] = rgba[i * 4 + 3]!;
      }
      const mask = page.ccittMask;
      const blackIs1 = mask?.blackIs1 ? "/BlackIs1 true" : "";
      const decode = page.maskDecode ? `/Decode${page.maskDecode}` : "";
      const smask = add({
        dict:
          `/Type/XObject/Subtype/Image/Width ${width}/Height ${height}/ColorSpace/DeviceGray${decode}` +
          (mask
            ? `/BitsPerComponent 1/Filter/CCITTFaxDecode/DecodeParms<</K -1/Columns ${width}${blackIs1}>>`
            : "/BitsPerComponent 8/Filter/FlateDecode"),
        data: mask ? mask.data : deflateSync(alpha),
      });
      const rgbData = deflateSync(rgb);
      let lengthRef = "";
      if (page.indirectLength) lengthRef = `/Length ${add(String(rgbData.length))} 0 R`;
      const image = add({
        dict: `/DecodeParms<<>>/Type/XObject/Subtype/Image/Width ${width}/Height ${height}/BitsPerComponent 8/SMask ${smask} 0 R/ColorSpace/DeviceRGB${lengthRef}/Filter/FlateDecode`,
        data: rgbData,
      });
      const form = add({
        dict: `/Type/XObject/Subtype/Form/BBox[0 0 ${PAGE_W} ${PAGE_H}]/Resources<</XObject<</Img${image} ${image} 0 R>>>>`,
        data: new TextEncoder().encode(`${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Img${image} Do\n`),
      });
      const annot = add(`<</Type/Annot/Subtype/Stamp/Rect[0 0 ${PAGE_W} ${PAGE_H}]/C[1 0 0]/F 4/AP<</N ${form} 0 R>>>>`);
      annots = `/Annots[${annot} 0 R]`;
    }
    kids.push(
      add(`<</Type/Page/MediaBox[0 0 ${PAGE_W} ${PAGE_H}]/Contents ${content} 0 R/Parent ${pagesId} 0 R${annots}>>`),
    );
  }
  objects[catalog - 1] = `<</Type/Catalog/Pages ${pagesId} 0 R>>`;
  objects[pagesId - 1] = `<</Type/Pages/Count ${kids.length}/Kids[${kids.map((k) => `${k} 0 R`).join(" ")}]>>`;

  const chunks: Uint8Array[] = [];
  const enc = (s: string) => Buffer.from(s, "latin1");
  let size = 0;
  const push = (b: Uint8Array) => {
    chunks.push(b);
    size += b.length;
  };
  push(enc("%PDF-1.4\n%\xc2\xb5\xc2\xb6\n"));
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(size);
    if (typeof obj === "string") {
      push(enc(`${i + 1} 0 obj\n${obj}\nendobj\n`));
    } else {
      const hasLength = obj.dict.includes("/Length");
      push(enc(`${i + 1} 0 obj\n<<${obj.dict}${hasLength ? "" : `/Length ${obj.data.length}`}>>\nstream\n`));
      push(obj.data);
      push(enc("\nendstream\nendobj\n"));
    }
  });
  const xref = size;
  push(enc(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  for (const off of offsets) push(enc(`${String(off).padStart(10, "0")} 00000 n \n`));
  push(enc(`trailer\n<</Size ${objects.length + 1}/Root ${catalog} 0 R>>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

/** Decodes an 8-bit RGBA, non-interlaced PNG. */
export function decodePng(png: Uint8Array): Bitmap {
  const buf = Buffer.from(png);
  if (buf.subarray(0, 8).toString("latin1") !== "\x89PNG\r\n\x1a\n") throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("latin1");
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error("expected 8-bit RGBA non-interlaced");
    } else if (type === "IDAT") {
      idat.push(data);
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rgba.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[x - 4]! : 0;
      const b = prev[x]!;
      const c = x >= 4 ? prev[x - 4]! : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = (line[x]! + pred) & 0xff;
    }
    prev.set(out);
  }
  return { width, height, rgba };
}
