# Releasing

Validation and publication are separate CI jobs. Validation runs formatting, lint and types, tests, generated consistency, version checks, and packed-package lifecycle checks with read-only permissions. Only tagged or explicitly authorized publication receives contents and OIDC write permissions.
