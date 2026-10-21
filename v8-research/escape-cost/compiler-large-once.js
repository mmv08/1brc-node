// Allocation diagnostic: invoke the original Large-Copy callback once.
d8.file.execute('../base.js');
d8.file.execute('large.js');
BenchmarkSuite.ResetRNG();
const benchmark = BenchmarkSuite.suites[0].benchmarks[0];
benchmark.Setup();
benchmark.run();
benchmark.TearDown();
