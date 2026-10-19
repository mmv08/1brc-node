import { readFileSync } from 'node:fs';
import { consume } from '../lib/read.mjs';
import { variants } from './variants.mjs';

const modules = new Map();
const definitions = new Map(variants.map((definition) => [definition.variant, definition]));

export async function createKernel(chunkSize, options = {}) {
  const variant = options.variant ?? process.env.WASM_VARIANT ?? 'simd-pointers';
  if (!definitions.has(variant)) throw new Error('Unknown WASM_VARIANT');
  if (!modules.has(variant)) {
    modules.set(
      variant,
      WebAssembly.compile(readFileSync(new URL(`kernel-${variant}.wasm`, import.meta.url))),
    );
  }
  const instance = new WebAssembly.Instance(await modules.get(variant));
  const api = instance.exports;
  const inputBase = api.input_base() >>> 0;
  const capacity = chunkSize + 256;
  const slots = options.slots ?? ((process.env.IO ?? 'sync') === 'async' ? 2 : 1);
  if (![1, 2].includes(slots)) throw new Error('Wasm input requires one or two buffer slots');
  const required = inputBase + slots * capacity;
  if (required > api.memory.buffer.byteLength) {
    api.memory.grow(Math.ceil((required - api.memory.buffer.byteLength) / 65536));
  }
  // Grow once, BEFORE constructing views: memory.grow detaches previous buffers.
  // fs.readSync fills these Buffer views directly. No JS-to-Wasm input copy.
  const memory = api.memory.buffer;
  const view = new DataView(memory);
  const streaming = Boolean(api.streaming_enabled?.());
  const streams = options.streams ?? Number(process.env.WASM_STREAMS ?? (streaming ? 1 : 4));
  if (![1, 2, 3, 4].includes(streams)) throw new Error('WASM_STREAMS must be 1..4');
  if (streaming && streams !== 1) throw new Error('Streaming kernels require WASM_STREAMS=1');
  const parse = streaming ? api.parse_stream : api[`parse${streams}`];
  let allocated = 0;
  api.reset();
  return {
    api,
    memory,
    allocateBuffer(length) {
      if (length !== capacity || allocated >= slots)
        throw new Error('Invalid Wasm input allocation');
      return Buffer.from(memory, inputBase + allocated++ * capacity, capacity);
    },
    makeParser(buffer) {
      if (buffer.buffer !== memory) throw new Error('Input must be backed by Wasm memory');
      const base = buffer.byteOffset;
      return (start, end) => parse(base + start, base + end);
    },
    rows() {
      const count = api.station_count();
      const base = api.stations_base() >>> 0;
      const keys = api.keys_base() >>> 0;
      const stride = api.station_stride();
      if (![40, 48].includes(stride)) throw new Error('Unexpected Wasm station ABI');
      return Array.from({ length: count }, (_, id) => {
        const p = base + id * stride;
        const packed = stride === 40 ? view.getUint32(p + 20, true) : 0;
        const offset = stride === 40 ? packed & 0xfffff : view.getUint32(p + 16, true);
        const length = stride === 40 ? packed >>> 20 : view.getUint32(p + 20, true);
        const name = Buffer.from(memory, keys + offset, length).toString('utf8');
        // BigInt is used once per RESULT, never per input row. The bounded
        // integer sum is exactly representable as a JS Number for 1BRC.
        return [
          name,
          view.getInt16(p + 12, true),
          Number(view.getBigInt64(p, true)),
          view.getInt16(p + 14, true),
          view.getUint32(p + 8, true),
        ];
      });
    },
  };
}

export async function aggregate(config) {
  const kernel = await createKernel(config.chunkSize);
  await consume(config, kernel.makeParser, kernel.allocateBuffer);
  return kernel.rows();
}
