const legacyNames = [
  'simd',
  'scalar',
  'simd-pointers',
  'scalar-pointers',
  'simd-small',
  'simd-pointers-small',
  'collision',
  'collision-pointers',
];

function next(variant, features = {}, optimization = '-O3') {
  return {
    variant,
    source: 'wasm/next.c',
    simd: true,
    pointers: true,
    small: false,
    collision: variant.includes('collision'),
    features,
    optimization,
  };
}

// Algorithm choices are compile-time, not branches in the per-row hot path.
export const variants = [
  ...legacyNames.map((variant) => ({
    variant,
    source: 'wasm/kernel.c',
    simd: !variant.startsWith('scalar'),
    pointers: variant.includes('pointers'),
    small: variant.includes('small'),
    collision: variant.startsWith('collision'),
    features: {},
    optimization: '-O3',
  })),
  next('next-control'),
  next('next-adaptive', { ADAPTIVE_TABLE: 1 }),
  next('next-adaptive1k', { ADAPTIVE_TABLE: 1, INITIAL_BITS: 10 }),
  next('next-adaptive4k', { ADAPTIVE_TABLE: 1, INITIAL_BITS: 12 }),
  next('next-compact', { COMPACT_STATIONS: 1 }),
  next('next-local', { COMPACT_STATIONS: 1, ADAPTIVE_TABLE: 1 }),
  next('next-cold', { OUTLINE_INSERT: 1 }),
  next('next-compact-cold', { COMPACT_STATIONS: 1, OUTLINE_INSERT: 1 }),
  next('next-cold-o2', { OUTLINE_INSERT: 1 }, '-O2'),
  next('next-cold-os', { OUTLINE_INSERT: 1 }, '-Os'),
  next('next-local-cold', { COMPACT_STATIONS: 1, ADAPTIVE_TABLE: 1, OUTLINE_INSERT: 1 }),
  next('next-o2', {}, '-O2'),
  next('next-os', {}, '-Os'),
  next('next-local-o2', { COMPACT_STATIONS: 1, ADAPTIVE_TABLE: 1, OUTLINE_INSERT: 1 }, '-O2'),
  next('next-stream16', { STREAMING_SCAN: 1, STREAM_BATCH: 16 }),
  next('next-stream32', { STREAMING_SCAN: 1, STREAM_BATCH: 32 }),
  next('next-stream64', { STREAMING_SCAN: 1, STREAM_BATCH: 64 }),
  next('next-stream-local', {
    STREAMING_SCAN: 1,
    STREAM_BATCH: 32,
    COMPACT_STATIONS: 1,
    ADAPTIVE_TABLE: 1,
    OUTLINE_INSERT: 1,
  }),
  next('next-collision', {
    COMPACT_STATIONS: 1,
    ADAPTIVE_TABLE: 1,
    INITIAL_BITS: 8,
    OUTLINE_INSERT: 1,
  }),
  next('next-stream-collision', {
    STREAMING_SCAN: 1,
    STREAM_BATCH: 16,
    COMPACT_STATIONS: 1,
    ADAPTIVE_TABLE: 1,
    INITIAL_BITS: 8,
    OUTLINE_INSERT: 1,
  }),
];
