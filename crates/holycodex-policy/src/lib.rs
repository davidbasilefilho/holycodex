//! Typed runtime policy primitives for HolyCodex 0.17.0.
//!
//! This crate owns routing, allocation, context sizing, prompt asset inclusion,
//! and serializable Intent/Assignment policy. It does not wire these into Codex
//! or perform persistence itself.
#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Stable Root instructions supplied by the instruction overlay.
pub const ROOT_INSTRUCTIONS: &str = include_str!("../../../overlay/holycodex/instructions/root.md");
/// Stable Luna specialist base contract supplied by the instruction overlay.
pub const SPECIALIST_INSTRUCTIONS: &str =
    include_str!("../../../overlay/holycodex/instructions/specialist.md");

/// A HolyCodex reasoning profile.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Profile {
    Low,
    #[default]
    Default,
    High,
}

/// Reasoning efforts exposed by HolyCodex, regardless of provider extras.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
}

/// Model identities required by native runtime policy.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelId {
    Gpt61Sol,
    Gpt6Luna,
}

impl ModelId {
    /// Provider/catalog spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Gpt61Sol => "gpt-6.1-sol",
            Self::Gpt6Luna => "gpt-6-luna",
        }
    }
}

/// Expected mutation level of an Assignment.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mutability {
    ReadOnly,
    ScopedWrite,
    Operational,
}

/// Capability that a runtime must grant to a route.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    RepositoryRead,
    Search,
    Shell,
    FilesystemWrite,
    BrowserUse,
    ComputerUse,
    Sites,
    VisualInspection,
}

/// Concurrency invariants associated with a route.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndependenceRequirement {
    DisjointWrites,
    DependenciesTerminal,
    IndependentReview,
}

/// Typed Role.task key. Root is policy-managed but not specialist-dispatchable.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoleTask {
    Root,
    ExplorerMap,
    ExplorerLookup,
    ExplorerTrace,
    LibrarianLookup,
    LibrarianResearch,
    WorkerMechanical,
    WorkerImplementation,
    WorkerIntegration,
    WorkerOperations,
    WorkerValidation,
    WorkerDebugging,
    WorkerVisual,
    ReviewerCode,
    ReviewerTesting,
    ReviewerAudit,
    ReviewerSecurity,
    ReviewerArtifact,
    ReviewerVisual,
}

impl RoleTask {
    /// All 18 specialist routes in canonical registry order.
    pub const SPECIALISTS: [Self; 18] = [
        Self::ExplorerMap,
        Self::ExplorerLookup,
        Self::ExplorerTrace,
        Self::LibrarianLookup,
        Self::LibrarianResearch,
        Self::WorkerMechanical,
        Self::WorkerImplementation,
        Self::WorkerIntegration,
        Self::WorkerOperations,
        Self::WorkerValidation,
        Self::WorkerDebugging,
        Self::WorkerVisual,
        Self::ReviewerCode,
        Self::ReviewerTesting,
        Self::ReviewerAudit,
        Self::ReviewerSecurity,
        Self::ReviewerArtifact,
        Self::ReviewerVisual,
    ];

    /// Stable external spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Root => "Root",
            Self::ExplorerMap => "Explorer.map",
            Self::ExplorerLookup => "Explorer.lookup",
            Self::ExplorerTrace => "Explorer.trace",
            Self::LibrarianLookup => "Librarian.lookup",
            Self::LibrarianResearch => "Librarian.research",
            Self::WorkerMechanical => "Worker.mechanical",
            Self::WorkerImplementation => "Worker.implementation",
            Self::WorkerIntegration => "Worker.integration",
            Self::WorkerOperations => "Worker.operations",
            Self::WorkerValidation => "Worker.validation",
            Self::WorkerDebugging => "Worker.debugging",
            Self::WorkerVisual => "Worker.visual",
            Self::ReviewerCode => "Reviewer.code",
            Self::ReviewerTesting => "Reviewer.testing",
            Self::ReviewerAudit => "Reviewer.audit",
            Self::ReviewerSecurity => "Reviewer.security",
            Self::ReviewerArtifact => "Reviewer.artifact",
            Self::ReviewerVisual => "Reviewer.visual",
        }
    }

    /// Parse a stable external Role.task spelling.
    pub fn parse(value: &str) -> Option<Self> {
        std::iter::once(Self::Root)
            .chain(Self::SPECIALISTS)
            .find(|role| role.as_str() == value)
    }
}

/// Single registry row: route behavior plus profile-derived model effort.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RoutePolicy {
    pub role: RoleTask,
    pub description: &'static str,
    pub mutability: Mutability,
    pub capabilities: &'static [Capability],
    pub independence: &'static [IndependenceRequirement],
    pub assignment_fragment: &'static str,
    efforts: [ReasoningEffort; 3],
}

impl RoutePolicy {
    /// Resolve effort from the selected HolyCodex profile.
    pub const fn effort(self, profile: Profile) -> ReasoningEffort {
        self.efforts[match profile {
            Profile::Low => 0,
            Profile::Default => 1,
            Profile::High => 2,
        }]
    }
}

const RO: Mutability = Mutability::ReadOnly;
const SW: Mutability = Mutability::ScopedWrite;
const OP: Mutability = Mutability::Operational;
const READ: &[Capability] = &[Capability::RepositoryRead];
const SEARCH: &[Capability] = &[Capability::Search];
const SHELL: &[Capability] = &[Capability::Shell];
const WRITE: &[Capability] = &[Capability::RepositoryRead, Capability::FilesystemWrite];
const REVIEW: &[IndependenceRequirement] = &[IndependenceRequirement::IndependentReview];
const DISJOINT: &[IndependenceRequirement] = &[IndependenceRequirement::DisjointWrites];
const AFTER_DEPS: &[IndependenceRequirement] = &[IndependenceRequirement::DependenciesTerminal];

const fn route(
    role: RoleTask,
    description: &'static str,
    mutability: Mutability,
    capabilities: &'static [Capability],
    independence: &'static [IndependenceRequirement],
    assignment_fragment: &'static str,
    efforts: [ReasoningEffort; 3],
) -> RoutePolicy {
    RoutePolicy {
        role,
        description,
        mutability,
        capabilities,
        independence,
        assignment_fragment,
        efforts,
    }
}

const ROOT_ROUTE: RoutePolicy = route(
    RoleTask::Root,
    "Owns user interaction, decomposition, and integration acceptance.",
    RO,
    READ,
    &[],
    "Coordinate the task, make material decisions, accept integration, and complete the user-facing work.",
    [
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::Medium,
    ],
);
const ROUTES: [RoutePolicy; 18] = [
    route(
        RoleTask::ExplorerMap,
        "Map repository structure and ownership boundaries.",
        RO,
        READ,
        DISJOINT,
        "Map relevant repository areas and report paths, responsibilities, and boundaries.",
        [
            ReasoningEffort::Medium,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::ExplorerLookup,
        "Find definitions, references, and focused source context.",
        RO,
        READ,
        DISJOINT,
        "Locate requested source facts and return concise paths and evidence.",
        [
            ReasoningEffort::Medium,
            ReasoningEffort::Medium,
            ReasoningEffort::Medium,
        ],
    ),
    route(
        RoleTask::ExplorerTrace,
        "Trace behavior across components and runtime paths.",
        RO,
        READ,
        AFTER_DEPS,
        "Trace the requested behavior end to end, identifying contracts and evidence.",
        [
            ReasoningEffort::High,
            ReasoningEffort::High,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::LibrarianLookup,
        "Retrieve focused documentation and project conventions.",
        RO,
        SEARCH,
        DISJOINT,
        "Find authoritative documentation relevant to the Assignment and summarize with evidence.",
        [
            ReasoningEffort::Medium,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::LibrarianResearch,
        "Research a bounded topic from authoritative sources.",
        RO,
        SEARCH,
        AFTER_DEPS,
        "Research the bounded question using authoritative sources and distinguish evidence from inference.",
        [
            ReasoningEffort::High,
            ReasoningEffort::High,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::WorkerMechanical,
        "Apply bounded, mechanical source transformations.",
        SW,
        WRITE,
        DISJOINT,
        "Make only the specified mechanical edits within owned paths.",
        [
            ReasoningEffort::Medium,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::WorkerImplementation,
        "Implement one bounded feature or behavior.",
        SW,
        WRITE,
        DISJOINT,
        "Implement accepted behavior within the owned seam and verify it.",
        [
            ReasoningEffort::High,
            ReasoningEffort::High,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::WorkerIntegration,
        "Integrate compatible components within an assigned boundary.",
        SW,
        WRITE,
        AFTER_DEPS,
        "Integrate assigned components without expanding ownership; verify their boundary.",
        [
            ReasoningEffort::High,
            ReasoningEffort::High,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::WorkerOperations,
        "Perform bounded local operational and build-tool work.",
        OP,
        SHELL,
        DISJOINT,
        "Perform the assigned local operation and report its observable result.",
        [
            ReasoningEffort::Medium,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::WorkerValidation,
        "Run focused validation and report acceptance evidence.",
        RO,
        SHELL,
        AFTER_DEPS,
        "Validate specified behavior with focused checks and report exact outcomes.",
        [
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::WorkerDebugging,
        "Diagnose and repair a bounded defect.",
        SW,
        WRITE,
        AFTER_DEPS,
        "Reproduce and isolate the defect, make the smallest in-scope repair, and verify it.",
        [
            ReasoningEffort::High,
            ReasoningEffort::High,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::WorkerVisual,
        "Implement a bounded visual or interaction change.",
        SW,
        &[
            Capability::RepositoryRead,
            Capability::FilesystemWrite,
            Capability::VisualInspection,
        ],
        DISJOINT,
        "Implement assigned visual behavior and report rendered evidence required for acceptance.",
        [
            ReasoningEffort::High,
            ReasoningEffort::High,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::ReviewerCode,
        "Review implementation correctness and regressions.",
        RO,
        READ,
        REVIEW,
        "Independently review assigned code for correctness and regressions; report actionable findings.",
        [
            ReasoningEffort::High,
            ReasoningEffort::High,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::ReviewerTesting,
        "Review test adequacy and behavior coverage.",
        RO,
        SHELL,
        REVIEW,
        "Independently assess whether focused tests prove acceptance criteria; report gaps.",
        [
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::ReviewerAudit,
        "Audit a bounded implementation against stated requirements.",
        RO,
        READ,
        REVIEW,
        "Audit the owned change against supplied requirements and evidence; report discrepancies.",
        [
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::ReviewerSecurity,
        "Review a bounded change for security vulnerabilities.",
        RO,
        READ,
        REVIEW,
        "Independently assess security properties of the assigned change and substantiate findings.",
        [
            ReasoningEffort::High,
            ReasoningEffort::High,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::ReviewerArtifact,
        "Review a bounded artifact for correctness and completeness.",
        RO,
        READ,
        REVIEW,
        "Inspect the assigned artifact against acceptance criteria and report evidence-based gaps.",
        [
            ReasoningEffort::High,
            ReasoningEffort::High,
            ReasoningEffort::High,
        ],
    ),
    route(
        RoleTask::ReviewerVisual,
        "Review rendered visual quality and interaction behavior.",
        RO,
        &[Capability::RepositoryRead, Capability::VisualInspection],
        REVIEW,
        "Independently inspect the rendered result for acceptance-level visual or interaction discrepancies.",
        [
            ReasoningEffort::High,
            ReasoningEffort::High,
            ReasoningEffort::High,
        ],
    ),
];

/// Complete canonical 18-route specialist registry.
pub fn specialist_registry() -> &'static [RoutePolicy; 18] {
    &ROUTES
}

/// Policy row for any typed role, including Root.
pub fn route_policy(role: RoleTask) -> Option<&'static RoutePolicy> {
    if role == RoleTask::Root {
        Some(&ROOT_ROUTE)
    } else {
        ROUTES.iter().find(|row| row.role == role)
    }
}

/// Genuine HolyCodex choices and fresh-install defaults.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PolicyConfig {
    pub profile: Profile,
    pub service_tier: Option<String>,
    pub browser_use: bool,
    pub computer_use: bool,
    pub sites: bool,
    pub session_audit: bool,
    pub auto_reset: bool,
}

impl Default for PolicyConfig {
    fn default() -> Self {
        Self {
            profile: Profile::Default,
            service_tier: None,
            browser_use: true,
            computer_use: false,
            sites: true,
            session_audit: false,
            auto_reset: false,
        }
    }
}

/// Resolved provider metadata. The model maximum remains distinct from the active window.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelMetadata {
    /// Exact identifier from the supported catalog.
    pub id: String,
    /// Resolved context capacity available to the active environment.
    pub context_window_tokens: u32,
    /// Provider/model maximum capability, retained when normal policy is smaller.
    pub maximum_context_tokens: u32,
    /// Optional active-environment cap imposed by provider or session metadata.
    pub hard_context_limit_tokens: Option<u32>,
    /// Provider compaction margin; policy retains at least its derived safety margin.
    pub provider_safety_margin_tokens: Option<u32>,
}

/// HolyCodex effective context profile after applying provider hard constraints.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EffectiveContext {
    pub normal_window_tokens: u32,
    pub model_maximum_tokens: u32,
    pub effective_hard_limit_tokens: u32,
    pub safety_margin_tokens: u32,
    pub safety_margin_source: SafetyMarginSource,
    pub compact_at_tokens: u32,
    pub constrained_below_normal: bool,
}

/// Evidence behind the effective safety margin.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SafetyMarginSource {
    /// Catalog-provided margin is at least the native policy's derived minimum.
    ProviderMetadata,
    /// Native policy's five-percent floor exceeded the catalog-provided margin or metadata was absent.
    DerivedPolicy,
}

/// Invalid resolved metadata or hard context constraint.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContextPolicyError {
    ZeroCapacity {
        field: &'static str,
    },
    CapacityExceedsMaximum {
        field: &'static str,
        value: u32,
        maximum: u32,
    },
    InvalidSafetyMargin {
        value: u32,
        normal_window: u32,
    },
    NoUsableWindow {
        normal_window: u32,
        safety_margin: u32,
    },
}

impl std::fmt::Display for ContextPolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ContextPolicyError {}

/// Default normal raw context window; not the model maximum or a target fill level.
pub const NORMAL_CONTEXT_TOKENS: u32 = 372_000;

/// Apply normal-window and compaction policy without clamping advertised maximum metadata.
pub fn effective_context(metadata: &ModelMetadata) -> Result<EffectiveContext, ContextPolicyError> {
    if metadata.maximum_context_tokens == 0 {
        return Err(ContextPolicyError::ZeroCapacity {
            field: "maximum_context_tokens",
        });
    }
    if metadata.context_window_tokens == 0 {
        return Err(ContextPolicyError::ZeroCapacity {
            field: "context_window_tokens",
        });
    }
    if metadata.context_window_tokens > metadata.maximum_context_tokens {
        return Err(ContextPolicyError::CapacityExceedsMaximum {
            field: "context_window_tokens",
            value: metadata.context_window_tokens,
            maximum: metadata.maximum_context_tokens,
        });
    }
    if let Some(hard) = metadata.hard_context_limit_tokens {
        if hard == 0 {
            return Err(ContextPolicyError::ZeroCapacity {
                field: "hard_context_limit_tokens",
            });
        }
        if hard > metadata.maximum_context_tokens {
            return Err(ContextPolicyError::CapacityExceedsMaximum {
                field: "hard_context_limit_tokens",
                value: hard,
                maximum: metadata.maximum_context_tokens,
            });
        }
    }
    let hard = metadata
        .hard_context_limit_tokens
        .unwrap_or(metadata.maximum_context_tokens);
    let normal = NORMAL_CONTEXT_TOKENS
        .min(hard)
        .min(metadata.context_window_tokens);
    let derived_margin = (normal / 20).max(1);
    let (margin, safety_margin_source) = match metadata.provider_safety_margin_tokens {
        Some(0) => {
            return Err(ContextPolicyError::InvalidSafetyMargin {
                value: 0,
                normal_window: normal,
            });
        }
        Some(provider) if provider >= normal => {
            return Err(ContextPolicyError::InvalidSafetyMargin {
                value: provider,
                normal_window: normal,
            });
        }
        Some(provider) if provider >= derived_margin => {
            (provider, SafetyMarginSource::ProviderMetadata)
        }
        _ => (derived_margin, SafetyMarginSource::DerivedPolicy),
    };
    if margin >= normal {
        return Err(ContextPolicyError::NoUsableWindow {
            normal_window: normal,
            safety_margin: margin,
        });
    }
    Ok(EffectiveContext {
        normal_window_tokens: normal,
        model_maximum_tokens: metadata.maximum_context_tokens,
        effective_hard_limit_tokens: hard,
        safety_margin_tokens: margin,
        safety_margin_source,
        compact_at_tokens: normal.saturating_sub(margin),
        constrained_below_normal: hard < NORMAL_CONTEXT_TOKENS
            || metadata.context_window_tokens < NORMAL_CONTEXT_TOKENS,
    })
}

/// Explicit failure when a required model is absent from the supported catalog.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AllocationError {
    RequiredModelUnavailable { required: ModelId },
    InvalidContextMetadata(ContextPolicyError),
}

impl std::fmt::Display for AllocationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RequiredModelUnavailable { required } => write!(
                f,
                "required model {} is absent from the supported catalog",
                required.as_str()
            ),
            Self::InvalidContextMetadata(error) => write!(f, "invalid context metadata: {error}"),
        }
    }
}
impl std::error::Error for AllocationError {}

/// Fully resolved model, effort, and context allocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelAllocation<'a> {
    pub model: ModelId,
    pub effort: ReasoningEffort,
    pub metadata: &'a ModelMetadata,
    pub context: EffectiveContext,
}

/// Resolve Root to Sol and every specialist to Luna; never substitute missing models.
pub fn allocate_model<'a>(
    role: RoleTask,
    profile: Profile,
    catalog: &'a [ModelMetadata],
) -> Result<ModelAllocation<'a>, AllocationError> {
    let policy = route_policy(role).expect("every RoleTask has policy");
    let model = if role == RoleTask::Root {
        ModelId::Gpt61Sol
    } else {
        ModelId::Gpt6Luna
    };
    let metadata = catalog
        .iter()
        .find(|entry| entry.id == model.as_str())
        .ok_or(AllocationError::RequiredModelUnavailable { required: model })?;
    Ok(ModelAllocation {
        model,
        effort: policy.effort(profile),
        context: effective_context(metadata).map_err(AllocationError::InvalidContextMetadata)?,
        metadata,
    })
}

/// Opaque stable identifier supplied by the runtime.
pub type Id = String;

/// Accepted state for one top-level user task.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Intent {
    pub id: Id,
    pub objective: String,
    pub accepted_scope: Vec<String>,
    pub requirements: Vec<String>,
    pub revision: u64,
}

/// Structured signals used for deterministic context relevance and write safety.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssignmentMetadata {
    /// Repository-relative owned paths. Writable work must provide at least one.
    pub ownership_paths: BTreeSet<String>,
    pub symbols: BTreeSet<String>,
    pub domains: BTreeSet<String>,
    pub dependencies: BTreeSet<Id>,
    pub related_assignments: BTreeSet<Id>,
    /// Work items this review must be independent from (e.g. the implementation being reviewed).
    pub independent_review_of: BTreeSet<Id>,
}

/// Persistable lifecycle state of one Assignment.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentStatus {
    Ready,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}
impl AssignmentStatus {
    /// Whether this state is terminal.
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

/// Persistable, typed Assignment contract and lifecycle record.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Assignment {
    pub id: Id,
    pub intent_id: Id,
    pub role: RoleTask,
    pub objective: String,
    pub bounded_scope: Vec<String>,
    pub constraints: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    pub required_evidence: Vec<String>,
    pub mutability: Mutability,
    pub metadata: AssignmentMetadata,
    pub status: AssignmentStatus,
    pub specialist_id: Option<Id>,
    pub result: Option<String>,
}

/// Idle specialist and metadata for its retained terminal context.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SpecialistContext {
    pub id: Id,
    pub idle: bool,
    pub last_role: Option<RoleTask>,
    pub last_assignment_id: Option<Id>,
    pub last_metadata: AssignmentMetadata,
    pub last_status: Option<AssignmentStatus>,
    /// Assignment IDs previously performed by this specialist, for reviewer independence.
    pub prior_assignment_ids: BTreeSet<Id>,
    /// Runtime-confirmed support for changing the specialist's prior Role.task contract.
    /// Refresh this from the live backend before selection after restoring persisted state.
    pub supports_role_rebinding: bool,
    /// Capabilities the live runtime can grant on this existing specialist thread.
    /// Refresh grants before selection; retained role identity alone establishes no grant.
    pub available_capabilities: BTreeSet<Capability>,
}

/// Complete persistable policy state. Deserialization validates the receiving edge.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "PersistedPolicyStateWire")]
pub struct PersistedPolicyState {
    pub intents: Vec<Intent>,
    pub assignments: Vec<Assignment>,
    pub specialists: Vec<SpecialistContext>,
}

#[derive(Deserialize)]
struct PersistedPolicyStateWire {
    intents: Vec<Intent>,
    assignments: Vec<Assignment>,
    specialists: Vec<SpecialistContext>,
}

impl TryFrom<PersistedPolicyStateWire> for PersistedPolicyState {
    type Error = LifecycleError;

    fn try_from(wire: PersistedPolicyStateWire) -> Result<Self, Self::Error> {
        let state = Self {
            intents: wire.intents,
            assignments: wire.assignments,
            specialists: wire.specialists,
        };
        validate_policy_state(&state)?;
        Ok(state)
    }
}

/// Lifecycle/dispatch validation failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LifecycleError {
    RootNotSpecialist,
    InvalidIdentifier {
        kind: &'static str,
        id: String,
    },
    DuplicateIdentifier {
        kind: &'static str,
        id: Id,
    },
    UnknownIntent {
        assignment: Id,
        intent: Id,
    },
    InconsistentAssignmentState {
        assignment: Id,
        state: AssignmentStatus,
    },
    RootAssignment(Id),
    InvalidOwnership {
        assignment: Id,
        path: String,
    },
    DuplicateOwnershipPath(Id),
    InvalidSpecialistOwnership {
        specialist: Id,
        path: String,
    },
    EmptyWriteOwnership(Id),
    DuplicateRunningSpecialist {
        specialist: Id,
    },
    RunningSpecialistMarkedIdle {
        specialist: Id,
    },
    BusySpecialistWithoutAssignment(Id),
    RunningSpecialistCapabilityMismatch {
        assignment: Id,
        specialist: Id,
    },
    UnknownSpecialist {
        assignment: Id,
        specialist: Id,
    },
    InvalidSpecialistHistory {
        specialist: Id,
        assignment: Id,
    },
    InvalidAssignmentReference {
        assignment: Id,
        referenced: Id,
    },
    DependencyCycle(Id),
    AssignmentNotTerminal(Id),
    DependencyNotSuccessful {
        assignment: Id,
        dependency: Id,
    },
    UnsafeConcurrentOwnership {
        assignment: Id,
        active_assignment: Id,
    },
    NotRunning(Id),
    RevisionOverflow(Id),
}
impl std::fmt::Display for LifecycleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for LifecycleError {}

/// Validate cross-record identifiers, lifecycle shape, ownership and runtime references.
///
/// Deserialization calls this automatically. Call it after in-memory edits before dispatch,
/// follow-up, or specialist selection. Nonexistent owned files are valid: path checks are
/// lexical and portable, and never canonicalize against the local filesystem.
pub fn validate_policy_state(state: &PersistedPolicyState) -> Result<(), LifecycleError> {
    let mut intent_ids = BTreeSet::new();
    for intent in &state.intents {
        validate_intent(intent)?;
        if !intent_ids.insert(intent.id.as_str()) {
            return Err(LifecycleError::DuplicateIdentifier {
                kind: "intent",
                id: intent.id.clone(),
            });
        }
        if intent.revision == 0 || intent.objective.trim().is_empty() {
            return Err(LifecycleError::InvalidIdentifier {
                kind: "intent state",
                id: intent.id.clone(),
            });
        }
    }

    let mut assignment_ids = BTreeSet::new();
    for assignment in &state.assignments {
        validate_assignment_shape(assignment)?;
        if !assignment_ids.insert(assignment.id.as_str()) {
            return Err(LifecycleError::DuplicateIdentifier {
                kind: "assignment",
                id: assignment.id.clone(),
            });
        }
        if assignment.role == RoleTask::Root {
            return Err(LifecycleError::RootAssignment(assignment.id.clone()));
        }
        validate_assignment_ownership(assignment)?;
        if !intent_ids.contains(assignment.intent_id.as_str()) {
            return Err(LifecycleError::UnknownIntent {
                assignment: assignment.id.clone(),
                intent: assignment.intent_id.clone(),
            });
        }
        if let Some(specialist) = &assignment.specialist_id
            && !state
                .specialists
                .iter()
                .any(|known| &known.id == specialist)
        {
            return Err(LifecycleError::UnknownSpecialist {
                assignment: assignment.id.clone(),
                specialist: specialist.clone(),
            });
        }
    }

    for assignment in &state.assignments {
        for reference in assignment
            .metadata
            .dependencies
            .iter()
            .chain(&assignment.metadata.related_assignments)
            .chain(&assignment.metadata.independent_review_of)
        {
            if reference == &assignment.id || !assignment_ids.contains(reference.as_str()) {
                return Err(LifecycleError::InvalidAssignmentReference {
                    assignment: assignment.id.clone(),
                    referenced: reference.clone(),
                });
            }
        }
        for dependency in &assignment.metadata.dependencies {
            let prerequisite = state
                .assignments
                .iter()
                .find(|a| &a.id == dependency)
                .expect("reference was checked");
            if prerequisite.intent_id != assignment.intent_id
                || prerequisite.status != AssignmentStatus::Succeeded
            {
                return Err(LifecycleError::DependencyNotSuccessful {
                    assignment: assignment.id.clone(),
                    dependency: dependency.clone(),
                });
            }
        }
    }

    let mut dependency_counts: std::collections::BTreeMap<&str, usize> = state
        .assignments
        .iter()
        .map(|a| (a.id.as_str(), a.metadata.dependencies.len()))
        .collect();
    let mut dependents: std::collections::BTreeMap<&str, Vec<&str>> =
        std::collections::BTreeMap::new();
    for assignment in &state.assignments {
        for dependency in &assignment.metadata.dependencies {
            dependents
                .entry(dependency)
                .or_default()
                .push(&assignment.id);
        }
    }
    let mut ready: std::collections::VecDeque<&str> = dependency_counts
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(*id))
        .collect();
    let mut visited = 0;
    while let Some(id) = ready.pop_front() {
        visited += 1;
        if let Some(next) = dependents.get(id) {
            for dependent in next {
                let count = dependency_counts
                    .get_mut(dependent)
                    .expect("references were validated");
                *count -= 1;
                if *count == 0 {
                    ready.push_back(dependent);
                }
            }
        }
    }
    if visited != dependency_counts.len() {
        let cycle = dependency_counts
            .iter()
            .find_map(|(id, count)| (*count > 0).then_some(*id))
            .unwrap_or("");
        return Err(LifecycleError::DependencyCycle(cycle.to_owned()));
    }

    let mut specialist_ids = BTreeSet::new();
    for specialist in &state.specialists {
        validate_specialist_context_shape(specialist)?;
        if !specialist_ids.insert(specialist.id.as_str()) {
            return Err(LifecycleError::DuplicateIdentifier {
                kind: "specialist",
                id: specialist.id.clone(),
            });
        }
        if let Some(previous_id) = &specialist.last_assignment_id {
            let previous = state
                .assignments
                .iter()
                .find(|a| &a.id == previous_id)
                .ok_or_else(|| LifecycleError::InvalidSpecialistHistory {
                    specialist: specialist.id.clone(),
                    assignment: previous_id.clone(),
                })?;
            if !previous.status.is_terminal()
                || previous.specialist_id.as_deref() != Some(specialist.id.as_str())
                || specialist.last_status != Some(previous.status)
                || specialist.last_role != Some(previous.role)
            {
                return Err(LifecycleError::InvalidSpecialistHistory {
                    specialist: specialist.id.clone(),
                    assignment: previous_id.clone(),
                });
            }
        } else if specialist.last_role.is_some() || specialist.last_status.is_some() {
            return Err(LifecycleError::InvalidSpecialistHistory {
                specialist: specialist.id.clone(),
                assignment: String::new(),
            });
        }
    }

    let mut active_specialists = BTreeSet::new();
    for assignment in state
        .assignments
        .iter()
        .filter(|a| a.status == AssignmentStatus::Running)
    {
        let specialist = assignment
            .specialist_id
            .as_deref()
            .expect("running shape was checked");
        if !specialist_ids.contains(specialist) {
            return Err(LifecycleError::UnknownSpecialist {
                assignment: assignment.id.clone(),
                specialist: specialist.to_owned(),
            });
        }
        if !active_specialists.insert(specialist) {
            return Err(LifecycleError::DuplicateRunningSpecialist {
                specialist: specialist.to_owned(),
            });
        }
        let context = state
            .specialists
            .iter()
            .find(|s| s.id == specialist)
            .expect("specialist was checked");
        if context.idle {
            return Err(LifecycleError::RunningSpecialistMarkedIdle {
                specialist: specialist.to_owned(),
            });
        }
        let required = route_policy(assignment.role).expect("registry covers specialist roles");
        if !required
            .capabilities
            .iter()
            .all(|capability| context.available_capabilities.contains(capability))
        {
            return Err(LifecycleError::RunningSpecialistCapabilityMismatch {
                assignment: assignment.id.clone(),
                specialist: specialist.to_owned(),
            });
        }
    }
    for specialist in &state.specialists {
        if !specialist.idle && !active_specialists.contains(specialist.id.as_str()) {
            return Err(LifecycleError::BusySpecialistWithoutAssignment(
                specialist.id.clone(),
            ));
        }
    }

    for assignment in state
        .assignments
        .iter()
        .filter(|a| a.status == AssignmentStatus::Running)
    {
        for other in state.assignments.iter().filter(|other| {
            other.status == AssignmentStatus::Running
                && other.id != assignment.id
                && other.mutability != Mutability::ReadOnly
        }) {
            if assignment.mutability != Mutability::ReadOnly
                && paths_overlap(
                    &assignment.metadata.ownership_paths,
                    &other.metadata.ownership_paths,
                )
            {
                return Err(LifecycleError::UnsafeConcurrentOwnership {
                    assignment: assignment.id.clone(),
                    active_assignment: other.id.clone(),
                });
            }
        }
    }

    Ok(())
}

fn validate_nonempty_id(kind: &'static str, id: &str) -> Result<(), LifecycleError> {
    if id.trim().is_empty() {
        Err(LifecycleError::InvalidIdentifier {
            kind,
            id: id.to_owned(),
        })
    } else {
        Ok(())
    }
}

fn validate_specialist_context_shape(specialist: &SpecialistContext) -> Result<(), LifecycleError> {
    validate_nonempty_id("specialist", &specialist.id)?;
    if specialist.idle
        && specialist
            .last_status
            .is_some_and(|status| !status.is_terminal())
    {
        return Err(LifecycleError::InvalidSpecialistHistory {
            specialist: specialist.id.clone(),
            assignment: specialist.last_assignment_id.clone().unwrap_or_default(),
        });
    }
    match (
        &specialist.last_assignment_id,
        specialist.last_role,
        specialist.last_status,
    ) {
        (None, None, None) => {}
        (Some(id), Some(_), Some(status)) if status.is_terminal() && !id.trim().is_empty() => {}
        _ => {
            return Err(LifecycleError::InvalidSpecialistHistory {
                specialist: specialist.id.clone(),
                assignment: specialist.last_assignment_id.clone().unwrap_or_default(),
            });
        }
    }
    for path in &specialist.last_metadata.ownership_paths {
        if normalize_ownership_path(path).is_none() {
            return Err(LifecycleError::InvalidSpecialistOwnership {
                specialist: specialist.id.clone(),
                path: path.clone(),
            });
        }
    }
    Ok(())
}

/// Check declared prerequisites and reject overlapping active write ownership.
pub fn validate_dispatch(
    candidate: &Assignment,
    assignments: &[Assignment],
) -> Result<(), LifecycleError> {
    if candidate.role == RoleTask::Root {
        return Err(LifecycleError::RootNotSpecialist);
    }
    validate_assignment_shape(candidate)?;
    if candidate.status != AssignmentStatus::Ready {
        return Err(LifecycleError::InconsistentAssignmentState {
            assignment: candidate.id.clone(),
            state: candidate.status,
        });
    }
    validate_assignment_ownership(candidate)?;
    let mut known_ids = BTreeSet::new();
    for assignment in assignments {
        validate_assignment_shape(assignment)?;
        validate_assignment_ownership(assignment)?;
        if !known_ids.insert(assignment.id.as_str()) {
            return Err(LifecycleError::DuplicateIdentifier {
                kind: "assignment",
                id: assignment.id.clone(),
            });
        }
    }
    if known_ids.contains(candidate.id.as_str()) {
        return Err(LifecycleError::DuplicateIdentifier {
            kind: "assignment",
            id: candidate.id.clone(),
        });
    }
    for referenced in candidate
        .metadata
        .related_assignments
        .iter()
        .chain(&candidate.metadata.independent_review_of)
    {
        if referenced == &candidate.id || !known_ids.contains(referenced.as_str()) {
            return Err(LifecycleError::InvalidAssignmentReference {
                assignment: candidate.id.clone(),
                referenced: referenced.clone(),
            });
        }
    }
    for dependency in &candidate.metadata.dependencies {
        match assignments.iter().find(|a| &a.id == dependency) {
            Some(a)
                if a.status == AssignmentStatus::Succeeded
                    && a.intent_id == candidate.intent_id => {}
            _ => {
                return Err(LifecycleError::DependencyNotSuccessful {
                    assignment: candidate.id.clone(),
                    dependency: dependency.clone(),
                });
            }
        }
    }
    if candidate.mutability != Mutability::ReadOnly {
        for active in assignments.iter().filter(|a| {
            a.status == AssignmentStatus::Running
                && a.id != candidate.id
                && a.mutability != Mutability::ReadOnly
        }) {
            if paths_overlap(
                &candidate.metadata.ownership_paths,
                &active.metadata.ownership_paths,
            ) {
                return Err(LifecycleError::UnsafeConcurrentOwnership {
                    assignment: candidate.id.clone(),
                    active_assignment: active.id.clone(),
                });
            }
        }
    }
    Ok(())
}

/// Validate dispatch against the accepted Intent, including its identity boundary.
pub fn validate_dispatch_for_intent(
    intent: &Intent,
    candidate: &Assignment,
    assignments: &[Assignment],
) -> Result<(), LifecycleError> {
    validate_intent(intent)?;
    if candidate.intent_id != intent.id {
        return Err(LifecycleError::UnknownIntent {
            assignment: candidate.id.clone(),
            intent: candidate.intent_id.clone(),
        });
    }
    validate_dispatch(candidate, assignments)
}

/// Validate the stable identifier, objective, and initialized revision of an Intent.
pub fn validate_intent(intent: &Intent) -> Result<(), LifecycleError> {
    validate_nonempty_id("intent", &intent.id)?;
    if intent.revision == 0 || intent.objective.trim().is_empty() {
        return Err(LifecycleError::InvalidIdentifier {
            kind: "intent state",
            id: intent.id.clone(),
        });
    }
    Ok(())
}

fn validate_assignment_shape(assignment: &Assignment) -> Result<(), LifecycleError> {
    validate_nonempty_id("assignment", &assignment.id)?;
    validate_nonempty_id("assignment intent", &assignment.intent_id)?;
    if assignment.role == RoleTask::Root {
        return Err(LifecycleError::RootAssignment(assignment.id.clone()));
    }
    if assignment.objective.trim().is_empty()
        || assignment
            .specialist_id
            .as_deref()
            .is_some_and(|id| id.trim().is_empty())
    {
        return Err(LifecycleError::InconsistentAssignmentState {
            assignment: assignment.id.clone(),
            state: assignment.status,
        });
    }
    let valid = match assignment.status {
        AssignmentStatus::Ready => {
            assignment.specialist_id.is_none() && assignment.result.is_none()
        }
        AssignmentStatus::Running => {
            assignment
                .specialist_id
                .as_deref()
                .is_some_and(|id| !id.trim().is_empty())
                && assignment.result.is_none()
        }
        AssignmentStatus::Succeeded | AssignmentStatus::Failed => {
            assignment
                .specialist_id
                .as_deref()
                .is_some_and(|id| !id.trim().is_empty())
                && assignment
                    .result
                    .as_deref()
                    .is_some_and(|result| !result.trim().is_empty())
        }
        AssignmentStatus::Cancelled => assignment
            .result
            .as_deref()
            .is_none_or(|result| !result.trim().is_empty()),
    };
    if !valid {
        return Err(LifecycleError::InconsistentAssignmentState {
            assignment: assignment.id.clone(),
            state: assignment.status,
        });
    }
    Ok(())
}

fn normalize_ownership_path(path: &str) -> Option<String> {
    if path.is_empty()
        || path
            .chars()
            .any(|c| matches!(c, '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return None;
    }
    let portable = path.replace('\\', "/");
    if portable.starts_with('/') {
        return None;
    }
    let components: Vec<_> = portable.split('/').collect();
    if components.iter().any(|part| {
        part.is_empty()
            || *part == "."
            || *part == ".."
            || part.ends_with('.')
            || part.ends_with(' ')
            || part.chars().any(char::is_control)
    }) {
        return None;
    }
    Some(components.join("/").to_lowercase())
}

fn validate_assignment_ownership(assignment: &Assignment) -> Result<(), LifecycleError> {
    if assignment.mutability != Mutability::ReadOnly
        && assignment.metadata.ownership_paths.is_empty()
    {
        return Err(LifecycleError::EmptyWriteOwnership(assignment.id.clone()));
    }
    let mut normalized = BTreeSet::new();
    for path in &assignment.metadata.ownership_paths {
        let Some(path_key) = normalize_ownership_path(path) else {
            return Err(LifecycleError::InvalidOwnership {
                assignment: assignment.id.clone(),
                path: path.clone(),
            });
        };
        if !normalized.insert(path_key) {
            return Err(LifecycleError::DuplicateOwnershipPath(
                assignment.id.clone(),
            ));
        }
    }
    Ok(())
}

fn paths_overlap(left: &BTreeSet<String>, right: &BTreeSet<String>) -> bool {
    let left: Vec<_> = left
        .iter()
        .filter_map(|path| normalize_ownership_path(path))
        .collect();
    let right: Vec<_> = right
        .iter()
        .filter_map(|path| normalize_ownership_path(path))
        .collect();
    left.iter().any(|a| {
        right
            .iter()
            .any(|b| a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/")))
    })
}

/// Selection result in relevance, same-role, new-specialist priority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SpecialistSelection {
    Reuse {
        specialist_id: Id,
        reason: ReuseReason,
    },
    CreateNew,
}
/// Deterministic warm reuse reason.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReuseReason {
    RelevantContext,
    SameRole,
}

/// Pick a safe idle specialist, preferring relevant context over role identity.
pub fn select_specialist(
    candidate: &Assignment,
    assignments: &[Assignment],
    specialists: &[SpecialistContext],
) -> Result<SpecialistSelection, LifecycleError> {
    validate_dispatch(candidate, assignments)?;
    let route = route_policy(candidate.role).expect("every RoleTask has policy");
    let mut specialist_ids = BTreeSet::new();
    for specialist in specialists {
        validate_specialist_context_shape(specialist)?;
        if !specialist_ids.insert(specialist.id.as_str()) {
            return Err(LifecycleError::DuplicateIdentifier {
                kind: "specialist",
                id: specialist.id.clone(),
            });
        }
    }
    let safe: Vec<_> = specialists
        .iter()
        .filter(|s| {
            s.idle
                && s.last_status.is_none_or(AssignmentStatus::is_terminal)
                && specialist_compatible(candidate, route, s)
                && (!route
                    .independence
                    .contains(&IndependenceRequirement::IndependentReview)
                    || independent_from(candidate, s))
        })
        .collect();
    if let Some(s) = safe
        .iter()
        .copied()
        .filter(|s| context_relevant(candidate, s))
        .min_by_key(|s| s.id.clone())
    {
        return Ok(SpecialistSelection::Reuse {
            specialist_id: s.id.clone(),
            reason: ReuseReason::RelevantContext,
        });
    }
    if let Some(s) = safe
        .into_iter()
        .filter(|s| s.last_role == Some(candidate.role))
        .min_by_key(|s| s.id.clone())
    {
        return Ok(SpecialistSelection::Reuse {
            specialist_id: s.id.clone(),
            reason: ReuseReason::SameRole,
        });
    }
    Ok(SpecialistSelection::CreateNew)
}

fn independent_from(candidate: &Assignment, specialist: &SpecialistContext) -> bool {
    specialist
        .prior_assignment_ids
        .is_disjoint(&candidate.metadata.independent_review_of)
        && specialist
            .last_assignment_id
            .as_ref()
            .is_none_or(|id| !candidate.metadata.independent_review_of.contains(id))
}

/// Check runtime-confirmed role rebinding and capability grant compatibility.
pub fn specialist_compatible(
    candidate: &Assignment,
    route: &RoutePolicy,
    specialist: &SpecialistContext,
) -> bool {
    if candidate.role == RoleTask::Root
        || candidate.status != AssignmentStatus::Ready
        || route.role != candidate.role
    {
        return false;
    }
    let role_compatible = match specialist.last_role {
        None => true,
        Some(previous) if previous == candidate.role => true,
        Some(_) => specialist.supports_role_rebinding,
    };
    role_compatible
        && route
            .capabilities
            .iter()
            .all(|capability| specialist.available_capabilities.contains(capability))
}

fn context_relevant(candidate: &Assignment, specialist: &SpecialistContext) -> bool {
    let related = specialist
        .last_assignment_id
        .as_ref()
        .is_some_and(|id| candidate.metadata.related_assignments.contains(id));
    let previous = &specialist.last_metadata;
    related
        || paths_overlap(
            &candidate.metadata.ownership_paths,
            &previous.ownership_paths,
        )
        || intersects(&candidate.metadata.symbols, &previous.symbols)
        || intersects(&candidate.metadata.domains, &previous.domains)
}
fn intersects(a: &BTreeSet<String>, b: &BTreeSet<String>) -> bool {
    a.iter().any(|item| b.contains(item))
}

/// Require terminal completion before follow-up/rebinding of a retained specialist.
pub fn validate_followup(assignment: &Assignment) -> Result<(), LifecycleError> {
    validate_assignment_shape(assignment)?;
    if assignment.status.is_terminal() {
        Ok(())
    } else {
        Err(LifecycleError::AssignmentNotTerminal(assignment.id.clone()))
    }
}

/// Finish a running Assignment with a terminal result.
pub fn finish_assignment(
    assignment: &mut Assignment,
    result: impl Into<String>,
    success: bool,
) -> Result<(), LifecycleError> {
    if assignment.status != AssignmentStatus::Running {
        return Err(LifecycleError::NotRunning(assignment.id.clone()));
    }
    validate_assignment_shape(assignment)?;
    let result = result.into();
    if result.trim().is_empty() {
        return Err(LifecycleError::InconsistentAssignmentState {
            assignment: assignment.id.clone(),
            state: assignment.status,
        });
    }
    assignment.status = if success {
        AssignmentStatus::Succeeded
    } else {
        AssignmentStatus::Failed
    };
    assignment.result = Some(result);
    Ok(())
}

/// Update accepted Intent facts and advance its revision only when material state changes.
pub fn update_intent(
    intent: &mut Intent,
    objective: String,
    accepted_scope: Vec<String>,
    requirements: Vec<String>,
) -> Result<bool, LifecycleError> {
    validate_intent(intent)?;
    if objective.trim().is_empty() {
        return Err(LifecycleError::InvalidIdentifier {
            kind: "intent state",
            id: intent.id.clone(),
        });
    }
    if intent.objective == objective
        && intent.accepted_scope == accepted_scope
        && intent.requirements == requirements
    {
        return Ok(false);
    }
    let revision = intent
        .revision
        .checked_add(1)
        .ok_or_else(|| LifecycleError::RevisionOverflow(intent.id.clone()))?;
    intent.objective = objective;
    intent.accepted_scope = accepted_scope;
    intent.requirements = requirements;
    intent.revision = revision;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model(id: &str, cap: u32, hard: Option<u32>) -> ModelMetadata {
        ModelMetadata {
            id: id.into(),
            context_window_tokens: cap,
            maximum_context_tokens: cap,
            hard_context_limit_tokens: hard,
            provider_safety_margin_tokens: None,
        }
    }
    fn assignment(
        id: &str,
        role: RoleTask,
        status: AssignmentStatus,
        path: &str,
        dependencies: &[&str],
    ) -> Assignment {
        let specialist_id = (status != AssignmentStatus::Ready).then(|| "agent".to_owned());
        let result = match status {
            AssignmentStatus::Succeeded => Some("completed".to_owned()),
            AssignmentStatus::Failed => Some("failed".to_owned()),
            _ => None,
        };
        Assignment {
            id: id.into(),
            intent_id: "i".into(),
            role,
            objective: "work".into(),
            bounded_scope: vec![path.into()],
            constraints: vec![],
            acceptance_criteria: vec![],
            required_evidence: vec![],
            mutability: Mutability::ScopedWrite,
            metadata: AssignmentMetadata {
                ownership_paths: [path.into()].into(),
                dependencies: dependencies.iter().map(|s| (*s).into()).collect(),
                ..Default::default()
            },
            status,
            specialist_id,
            result,
        }
    }

    #[test]
    fn registry_and_profile_efforts_are_exact() {
        assert_eq!(specialist_registry().len(), 18);
        assert_eq!(RoleTask::SPECIALISTS.len(), 18);
        assert_eq!(
            RoleTask::parse("Worker.visual"),
            Some(RoleTask::WorkerVisual)
        );
        assert_eq!(
            route_policy(RoleTask::WorkerValidation)
                .unwrap()
                .effort(Profile::Low),
            ReasoningEffort::Medium
        );
        assert_eq!(
            route_policy(RoleTask::WorkerValidation)
                .unwrap()
                .effort(Profile::Default),
            ReasoningEffort::High
        );
        assert_eq!(
            route_policy(RoleTask::ExplorerTrace)
                .unwrap()
                .effort(Profile::Low),
            ReasoningEffort::High
        );
    }

    #[test]
    fn defaults_and_model_allocation_fail_explicitly() {
        let defaults = PolicyConfig::default();
        assert!(defaults.browser_use && defaults.sites);
        assert!(!defaults.computer_use && !defaults.session_audit && !defaults.auto_reset);
        let catalog = [
            model("gpt-6.1-sol", 400_000, None),
            model("gpt-6-luna", 400_000, None),
        ];
        let root = allocate_model(RoleTask::Root, Profile::High, &catalog).unwrap();
        assert_eq!(
            (root.model, root.effort),
            (ModelId::Gpt61Sol, ReasoningEffort::Medium)
        );
        assert_eq!(
            allocate_model(RoleTask::WorkerDebugging, Profile::Low, &catalog)
                .unwrap()
                .model,
            ModelId::Gpt6Luna
        );
        assert!(matches!(
            allocate_model(RoleTask::Root, Profile::Default, &catalog[1..]),
            Err(AllocationError::RequiredModelUnavailable {
                required: ModelId::Gpt61Sol
            })
        ));
    }

    #[test]
    fn context_preserves_max_and_derives_safety_margin() {
        let effective = effective_context(&model("gpt-6-luna", 400_000, None)).unwrap();
        assert_eq!(effective.normal_window_tokens, 372_000);
        assert_eq!(effective.model_maximum_tokens, 400_000);
        assert_eq!(effective.safety_margin_tokens, 18_600);
        assert_eq!(
            effective.safety_margin_source,
            SafetyMarginSource::DerivedPolicy
        );
        assert_eq!(effective.compact_at_tokens, 353_400);
        let constrained = effective_context(&model("gpt-6-luna", 400_000, Some(320_000))).unwrap();
        assert_eq!(constrained.normal_window_tokens, 320_000);
        assert_eq!(constrained.model_maximum_tokens, 400_000);
        assert!(constrained.constrained_below_normal);
        let mut provider_margin = model("gpt-6-luna", 400_000, None);
        provider_margin.provider_safety_margin_tokens = Some(20_000);
        assert_eq!(
            effective_context(&provider_margin)
                .unwrap()
                .safety_margin_source,
            SafetyMarginSource::ProviderMetadata
        );
    }

    #[test]
    fn context_rejects_fabricated_zero_capacity_and_invalid_constraints() {
        let mut zero = model("gpt-6-luna", 400_000, None);
        zero.context_window_tokens = 0;
        assert_eq!(
            effective_context(&zero),
            Err(ContextPolicyError::ZeroCapacity {
                field: "context_window_tokens"
            })
        );
        assert!(matches!(
            effective_context(&model("gpt-6-luna", 400_000, Some(0))),
            Err(ContextPolicyError::ZeroCapacity {
                field: "hard_context_limit_tokens"
            })
        ));
        let mut invalid_margin = model("gpt-6-luna", 400_000, None);
        invalid_margin.provider_safety_margin_tokens = Some(400_000);
        assert!(matches!(
            effective_context(&invalid_margin),
            Err(ContextPolicyError::InvalidSafetyMargin { .. })
        ));
    }

    #[test]
    fn selection_uses_relevant_context_before_same_role_then_creates() {
        let next = assignment(
            "new",
            RoleTask::WorkerDebugging,
            AssignmentStatus::Ready,
            "src/policy",
            &[],
        );
        let relevant = SpecialistContext {
            id: "a".into(),
            idle: true,
            last_role: Some(RoleTask::ExplorerTrace),
            last_assignment_id: Some("old".into()),
            last_metadata: AssignmentMetadata {
                ownership_paths: ["src/policy".into()].into(),
                ..Default::default()
            },
            last_status: Some(AssignmentStatus::Succeeded),
            prior_assignment_ids: BTreeSet::new(),
            supports_role_rebinding: true,
            available_capabilities: [Capability::RepositoryRead, Capability::FilesystemWrite]
                .into(),
        };
        let same_role = SpecialistContext {
            id: "b".into(),
            idle: true,
            last_role: Some(RoleTask::WorkerDebugging),
            last_assignment_id: Some("old-b".into()),
            last_metadata: Default::default(),
            last_status: Some(AssignmentStatus::Succeeded),
            prior_assignment_ids: BTreeSet::new(),
            supports_role_rebinding: false,
            available_capabilities: [Capability::RepositoryRead, Capability::FilesystemWrite]
                .into(),
        };
        assert_eq!(
            select_specialist(&next, &[], &[same_role.clone(), relevant]).unwrap(),
            SpecialistSelection::Reuse {
                specialist_id: "a".into(),
                reason: ReuseReason::RelevantContext
            }
        );
        assert_eq!(
            select_specialist(&next, &[], &[same_role]).unwrap(),
            SpecialistSelection::Reuse {
                specialist_id: "b".into(),
                reason: ReuseReason::SameRole
            }
        );
        assert_eq!(
            select_specialist(&next, &[], &[]).unwrap(),
            SpecialistSelection::CreateNew
        );
    }

    #[test]
    fn terminal_followup_dependency_and_write_safety_are_enforced() {
        let running = assignment(
            "a",
            RoleTask::WorkerImplementation,
            AssignmentStatus::Running,
            "src/lib",
            &[],
        );
        assert_eq!(
            validate_followup(&running),
            Err(LifecycleError::AssignmentNotTerminal("a".into()))
        );
        let dependent = assignment(
            "b",
            RoleTask::WorkerValidation,
            AssignmentStatus::Ready,
            "tests",
            &["a"],
        );
        assert!(matches!(
            validate_dispatch(&dependent, std::slice::from_ref(&running)),
            Err(LifecycleError::DependencyNotSuccessful { .. })
        ));
        let overlapping = assignment(
            "c",
            RoleTask::WorkerImplementation,
            AssignmentStatus::Ready,
            "src/lib/module",
            &[],
        );
        assert!(matches!(
            validate_dispatch(&overlapping, &[running]),
            Err(LifecycleError::UnsafeConcurrentOwnership { .. })
        ));
        let mut finishing = assignment(
            "done",
            RoleTask::WorkerImplementation,
            AssignmentStatus::Running,
            "src/lib",
            &[],
        );
        finish_assignment(&mut finishing, "ok", true).unwrap();
        assert_eq!(finishing.status, AssignmentStatus::Succeeded);
        assert_eq!(finishing.result.as_deref(), Some("ok"));
        validate_followup(&finishing).unwrap();
    }

    #[test]
    fn ownership_is_component_validated_casefolded_and_filesystem_independent() {
        let candidate = assignment(
            "new",
            RoleTask::WorkerImplementation,
            AssignmentStatus::Ready,
            "src/lib/module-not-yet-created",
            &[],
        );
        let active = assignment(
            "active",
            RoleTask::WorkerImplementation,
            AssignmentStatus::Running,
            "SRC\\LIB",
            &[],
        );
        assert!(matches!(
            validate_dispatch(&candidate, &[active]),
            Err(LifecycleError::UnsafeConcurrentOwnership { .. })
        ));

        let mut traversal = assignment(
            "bad",
            RoleTask::WorkerImplementation,
            AssignmentStatus::Ready,
            "src/../outside",
            &[],
        );
        assert!(matches!(
            validate_dispatch(&traversal, &[]),
            Err(LifecycleError::InvalidOwnership { .. })
        ));
        traversal.metadata.ownership_paths.clear();
        assert_eq!(
            validate_dispatch(&traversal, &[]),
            Err(LifecycleError::EmptyWriteOwnership("bad".into()))
        );

        let mut aliases = assignment(
            "aliases",
            RoleTask::WorkerImplementation,
            AssignmentStatus::Ready,
            "src/lib",
            &[],
        );
        aliases.metadata.ownership_paths.insert("SRC\\LIB".into());
        assert_eq!(
            validate_dispatch(&aliases, &[]),
            Err(LifecycleError::DuplicateOwnershipPath("aliases".into()))
        );
    }

    #[test]
    fn reuse_requires_runtime_rebinding_grant_and_required_capabilities() {
        let candidate = assignment(
            "next",
            RoleTask::WorkerDebugging,
            AssignmentStatus::Ready,
            "src/policy",
            &[],
        );
        let mut context = SpecialistContext {
            id: "agent".into(),
            idle: true,
            last_role: Some(RoleTask::ExplorerTrace),
            last_assignment_id: Some("previous".into()),
            last_metadata: AssignmentMetadata {
                ownership_paths: ["src/policy".into()].into(),
                ..Default::default()
            },
            last_status: Some(AssignmentStatus::Succeeded),
            prior_assignment_ids: BTreeSet::new(),
            supports_role_rebinding: false,
            available_capabilities: [Capability::RepositoryRead, Capability::FilesystemWrite]
                .into(),
        };
        assert_eq!(
            select_specialist(&candidate, &[], &[context.clone()]).unwrap(),
            SpecialistSelection::CreateNew
        );
        context.supports_role_rebinding = true;
        assert!(matches!(
            select_specialist(&candidate, &[], &[context.clone()]).unwrap(),
            SpecialistSelection::Reuse {
                reason: ReuseReason::RelevantContext,
                ..
            }
        ));
        context.available_capabilities.clear();
        assert_eq!(
            select_specialist(&candidate, &[], &[context]).unwrap(),
            SpecialistSelection::CreateNew
        );
    }

    #[test]
    fn intent_and_assignment_are_typed_persistable_records() {
        let mut intent = Intent {
            id: "i1".into(),
            objective: "goal".into(),
            accepted_scope: vec!["crate".into()],
            requirements: vec![],
            revision: 1,
        };
        assert!(!update_intent(&mut intent, "goal".into(), vec!["crate".into()], vec![]).unwrap());
        assert!(
            update_intent(&mut intent, "new goal".into(), vec!["crate".into()], vec![]).unwrap()
        );
        assert_eq!(intent.revision, 2);
        let encoded = serde_json::to_string(&intent).unwrap();
        assert_eq!(serde_json::from_str::<Intent>(&encoded).unwrap(), intent);
        let task = assignment(
            "a",
            RoleTask::WorkerImplementation,
            AssignmentStatus::Ready,
            "crate",
            &[],
        );
        assert_eq!(
            serde_json::from_str::<Assignment>(&serde_json::to_string(&task).unwrap()).unwrap(),
            task
        );
    }

    #[test]
    fn persisted_state_rejects_duplicate_ids_and_inconsistent_lifecycle_records() {
        let intent = Intent {
            id: "i".into(),
            objective: "goal".into(),
            accepted_scope: vec!["crate".into()],
            requirements: vec![],
            revision: 1,
        };
        let task = assignment(
            "a",
            RoleTask::WorkerImplementation,
            AssignmentStatus::Ready,
            "src/new-file.rs",
            &[],
        );
        let valid = PersistedPolicyState {
            intents: vec![intent.clone()],
            assignments: vec![task.clone()],
            specialists: vec![],
        };
        assert_eq!(validate_policy_state(&valid), Ok(()));
        let encoded = serde_json::to_string(&valid).unwrap();
        assert_eq!(
            serde_json::from_str::<PersistedPolicyState>(&encoded).unwrap(),
            valid
        );

        let mut duplicate = valid.clone();
        duplicate.assignments.push(task.clone());
        assert!(
            serde_json::from_str::<PersistedPolicyState>(
                &serde_json::to_string(&duplicate).unwrap()
            )
            .is_err()
        );
        assert!(matches!(
            validate_policy_state(&duplicate),
            Err(LifecycleError::DuplicateIdentifier {
                kind: "assignment",
                ..
            })
        ));

        let mut broken = task;
        broken.result = Some("premature".into());
        let invalid = PersistedPolicyState {
            intents: vec![intent],
            assignments: vec![broken],
            specialists: vec![],
        };
        assert!(matches!(
            validate_policy_state(&invalid),
            Err(LifecycleError::InconsistentAssignmentState { .. })
        ));

        let mut missing_intent = assignment(
            "missing-intent",
            RoleTask::WorkerImplementation,
            AssignmentStatus::Ready,
            "src/file",
            &[],
        );
        missing_intent.intent_id = "absent".into();
        let invalid = PersistedPolicyState {
            intents: vec![Intent {
                id: "i".into(),
                objective: "goal".into(),
                accepted_scope: vec![],
                requirements: vec![],
                revision: 1,
            }],
            assignments: vec![missing_intent],
            specialists: vec![],
        };
        assert!(matches!(
            validate_policy_state(&invalid),
            Err(LifecycleError::UnknownIntent { .. })
        ));
    }

    #[test]
    fn persisted_running_assignments_require_unique_nonidle_specialists() {
        let intent = Intent {
            id: "i".into(),
            objective: "goal".into(),
            accepted_scope: vec![],
            requirements: vec![],
            revision: 1,
        };
        let first = assignment(
            "a",
            RoleTask::WorkerImplementation,
            AssignmentStatus::Running,
            "src/a",
            &[],
        );
        let specialist = SpecialistContext {
            id: "agent".into(),
            idle: false,
            last_role: None,
            last_assignment_id: None,
            last_metadata: AssignmentMetadata::default(),
            last_status: None,
            prior_assignment_ids: BTreeSet::new(),
            supports_role_rebinding: false,
            available_capabilities: [Capability::RepositoryRead, Capability::FilesystemWrite]
                .into(),
        };
        let valid = PersistedPolicyState {
            intents: vec![intent.clone()],
            assignments: vec![first.clone()],
            specialists: vec![specialist.clone()],
        };
        assert_eq!(validate_policy_state(&valid), Ok(()));

        let second = assignment(
            "b",
            RoleTask::WorkerImplementation,
            AssignmentStatus::Running,
            "src/b",
            &[],
        );
        let duplicate_use = PersistedPolicyState {
            intents: vec![intent.clone()],
            assignments: vec![first.clone(), second],
            specialists: vec![specialist.clone()],
        };
        assert!(matches!(
            validate_policy_state(&duplicate_use),
            Err(LifecycleError::DuplicateRunningSpecialist { .. })
        ));

        let mut idle = specialist;
        idle.idle = true;
        let inconsistent = PersistedPolicyState {
            intents: vec![intent],
            assignments: vec![first],
            specialists: vec![idle],
        };
        assert!(matches!(
            validate_policy_state(&inconsistent),
            Err(LifecycleError::RunningSpecialistMarkedIdle { .. })
        ));
    }

    #[test]
    fn intent_revision_overflow_is_reported_without_mutation() {
        let mut intent = Intent {
            id: "i".into(),
            objective: "before".into(),
            accepted_scope: vec![],
            requirements: vec![],
            revision: u64::MAX,
        };
        assert_eq!(
            update_intent(&mut intent, "after".into(), vec![], vec![]),
            Err(LifecycleError::RevisionOverflow("i".into()))
        );
        assert_eq!(intent.objective, "before");
        assert_eq!(intent.revision, u64::MAX);
    }

    #[test]
    fn reviewer_reuse_excludes_prior_contributors_to_reviewed_work() {
        let mut review = assignment(
            "review",
            RoleTask::ReviewerCode,
            AssignmentStatus::Ready,
            "review-notes",
            &[],
        );
        review
            .metadata
            .independent_review_of
            .insert("implementation".into());
        let reviewer = SpecialistContext {
            id: "reviewer".into(),
            idle: true,
            last_role: Some(RoleTask::WorkerImplementation),
            last_assignment_id: Some("implementation".into()),
            last_metadata: Default::default(),
            last_status: Some(AssignmentStatus::Succeeded),
            prior_assignment_ids: ["implementation".into()].into(),
            supports_role_rebinding: true,
            available_capabilities: [Capability::RepositoryRead].into(),
        };
        let target = assignment(
            "implementation",
            RoleTask::WorkerImplementation,
            AssignmentStatus::Succeeded,
            "src/policy",
            &[],
        );
        assert_eq!(
            select_specialist(&review, &[target], &[reviewer]).unwrap(),
            SpecialistSelection::CreateNew
        );
    }
}
