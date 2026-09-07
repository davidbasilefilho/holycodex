# Testing quality

Use this reference when assessing a test for a requested change. Identify the
stable behavior, contract, invariant, compatibility guarantee, safety property,
or meaningful failure mode it protects; the regression it catches; and why a
less brittle boundary cannot protect it.

Do not freeze incidental counts, inventories, internal paths, prompt or skill
wording, irrelevant call order, broad repository shape, or one implementation
strategy. Prefer observable typed or public boundaries. Package-verification
tests should consume the shipped artifact through one supported outer boundary
with minimal realistic setup, proving behavior without duplicating the suite.

When Root needs independent local proof, dispatch `Worker.validation` through a
bounded Assignment. Its filesystem writes are limited to caches, build output,
and generated test state; it cannot mutate the implementation under
validation. Root does not run repository tests locally.
