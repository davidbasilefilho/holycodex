# Logging

Use existing structured logger once at ownership boundary. Include stable event/useful IDs; exclude secrets, tokens, raw personal data, huge payloads. Error logs retain typed cause/operation. Debug logs cannot be required for correctness. Prefer fields over string interpolation.
