// Diagnostic only. Run from V8's unchanged test/js-perf-test/DataView directory
// with --allow-natives-syntax. This is not an official benchmark score.
d8.file.execute('run.js');
print('RecompileTargetAverageMs: ' +
      %BenchTurbofan(doOneIterationJS, 4000));
