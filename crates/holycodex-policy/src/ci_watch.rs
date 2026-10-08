//! Host-side CI reconciliation boundary, not a provider client or scheduler.
//!
//! Event payloads are wake-ups only. The host must read authoritative current
//! PR/check/review state and re-read the head before accepting a snapshot.
//! No GitHub event name/schema is assumed here; absent discovery means polling.

use serde::Serialize;

/// A provider event contract discovered and validated by the existing host.
/// Construct only from a supported provider capability/schema response, never
/// from a guessed event name or an unrelated automation webhook contract.
pub struct EventContract<A> {
    /// Exact provider-published name.
    pub name: String,
    /// Arguments validated against that provider's schema and requested scope.
    pub arguments: A,
}

/// Exact parameter envelope of pinned upstream mcpServer/event/stream/start.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStart<A> {
    /// Existing subscribed thread, not a new background session.
    pub thread_id: String,
    /// Upstream only permits hosted apps.
    pub server: &'static str,
    /// Connection-local identity chosen by the host.
    pub subscription_id: String,
    /// Provider-discovered event name.
    pub name: String,
    /// Provider-validated arguments, unchanged.
    pub arguments: A,
    /// Optional upstream metadata; this boundary does not create grants.
    #[serde(rename = "_meta")]
    pub meta: Option<A>,
}

/// Prepare an existing-host request only when all runtime prerequisites hold.
/// The caller sends it over upstream transport and owns stop/disconnect cleanup.
pub fn stream_start<A>(
    experimental_enabled: bool,
    thread_subscribed: bool,
    thread_id: &str,
    subscription_id: &str,
    contract: Option<EventContract<A>>,
) -> Option<StreamStart<A>> {
    if !experimental_enabled
        || !thread_subscribed
        || thread_id.is_empty()
        || subscription_id.is_empty()
    {
        return None;
    }
    let contract = contract?;
    if contract.name.trim().is_empty() {
        return None;
    }
    Some(StreamStart {
        thread_id: thread_id.into(),
        server: "codex_apps",
        subscription_id: subscription_id.into(),
        name: contract.name,
        arguments: contract.arguments,
        meta: None,
    })
}

/// Authoritative gate result. Missing/inaccessible data is Unknown, not success.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    /// Still running or awaiting review.
    Pending,
    /// Explicitly satisfied by current authoritative data.
    Passed,
    /// Explicit terminal failure or relevant blocking review.
    Failed,
    /// Cannot establish the gate or its required scope.
    Unknown,
}

/// GitHub's selected check source, determined by its current PR checks state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckSource {
    /// Used when the current test merge commit has no status.
    Head,
    /// Used when GitHub selects statuses on its synthetic test merge commit.
    TestMerge,
}

/// Check target observed independently of the branch head.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckTarget {
    /// Current SHA selected by GitHub, not merely a run's advertised head_sha.
    pub sha: String,
    /// Authoritative selection, not inferred just from existence of a merge SHA.
    pub source: CheckSource,
}

/// Normalized provider observation, not an invented provider API.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckState {
    /// Running/queued required job or status.
    Pending,
    /// No required status because the workflow was filtered out.
    WorkflowFiltered,
    /// Explicit completed success.
    CompletedSuccess,
    /// Explicit completed skipped conclusion, accepted by GitHub protection.
    CompletedSkipped,
    /// Explicit completed neutral conclusion, accepted by GitHub protection.
    CompletedNeutral,
    /// Completed failure, cancellation, timeout or other non-success conclusion.
    CompletedFailure,
    /// State/coverage inaccessible or unrecognized.
    Unknown,
}

impl CheckState {
    /// Branch protection uses GitHub's semantics; filtered workflows stay pending.
    pub fn protection(self) -> Gate {
        match self {
            Self::CompletedSuccess | Self::CompletedSkipped | Self::CompletedNeutral => {
                Gate::Passed
            }
            Self::Pending | Self::WorkflowFiltered => Gate::Pending,
            Self::CompletedFailure => Gate::Failed,
            Self::Unknown => Gate::Unknown,
        }
    }

    /// Conservative project execution evidence. Even completed success requires
    /// logs/artifacts to prove actual validation; a conclusion alone is insufficient.
    pub fn execution(self) -> Gate {
        match self {
            Self::Pending | Self::WorkflowFiltered => Gate::Pending,
            Self::CompletedFailure => Gate::Failed,
            _ => Gate::Unknown,
        }
    }
}

/// Complete, normalized current-head observation made by the host.
pub struct Snapshot {
    /// Head observed before fetching gates.
    pub head_sha: String,
    /// Head re-read after fetching gates; mismatch invalidates the snapshot.
    pub confirmed_head_sha: String,
    /// GitHub-selected current head/test-merge check target. None is unverified.
    pub check_target: Option<CheckTarget>,
    /// Re-read selection after fetching gates; a base update can change this
    /// target even when the PR branch head did not change.
    pub confirmed_check_target: Option<CheckTarget>,
    /// Required protection checks for that selected SHA. None means requirements unknown.
    /// Some(empty) is valid only when the host verified no checks are required.
    pub required_checks: Option<Vec<Gate>>,
    /// Relevant current-head review/thread requirements, not historical approvals.
    pub reviews: Gate,
    /// Separate stricter project acceptance, backed by actual execution evidence.
    /// Skipped/neutral conclusions alone must not set this to Passed.
    pub project_validation: Gate,
}

/// Result to report. Passed means observed gates, never permission to merge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Need a fresh authoritative read.
    Reconcile,
    /// Gate coverage or permissions remain unknown.
    Unverified,
    /// Current gates still pending.
    Waiting,
    /// Current gates have a terminal failure.
    Failed,
    /// All known gates satisfied for their confirmed scope, never merge authority.
    Passed,
}

/// Event availability. Polling fallback is owned by the existing host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    /// Absent capability, stream not active, error, or disconnect.
    Polling,
    /// Verified upstream subscription has reported active.
    Events,
}

/// A bounded in-memory reconciliation policy for one host-scoped PR.
/// No credentials, network, event payload interpretation, clock or persistence.
pub struct CiWatch {
    subscription_id: String,
    generation: u64,
    connection_epoch: u64,
    transport: Transport,
    outcome: Outcome,
    acceptance: Outcome,
    head_sha: Option<String>,
    check_target: Option<CheckTarget>,
}

impl CiWatch {
    /// Begin with a required baseline read and polling fallback.
    pub fn new(subscription_id: String) -> Self {
        Self {
            subscription_id,
            generation: 0,
            connection_epoch: 0,
            transport: Transport::Polling,
            outcome: Outcome::Reconcile,
            acceptance: Outcome::Reconcile,
            head_sha: None,
            check_target: None,
        }
    }

    /// Handle the pinned upstream envelope after a verified subscription starts.
    /// Delayed/repeated/out-of-order provider payloads cannot install gate state.
    /// Ignore other subscriptions and unknown non-event notification methods.
    pub fn notification(&mut self, connection_epoch: u64, subscription_id: &str, method: &str) {
        if connection_epoch != self.connection_epoch
            || subscription_id != self.subscription_id
            || !method.starts_with("notifications/events/")
        {
            return;
        }
        match method {
            "notifications/events/active" => self.transport = Transport::Events,
            "notifications/events/terminated" => {
                self.unavailable();
                return;
            }
            _ => {}
        }
        self.invalidate();
    }

    /// Stream error, client disconnect, or capability loss: do not retain green.
    pub fn unavailable(&mut self) {
        self.connection_epoch = self
            .connection_epoch
            .checked_add(1)
            .expect("CI connection epoch exhausted");
        self.transport = Transport::Polling;
        self.invalidate();
    }

    /// Capture for callbacks from a verified current connection; stale epochs are ignored.
    pub fn connection_epoch(&self) -> u64 {
        self.connection_epoch
    }

    /// Start a polling/periodic safety read or a read after an event wake-up.
    /// Token invalidates any previously in-flight read.
    pub fn begin_read(&mut self) -> u64 {
        self.invalidate();
        self.generation
    }

    /// Accept only a coherent complete read with no intervening wake-up/read.
    pub fn reconcile(&mut self, token: u64, snapshot: Snapshot) -> bool {
        if token != self.generation
            || snapshot.head_sha.is_empty()
            || snapshot.head_sha != snapshot.confirmed_head_sha
            || snapshot.check_target != snapshot.confirmed_check_target
            || snapshot.check_target.as_ref().is_some_and(|target| {
                target.sha.is_empty()
                    || (target.source == CheckSource::Head && target.sha != snapshot.head_sha)
            })
        {
            return false;
        }
        self.head_sha = Some(snapshot.head_sha);
        self.check_target = snapshot.check_target;
        self.outcome = match snapshot
            .required_checks
            .filter(|_| self.check_target.is_some())
        {
            None => aggregate(&[Gate::Unknown, snapshot.reviews]),
            Some(mut gates) => {
                gates.push(snapshot.reviews);
                aggregate(&gates)
            }
        };
        let protection = match self.outcome {
            Outcome::Passed => Gate::Passed,
            Outcome::Failed => Gate::Failed,
            Outcome::Waiting => Gate::Pending,
            _ => Gate::Unknown,
        };
        self.acceptance = aggregate(&[protection, snapshot.project_validation]);
        // A completed read token is single-use, including duplicate responses.
        self.generation = self
            .generation
            .checked_add(1)
            .expect("CI read generation exhausted");
        true
    }

    /// GitHub protection/review result, distinct from physical project acceptance.
    pub fn outcome(&self) -> Outcome {
        self.outcome
    }
    /// Stricter project acceptance, never inferred from skipped/neutral checks.
    pub fn acceptance(&self) -> Outcome {
        self.acceptance
    }
    /// Current selected check source/SHA, which may differ from the branch head.
    pub fn check_target(&self) -> Option<&CheckTarget> {
        self.check_target.as_ref()
    }
    /// Current transport; Events does not imply demonstrated polling reduction.
    pub fn transport(&self) -> Transport {
        self.transport
    }
    /// Last reconciled head, only reportable together with a non-stale outcome.
    pub fn head_sha(&self) -> Option<&str> {
        self.head_sha.as_deref()
    }

    fn invalidate(&mut self) {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("CI read generation exhausted");
        self.outcome = Outcome::Reconcile;
        self.acceptance = Outcome::Reconcile;
        self.head_sha = None;
        self.check_target = None;
    }
}

fn aggregate(gates: &[Gate]) -> Outcome {
    if gates.contains(&Gate::Failed) {
        Outcome::Failed
    } else if gates.contains(&Gate::Unknown) {
        Outcome::Unverified
    } else if gates.contains(&Gate::Pending) {
        Outcome::Waiting
    } else {
        Outcome::Passed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(head: &str, checks: Option<Vec<Gate>>, reviews: Gate) -> Snapshot {
        Snapshot {
            head_sha: head.into(),
            confirmed_head_sha: head.into(),
            check_target: Some(CheckTarget {
                sha: head.into(),
                source: CheckSource::Head,
            }),
            confirmed_check_target: Some(CheckTarget {
                sha: head.into(),
                source: CheckSource::Head,
            }),
            required_checks: checks,
            reviews,
            project_validation: Gate::Unknown,
        }
    }

    #[test]
    fn upstream_envelope_requires_verified_host_prerequisites() {
        assert!(stream_start::<()>(true, true, "thread", "sub", None).is_none());
        for (experimental, subscribed) in [(false, true), (true, false)] {
            assert!(
                stream_start(
                    experimental,
                    subscribed,
                    "thread",
                    "sub",
                    Some(EventContract {
                        name: "test-provider-contract".into(),
                        arguments: ()
                    })
                )
                .is_none()
            );
        }
        let request = stream_start(
            true,
            true,
            "thread",
            "sub",
            Some(EventContract {
                name: "test-provider-contract".into(),
                arguments: serde_json::json!({"scope": 7}),
            }),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({"threadId":"thread","server":"codex_apps","subscriptionId":"sub","name":"test-provider-contract","arguments":{"scope":7},"_meta":null})
        );
    }

    #[test]
    fn repeated_and_out_of_order_events_only_invalidate_reads() {
        let mut watch = CiWatch::new("sub".into());
        let old = watch.begin_read();
        watch.notification(
            watch.connection_epoch(),
            "sub",
            "notifications/events/event",
        );
        watch.notification(
            watch.connection_epoch(),
            "sub",
            "notifications/events/event",
        );
        assert!(!watch.reconcile(old, snapshot("old", Some(vec![Gate::Passed]), Gate::Passed)));
        let fresh = watch.begin_read();
        assert!(watch.reconcile(
            fresh,
            snapshot("new", Some(vec![Gate::Pending]), Gate::Passed)
        ));
        assert_eq!(watch.outcome(), Outcome::Waiting);
        watch.notification(
            watch.connection_epoch(),
            "other",
            "notifications/events/terminated",
        );
        assert_eq!(watch.outcome(), Outcome::Waiting);
        watch.notification(
            watch.connection_epoch(),
            "sub",
            "notifications/events/event",
        ); // late old payload
        assert_eq!(watch.outcome(), Outcome::Reconcile);
    }

    #[test]
    fn push_during_ci_cannot_report_old_green() {
        let mut watch = CiWatch::new("sub".into());
        let token = watch.begin_read();
        let mut observation = snapshot("old", Some(vec![Gate::Passed]), Gate::Passed);
        observation.confirmed_head_sha = "new".into();
        assert!(!watch.reconcile(token, observation));
        assert_eq!(watch.outcome(), Outcome::Reconcile);
        let token = watch.begin_read();
        assert!(watch.reconcile(
            token,
            snapshot("new", Some(vec![Gate::Pending]), Gate::Pending)
        ));
        assert_eq!(watch.head_sha(), Some("new"));
        assert_eq!(watch.outcome(), Outcome::Waiting);
    }

    #[test]
    fn reconnect_and_unavailability_require_full_reconciliation() {
        let mut watch = CiWatch::new("sub".into());
        let old_connection = watch.connection_epoch();
        watch.notification(
            watch.connection_epoch(),
            "sub",
            "notifications/events/active",
        );
        let token = watch.begin_read();
        assert!(watch.reconcile(
            token,
            snapshot("head", Some(vec![Gate::Passed]), Gate::Passed)
        ));
        watch.unavailable();
        assert_eq!(watch.transport(), Transport::Polling);
        assert_eq!(watch.outcome(), Outcome::Reconcile);
        assert_eq!(watch.head_sha(), None);
        watch.notification(old_connection, "sub", "notifications/events/active");
        assert_eq!(watch.transport(), Transport::Polling);
        watch.notification(
            watch.connection_epoch(),
            "sub",
            "notifications/events/active",
        );
        assert_eq!(watch.transport(), Transport::Events);
        assert!(!watch.reconcile(
            token,
            snapshot("head", Some(vec![Gate::Passed]), Gate::Passed)
        ));
        watch.notification(
            watch.connection_epoch(),
            "sub",
            "notifications/events/terminated",
        );
        assert_eq!(watch.transport(), Transport::Polling);
    }

    #[test]
    fn missing_required_checks_or_reviews_never_become_success() {
        let mut watch = CiWatch::new("sub".into());
        for (checks, reviews, outcome) in [
            (None, Gate::Passed, Outcome::Unverified),
            (Some(vec![]), Gate::Unknown, Outcome::Unverified),
            (Some(vec![Gate::Passed]), Gate::Failed, Outcome::Failed),
            (Some(vec![Gate::Unknown]), Gate::Passed, Outcome::Unverified),
            (Some(vec![Gate::Passed]), Gate::Passed, Outcome::Passed),
        ] {
            let token = watch.begin_read();
            assert!(watch.reconcile(token, snapshot("head", checks, reviews)));
            assert_eq!(watch.outcome(), outcome);
        }
    }

    #[test]
    fn overlapping_and_duplicate_read_responses_cannot_replace_current_state() {
        let mut watch = CiWatch::new("sub".into());
        let older = watch.begin_read();
        let current = watch.begin_read();
        assert!(!watch.reconcile(
            older,
            snapshot("old", Some(vec![Gate::Passed]), Gate::Passed)
        ));
        assert!(watch.reconcile(
            current,
            snapshot("new", Some(vec![Gate::Failed]), Gate::Passed)
        ));
        assert!(!watch.reconcile(
            current,
            snapshot("old", Some(vec![Gate::Passed]), Gate::Passed)
        ));
        assert_eq!(watch.head_sha(), Some("new"));
        assert_eq!(watch.outcome(), Outcome::Failed);
    }

    #[test]
    fn selected_test_merge_failure_overrides_green_head_checks() {
        let mut watch = CiWatch::new("sub".into());
        let token = watch.begin_read();
        assert!(watch.reconcile(
            token,
            snapshot("head", Some(vec![Gate::Passed]), Gate::Passed)
        ));
        let token = watch.begin_read();
        let mut merge = snapshot("head", Some(vec![Gate::Failed]), Gate::Passed);
        let target = CheckTarget {
            sha: "test-merge".into(),
            source: CheckSource::TestMerge,
        };
        merge.check_target = Some(target.clone());
        merge.confirmed_check_target = Some(target.clone());
        assert!(watch.reconcile(token, merge));
        assert_eq!(watch.head_sha(), Some("head"));
        assert_eq!(watch.check_target(), Some(&target));
        assert_eq!(watch.outcome(), Outcome::Failed);
    }

    #[test]
    fn check_selection_change_or_missing_selection_cannot_report_green() {
        let mut watch = CiWatch::new("sub".into());
        let token = watch.begin_read();
        let mut changed = snapshot("head", Some(vec![Gate::Passed]), Gate::Passed);
        changed.check_target = Some(CheckTarget {
            sha: "merge-old".into(),
            source: CheckSource::TestMerge,
        });
        changed.confirmed_check_target = Some(CheckTarget {
            sha: "merge-new".into(),
            source: CheckSource::TestMerge,
        });
        assert!(!watch.reconcile(token, changed));
        assert_eq!(watch.outcome(), Outcome::Reconcile);
        let token = watch.begin_read();
        let mut missing = snapshot("head", Some(vec![Gate::Passed]), Gate::Passed);
        missing.check_target = None;
        missing.confirmed_check_target = None;
        assert!(watch.reconcile(token, missing));
        assert_eq!(watch.outcome(), Outcome::Unverified);
    }

    #[test]
    fn completed_skipped_and_neutral_satisfy_protection_without_proving_execution() {
        let mut watch = CiWatch::new("sub".into());
        for state in [CheckState::CompletedSkipped, CheckState::CompletedNeutral] {
            let token = watch.begin_read();
            let mut skipped = snapshot("head", Some(vec![state.protection()]), Gate::Passed);
            skipped.project_validation = state.execution();
            assert!(watch.reconcile(token, skipped));
            assert_eq!(watch.outcome(), Outcome::Passed);
            assert_eq!(watch.acceptance(), Outcome::Unverified);
        }
        let token = watch.begin_read();
        let mut executed = snapshot(
            "head",
            Some(vec![CheckState::CompletedSuccess.protection()]),
            Gate::Passed,
        );
        executed.project_validation = Gate::Passed; // independent actual execution evidence
        assert!(watch.reconcile(token, executed));
        assert_eq!(watch.acceptance(), Outcome::Passed);
        watch.unavailable();
        assert_eq!(watch.acceptance(), Outcome::Reconcile);
    }

    #[test]
    fn filtered_workflow_and_unfinished_checks_remain_pending() {
        let mut watch = CiWatch::new("sub".into());
        for state in [CheckState::WorkflowFiltered, CheckState::Pending] {
            let token = watch.begin_read();
            assert!(watch.reconcile(
                token,
                snapshot("head", Some(vec![state.protection()]), Gate::Passed)
            ));
            assert_eq!(watch.outcome(), Outcome::Waiting);
        }
        assert_eq!(CheckState::CompletedFailure.protection(), Gate::Failed);
        assert_eq!(CheckState::Unknown.protection(), Gate::Unknown);
    }

    #[test]
    fn known_review_failure_survives_unknown_checks_or_selection() {
        let mut watch = CiWatch::new("sub".into());
        let token = watch.begin_read();
        assert!(watch.reconcile(token, snapshot("head", None, Gate::Failed)));
        assert_eq!(watch.outcome(), Outcome::Failed);
        assert_eq!(watch.acceptance(), Outcome::Failed);
        let token = watch.begin_read();
        let mut missing_selection = snapshot("head", Some(vec![Gate::Passed]), Gate::Failed);
        missing_selection.check_target = None;
        missing_selection.confirmed_check_target = None;
        assert!(watch.reconcile(token, missing_selection));
        assert_eq!(watch.outcome(), Outcome::Failed);
        assert_eq!(watch.acceptance(), Outcome::Failed);
    }
}
