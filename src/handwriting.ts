// Pulls the handwriting out of the PDF Supernote Cloud renders for a PDF together
// with its mark (/file/pdfwithmark/to/pdf). The cloud leaves the original pages
// untouched and adds, on each annotated page, one full-page Stamp annotation whose
// appearance draws a single image: the handwriting as RGB plus an SMask for
// transparency. This reads just enough PDF to find those images and re-encode them
// as PNG; it is not a general PDF reader.

import { deflateSync, inflateSync } from "node:zlib";
import { UnreadableMarkPdf } from "./errors.ts";

export interface HandwritingPage {
  /** 1-based page number in the PDF. */
  page: number;
  /** The page's handwriting as an RGBA PNG with a transparent background. */
  png: Uint8Array;
}

class Name {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

class Ref {
  readonly num: number;
  constructor(num: number) {
    this.num = num;
  }
}

type PdfValue = number | boolean | null | Name | Ref | Uint8Array | PdfValue[] | PdfDict;
type PdfDict = Map<string, PdfValue>;

interface PdfObject {
  value: PdfValue;
  /** Byte offset of the stream data, for stream objects. */
  streamStart?: number;
}

const DELIMITERS = "()<>[]{}/%";
const WHITESPACE = " \t\r\n\f\0";

/** Reads one PDF value at a time from the file's text (latin1, so indexes are byte offsets). */
class Lexer {
  readonly text: string;
  pos: number;

  constructor(text: string, pos = 0) {
    this.text = text;
    this.pos = pos;
  }

  #skipSpace(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      if (WHITESPACE.includes(ch)) this.pos++;
      else if (ch === "%") while (this.pos < this.text.length && !"\r\n".includes(this.text[this.pos]!)) this.pos++;
      else break;
    }
  }

  #regular(): string {
    const start = this.pos;
    while (this.pos < this.text.length && !WHITESPACE.includes(this.text[this.pos]!) && !DELIMITERS.includes(this.text[this.pos]!)) {
      this.pos++;
    }
    return this.text.slice(start, this.pos);
  }

  /** The next keyword, without consuming it ("stream", "endobj", ...). */
  peekKeyword(): string {
    this.#skipSpace();
    const start = this.pos;
    const word = this.#regular();
    this.pos = start;
    return word;
  }

  value(): PdfValue {
    this.#skipSpace();
    const ch = this.text[this.pos];
    if (ch === undefined) throw new UnreadableMarkPdf("unexpected end of file");
    if (ch === "/") {
      this.pos++;
      return new Name(this.#regular().replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));
    }
    if (ch === "[") {
      this.pos++;
      const items: PdfValue[] = [];
      for (this.#skipSpace(); this.text[this.pos] !== "]"; this.#skipSpace()) items.push(this.value());
      this.pos++;
      return items;
    }
    if (this.text.startsWith("<<", this.pos)) {
      this.pos += 2;
      const dict: PdfDict = new Map();
      for (this.#skipSpace(); !this.text.startsWith(">>", this.pos); this.#skipSpace()) {
        const key = this.value();
        if (!(key instanceof Name)) throw new UnreadableMarkPdf("dictionary key is not a name");
        dict.set(key.value, this.value());
      }
      this.pos += 2;
      return dict;
    }
    if (ch === "<") return this.#hexString();
    if (ch === "(") return this.#literalString();

    const word = this.#regular();
    if (word === "true" || word === "false") return word === "true";
    if (word === "null") return null;
    const num = Number(word);
    if (word === "" || Number.isNaN(num)) throw new UnreadableMarkPdf(`unexpected token "${word || ch}"`);
    // "<num> <gen> R" is a reference
    if (Number.isInteger(num)) {
      const save = this.pos;
      this.#skipSpace();
      const gen = this.#regular();
      this.#skipSpace();
      if (/^\d+$/.test(gen) && this.text[this.pos] === "R" && !/[^\s\]>\/]/.test(this.text[this.pos + 1] ?? " ")) {
        this.pos++;
        return new Ref(num);
      }
      this.pos = save;
    }
    return num;
  }

  #hexString(): Uint8Array {
    const end = this.text.indexOf(">", this.pos);
    const hex = this.text.slice(this.pos + 1, end).replace(/\s/g, "");
    this.pos = end + 1;
    return Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
  }

  /** Skips a (literal string), honouring nesting and escapes; its content is never needed here. */
  #literalString(): Uint8Array {
    this.pos++;
    for (let depth = 1; depth > 0; this.pos++) {
      const ch = this.text[this.pos];
      if (ch === undefined) throw new UnreadableMarkPdf("unterminated string");
      if (ch === "\\") this.pos++;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    return new Uint8Array();
  }
}

class PdfFile {
  readonly #bytes: Buffer;
  readonly #text: string;
  readonly #objects = new Map<number, PdfObject>();

  constructor(bytes: Uint8Array) {
    this.#bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#text = this.#bytes.toString("latin1");
    if (!this.#text.startsWith("%PDF-")) throw new UnreadableMarkPdf("not a PDF");
    this.#scan();
  }

  /** Indexes every "<num> <gen> obj"; a later definition replaces an earlier one, as in an incremental update. */
  #scan(): void {
    const header = /(\d+)\s+\d+\s+obj\b/g;
    for (let match = header.exec(this.#text); match; match = header.exec(this.#text)) {
      const lexer = new Lexer(this.#text, header.lastIndex);
      let value: PdfValue;
      try {
        value = lexer.value();
      } catch {
        continue; // "n g obj" inside data that is not an object
      }
      const object: PdfObject = { value };
      if (lexer.peekKeyword() === "stream") {
        let start = this.#text.indexOf("stream", lexer.pos) + "stream".length;
        if (this.#text[start] === "\r") start++;
        if (this.#text[start] === "\n") start++;
        object.streamStart = start;
        // skip the data so bytes in it are not mistaken for objects; the real length is read on demand
        const length = value instanceof Map ? value.get("Length") : undefined;
        const end = typeof length === "number" ? start + length : this.#text.indexOf("endstream", start);
        if (end > start) header.lastIndex = end;
      }
      this.#objects.set(Number(match[1]), object);
    }
  }

  resolve(value: PdfValue | undefined): PdfValue | undefined {
    for (let hops = 0; value instanceof Ref; hops++) {
      const object = this.#objects.get(value.num);
      if (!object || hops > 32) {
        throw new UnreadableMarkPdf(`object ${value.num} not found (compressed object streams are not supported)`);
      }
      value = object.value;
    }
    return value;
  }

  dict(value: PdfValue | undefined): PdfDict | undefined {
    const resolved = this.resolve(value);
    return resolved instanceof Map ? resolved : undefined;
  }

  array(value: PdfValue | undefined): PdfValue[] {
    const resolved = this.resolve(value);
    return Array.isArray(resolved) ? resolved : [];
  }

  /** The raw (still encoded) bytes of a stream object. */
  streamData(ref: PdfValue | undefined): { dict: PdfDict; data: Buffer } | undefined {
    if (!(ref instanceof Ref)) return undefined;
    const object = this.#objects.get(ref.num);
    if (object?.streamStart === undefined || !(object.value instanceof Map)) return undefined;
    const length = this.resolve(object.value.get("Length"));
    if (typeof length !== "number") throw new UnreadableMarkPdf(`stream ${ref.num} has no length`);
    return { dict: object.value, data: this.#bytes.subarray(object.streamStart, object.streamStart + length) };
  }

  catalog(): PdfDict {
    const trailer = this.#text.lastIndexOf("trailer");
    const dict = trailer >= 0 ? new Lexer(this.#text, trailer + "trailer".length).value() : undefined;
    const root = dict instanceof Map ? this.dict(dict.get("Root")) : undefined;
    if (!root) throw new UnreadableMarkPdf("no document catalog (cross-reference streams are not supported)");
    return root;
  }

  /** Every page in reading order, with its MediaBox (which a page may inherit). */
  pages(): PageEntry[] {
    const pages: PageEntry[] = [];
    const visit = (node: PdfDict | undefined, inherited: number[] | undefined, depth: number) => {
      if (!node || depth > 64) return;
      const box = this.array(node.get("MediaBox")).map((n) => this.resolve(n));
      const mediaBox = box.length === 4 && box.every((n) => typeof n === "number") ? (box as number[]) : inherited;
      if (isName(node.get("Type"), "Pages")) {
        for (const kid of this.array(node.get("Kids"))) visit(this.dict(kid), mediaBox, depth + 1);
      } else {
        pages.push({ page: node, mediaBox });
      }
    };
    visit(this.dict(this.catalog().get("Pages")), undefined, 0);
    return pages;
  }
}

interface PageEntry {
  page: PdfDict;
  /** Undefined when neither the page nor its ancestors give one. */
  mediaBox: number[] | undefined;
}

function isName(value: PdfValue | undefined, name: string): boolean {
  return value instanceof Name && value.value === name;
}

interface Bitmap {
  width: number;
  height: number;
  rgba: Uint8Array;
}

interface Samples {
  dict: PdfDict;
  width: number;
  height: number;
  samples: Buffer;
}

/** Decodes an 8-bit, Flate-compressed image stream in the given colour space into raw samples. */
function decodeSamples(pdf: PdfFile, ref: PdfValue | undefined, space: "DeviceRGB" | "DeviceGray"): Samples {
  const stream = pdf.streamData(ref);
  if (!stream) throw new UnreadableMarkPdf("handwriting image is not a stream");
  const { dict, data } = stream;
  const width = pdf.resolve(dict.get("Width"));
  const height = pdf.resolve(dict.get("Height"));
  if (typeof width !== "number" || typeof height !== "number") throw new UnreadableMarkPdf("image has no size");
  if (pdf.resolve(dict.get("BitsPerComponent")) !== 8) throw new UnreadableMarkPdf("only 8-bit images are supported");

  if (!isName(pdf.resolve(dict.get("ColorSpace")), space)) throw new UnreadableMarkPdf(`expected a ${space} image`);
  const channels = space === "DeviceRGB" ? 3 : 1;

  const filter = pdf.resolve(dict.get("Filter"));
  const filters = Array.isArray(filter) ? filter.map((f) => pdf.resolve(f)) : filter === undefined ? [] : [filter];
  if (filters.length !== 1 || !isName(filters[0], "FlateDecode")) {
    throw new UnreadableMarkPdf("only Flate-compressed images are supported");
  }
  const parms = pdf.resolve(dict.get("DecodeParms"));
  const predictor = parms instanceof Map ? pdf.resolve(parms.get("Predictor")) : undefined;
  if (Array.isArray(parms) || (predictor !== undefined && predictor !== 1)) {
    throw new UnreadableMarkPdf("image predictors are not supported");
  }

  const samples = inflateSync(data);
  if (samples.length < width * height * channels) throw new UnreadableMarkPdf("image data is truncated");
  return { dict, width, height, samples };
}

/** The handwriting image: RGB colour with an SMask for its transparency. */
function decodeImage(pdf: PdfFile, ref: PdfValue | undefined): Bitmap {
  const color = decodeSamples(pdf, ref, "DeviceRGB");
  const { width, height } = color;
  const smask = color.dict.get("SMask");
  const alpha = smask === undefined ? undefined : decodeSamples(pdf, smask, "DeviceGray");
  if (alpha && (alpha.width !== width || alpha.height !== height)) {
    throw new UnreadableMarkPdf("image transparency mask does not match the image");
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba.set(color.samples.subarray(i * 3, i * 3 + 3), i * 4);
    rgba[i * 4 + 3] = alpha ? alpha.samples[i]! : 255;
  }
  return { width, height, rgba };
}

/** Images drawn by a Stamp annotation that covers the whole page: how the cloud places handwriting. */
function stampImages(pdf: PdfFile, { page, mediaBox }: PageEntry): PdfValue[] {
  const images: PdfValue[] = [];
  if (!mediaBox) return images;
  for (const annotRef of pdf.array(page.get("Annots"))) {
    const annot = pdf.dict(annotRef);
    if (!annot || !isName(annot.get("Subtype"), "Stamp")) continue;
    const rect = pdf.array(annot.get("Rect")).map((n) => pdf.resolve(n));
    const coversPage = rect.length === 4 && rect.every((n, i) => typeof n === "number" && Math.abs(n - mediaBox[i]!) < 1);
    if (!coversPage) continue;

    const form = pdf.streamData(pdf.dict(annot.get("AP"))?.get("N"));
    const xobjects = pdf.dict(pdf.dict(form?.dict.get("Resources"))?.get("XObject"));
    for (const ref of xobjects?.values() ?? []) {
      if (isName(pdf.streamData(ref)?.dict.get("Subtype"), "Image")) images.push(ref);
    }
  }
  return images;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng({ width, height, rgba }: Bitmap): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height); // filter byte 0 (none) before each row
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

/** The handwriting on each annotated page of a PDF rendered by /file/pdfwithmark/to/pdf. */
export function extractHandwriting(pdfBytes: Uint8Array): HandwritingPage[] {
  const pdf = new PdfFile(pdfBytes);
  const result: HandwritingPage[] = [];
  pdf.pages().forEach((entry, index) => {
    const images = stampImages(pdf, entry);
    if (images.length === 0) return;
    if (images.length > 1) throw new UnreadableMarkPdf(`page ${index + 1} has more than one handwriting image`);
    result.push({ page: index + 1, png: encodePng(decodeImage(pdf, images[0])) });
  });
  return result;
}
