# Mocking

Prefer real objects, test databases, or fakes. Mock only system boundaries: external APIs, time, randomness, and sometimes databases or filesystems. Never mock owned classes or internal collaborators.

Inject boundary dependencies. Expose one typed operation per external action instead of a generic conditional fetcher; each mock then has one input and result shape.
