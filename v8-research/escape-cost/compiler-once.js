// Diagnostic only: execute each unchanged official Compiler callback once.
// The callbacks retain their original %BenchTurbofan iteration counts.
d8.file.execute('../base.js');
d8.file.execute('small.js');
d8.file.execute('medium.js');
d8.file.execute('large.js');
for (const suite of BenchmarkSuite.suites) {
  print('EA_CASE_BEGIN ' + suite.name);
  for (const benchmark of suite.benchmarks) {
    BenchmarkSuite.ResetRNG();
    benchmark.Setup();
    benchmark.run();
    benchmark.TearDown();
  }
  print('EA_CASE_END ' + suite.name);
}
