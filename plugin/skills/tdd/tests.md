# Tests

Test caller-visible behavior through public interfaces. Good tests survive refactors, use known literal expectations, perform one action, and assert its observable result.

Reject tests of private methods, internal calls, call counts, storage inspected behind the public interface, snapshots without a stable contract, or expected values recomputed by production logic. These test implementation, not behavior.

Example: after `createUser`, verify `getUser(id)` returns the user; do not query the database directly.
