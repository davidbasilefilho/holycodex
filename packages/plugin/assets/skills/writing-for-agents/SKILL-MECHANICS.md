# Skill mechanics

Use a model-invoked skill when its description names a distinct model-facing
branch. Keep the description trigger-first and short. Keep routing and
invocation metadata in `agents/openai.yaml`; the body owns the behavior.

Put uncommon mechanics in a linked reference only when a caller needs them.
Keep each instruction in one source of truth and avoid copying body text into
metadata or neighboring skills.
