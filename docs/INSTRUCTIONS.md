# Model instruction assets

`overlay/holycodex/instructions/root.md` is the compact, permanent Root contract. `specialist.md` is the stable shared specialist contract; the runtime supplies the current Role.task fragment separately with each Assignment so a specialist can be rebound without changing its base prompt. The Assignment and runtime own scope, mutation authority, tool availability, policy, and acceptance facts; these assets do not duplicate them.

All prompt assets here are freshly authored for HolyCodex 0.17.0 from its product specification. No 0.16.12 prompt body is carried forward.
