export const BYTE_MASKS = [0, 0xff, 0xffff, 0xffffff];
export const MAX_STATIONS = 10000;

const prefixes = new Uint16Array(4096);
for (let first = 0; first <= 9; first++) {
  prefixes[0xe00 | first] = first * 10;
  for (let second = 0; second <= 9; second++) {
    prefixes[(second << 8) | first] = first * 100 + second * 10;
  }
}

function temperatureBase(digits) {
  return prefixes[digits & 0x0f0f];
}

// Preserve the JS kernel's monomorphic hot call site without strategy dispatch.
export function chooseTemperatureParser() {
  return temperatureBase;
}
