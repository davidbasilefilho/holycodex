# Patterns

Use code-shaped pattern in target language. `$A` captures one node; `$$$ARGS` captures many; `$_` ignores one. Start concrete, then replace only variable parts. Quote pattern in shell. If syntax fragment cannot parse alone, use `context` plus `selector` in YAML. Verify matches before rewrite.
