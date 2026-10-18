// Grammar-only parsing helpers shared by the solver and experimental engines.
export const BYTE_MASKS = [0, 0xff, 0xffff, 0xffffff];
export const MAX_STATIONS = 10000;

export const temperaturePrefixes = new Uint16Array(4096);
export const compactPrefixes = new Uint16Array(150);
for (let first = 0; first <= 9; first++) {
  temperaturePrefixes[0xe00 | first] = first * 10;
  compactPrefixes[140 + first] = first * 10;
  for (let second = 0; second <= 9; second++) {
    const value = first * 100 + second * 10;
    temperaturePrefixes[(second << 8) | first] = value;
    compactPrefixes[second * 10 + first] = value;
  }
}

// Only these tiny arithmetic functions vary between temperature experiments.
// The caller still derives row width directly, without waiting on a lookup.
export function temperatureBase(digits) {
  return temperaturePrefixes[digits & 0x0f0f];
}

export function compactTemperatureBase(digits) {
  return compactPrefixes[(digits & 15) + ((digits >>> 8) & 15) * 10];
}

export function arithmeticTemperatureBase(digits) {
  const twoDigits = (digits >>> 12) & 1;
  return (digits & 15) * (10 + twoDigits * 90) + ((digits >>> 8) & 15) * twoDigits * 10;
}

export function chooseTemperatureParser() {
  switch (process.env.TEMPERATURE ?? 'table') {
    case 'table':
      return temperatureBase;
    case 'compact':
      return compactTemperatureBase;
    case 'arithmetic':
      return arithmeticTemperatureBase;
    default:
      throw new Error('Unknown TEMPERATURE');
  }
}

// Multiple cursors process disjoint newline-aligned portions of the SAME read
// buffer. No allocations occur per row. Explicit lanes avoid a modulo/indexed
// state update in the hot loop, and expose independent work to the optimizer.
export function interleave(buffer, processRow, streams) {
  if (streams === 1)
    return (start, end) => {
      for (let p = start; p < end; ) p = processRow(p);
    };
  if (![2, 3, 4].includes(streams)) throw new Error('STREAMS must be 1, 2, 3, or 4');
  return (start, end) => {
    const boundary = (part) =>
      Math.min(end, buffer.indexOf(10, start + Math.floor(((end - start) * part) / streams)) + 1);
    const endA = boundary(1);
    const endB = streams > 2 ? boundary(2) : end;
    const endC = streams > 3 ? boundary(3) : end;
    let a = start;
    let b = endA;
    let c = endB;
    let d = endC;
    if (streams === 2) {
      while (a < endA && b < end) {
        a = processRow(a);
        b = processRow(b);
      }
    } else if (streams === 3) {
      while (a < endA && b < endB && c < end) {
        a = processRow(a);
        b = processRow(b);
        c = processRow(c);
      }
    } else {
      while (a < endA && b < endB && c < endC && d < end) {
        a = processRow(a);
        b = processRow(b);
        c = processRow(c);
        d = processRow(d);
      }
    }
    while (a < endA) a = processRow(a);
    while (b < endB) b = processRow(b);
    if (streams > 2) while (c < endC) c = processRow(c);
    if (streams > 3) while (d < end) d = processRow(d);
  };
}
