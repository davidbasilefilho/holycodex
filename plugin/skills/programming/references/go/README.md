# Go

Preserve module stack. Greenfield: current Go, gofmt/gofumpt, `go vet`, golangci-lint, tests with race detector when concurrency touched. Accept context first for cancellable work. Concrete inputs, narrow consumer-owned interfaces, explicit zero-value semantics. Wrap errors with `%w`; use `errors.Is/As`. Close owned resources. No panic for expected failure, goroutine without owner/stop path, copied mutex, hidden global state, `interface{}` escape, or sleep-based test. Table tests only when cases share one contract. Run format, vet/lint, targeted tests; `-race` for concurrent code.
