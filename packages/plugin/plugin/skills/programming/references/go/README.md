# Go

Preserve module stack. Greenfield: current Go, gofmt/gofumpt, vet, golangci-lint, tests and race detector for concurrency. Put context first for cancellable work; use concrete inputs, narrow consumer-owned interfaces, explicit zero values. Wrap with `%w`; use `errors.Is/As`; close owned resources. No panic for expected failure, ownerless goroutine, copied mutex, hidden global, `interface{}` escape, sleep-based test. Table tests only for shared contracts. Run format, vet/lint, targeted tests, `-race` when concurrent.
