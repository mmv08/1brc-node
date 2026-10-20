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
