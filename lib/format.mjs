// All arithmetic before formatting is in integer tenths. Double-precision sums
// are exact for the challenge's 1e9 * 999 bound, unlike Int32 accumulators.
export function format(rows) {
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `{${rows
    .map(
      ([name, min, sum, max, count]) =>
        `${name}=${(min / 10).toFixed(1)}/${(Math.round(sum / count) / 10).toFixed(1)}/${(max / 10).toFixed(1)}`,
    )
    .join(', ')}}\n`;
}
