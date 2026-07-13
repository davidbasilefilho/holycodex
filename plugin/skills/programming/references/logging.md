# Logging

Use existing structured logger. Log once at ownership boundary, not every layer. Include stable event name and useful IDs; exclude secrets, tokens, raw personal data, huge payloads. Error logs retain typed cause and operation. Debug logs must not be required for correctness. Avoid string interpolation when logger supports fields.
