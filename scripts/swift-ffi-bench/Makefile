# Swift → Rust FFI 벤치마크 (docs/benchmarks.md "Swift → Rust FFI" 표의 소스).
#
# 사전 조건: release dylib 빌드 — cargo build --release -p rustra-calculator-example
# (debug dylib 은 최적화가 꺼져 브릿지 비용이 부풀어 있어 기준으로 부적합)

RUST_LIB := rustra_calculator_example
LIB_DIR  := ../../target/release

.PHONY: all benchmark clean

all: benchmark

benchmark: Benchmark.swift
	swiftc -O Benchmark.swift -L$(LIB_DIR) -l$(RUST_LIB) -o benchmark
	./benchmark

clean:
	rm -f benchmark
