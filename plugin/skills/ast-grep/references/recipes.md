# Recipes

- Call: `pattern: logger.debug($A)`.
- Any arguments: `pattern: console.log($$$ARGS)`.
- Empty catch: match `catch ($E) {}` with language-correct syntax.
- Missing await: match call plus `not`/`inside` constraint excluding await expression.
- Import migration: match full import/require form; preserve captured module/name in fix.

For each recipe: search narrow path, inspect variants, add constraint, dry review, write, format, test.
