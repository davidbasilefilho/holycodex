# HolyCodex provenance ledger

This document owns evidence admissibility and limitation claims. It is the
single source for what may be treated as a supplied fact. Contract decisions
are marked as decisions; they are not disguised as historical compatibility
or official behavior.

## Exact whitelist

The only admissible inputs for this clean-room foundation are:

1. The user-provided task specification and explicit completion criteria.
2. Legacy HolyCodex README and high-level documentation, release notes, public
   package metadata, and black-box output from a released artifact.
3. Legacy tests interpreted only as descriptions of externally observable
   inputs and outputs, never as implementation templates.
4. Primary official Codex, dependency, tooling, and license documentation.
5. Files authored on `next`, only for internal consistency checks rather than
   evidence of historical behavior.

The assignment's stated official facts are admissible under item 1. A claim
not stated by item 1 or item 2 is unknown. A design choice needed to make the
requested independent foundation coherent is admissible as `D-*` contract
decisions only when it is labeled as such.

## Exact denylist

The following are never admissible inputs, whether read directly, through a
tool, through cache or history, by quotation, by comparison, or by adaptation:

- legacy HolyCodex `.ts`, `.js`, `.mjs`, runtime or bundled source, prompts,
  skills, hooks, agents, generated internal code, and history diffs;
- any OmO or LazyCodex implementation material or derivative;
- undocumented remembered behavior, unverified compatibility assumptions,
  public summaries used as a substitute for the supplied dossier, or facts
  inferred from a name alone;
- network, package, plugin, MCP, or external repository material not
  expressly admitted by the task context.

The denylist is a clean-room boundary, not a request to inspect or prove the
absence of those materials.

## Ledger entries

| ID     | Source class                                                                       | Supports                                                                                                                                                        | Does not support                                                               |
| ------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `P-01` | Task specification and stable profile                                              | Independent clean-room release scope, requested documents, role/value names, clean-room rule, tool and licensing requirements, and completion gate stated there | Any undocumented prior implementation or compatibility claim                   |
| `P-02` | Permitted legacy documentation, metadata, black-box output, and tests-as-contracts | Externally observable product behavior with exact source locator                                                                                                | Implementation structure, distinctive prose reuse, or undocumented internals   |
| `P-03` | Primary official current documentation                                             | Current API, toolchain, and licensing facts with locator and access date                                                                                        | Guarantees beyond the cited official material                                  |
| `D-01` | Authored behavioral contract                                                       | Observable choices for routing, state identities, failure, telemetry, and acceptance required to make the requested foundation testable                         | Proof that an earlier product behaved this way                                 |
| `D-02` | Authored architecture/CLI/security contracts                                       | Intended package graph, wire envelope, threat model, and recovery boundary                                                                                      | Implemented availability, performance, security certification, or legal status |

## Limitations

This ledger does not establish compatibility, authorship beyond the stated
clean-room process, licensing status beyond the repository's license files,
security certification, legal advice, performance, availability, or fitness
for a purpose. It records an independently authored specification, not proof
of a prior system. Missing dossier content remains unspecified; authors must
raise a material ambiguity to Root rather than fill it with legacy knowledge.

Every future implementation change should preserve the relevant `P-*` or
`D-*` classification, update the owning document, and link to it instead of
copying its normative text.
