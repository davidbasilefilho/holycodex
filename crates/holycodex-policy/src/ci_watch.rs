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

/// Complete, normalized current-head observation made by the host.
pub struct Snapshot {
    /// Head observed before fetching gates.
    pub head_sha: String,
    /// Head re-read after fetching gates; mismatch invalidates the snapshot.
    pub confirmed_head_sha: String,
    /// Required checks for this exact head. None means requirements unknown.
    /// Some(empty) is valid only when the host verified no checks are required.
    pub required_checks: Option<Vec<Gate>>,
    /// Relevant current-head review/thread requirements, not historical approvals.
    pub reviews: Gate,
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
    /// All known required gates passed for the confirmed head.
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
    head_sha: Option<String>,
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
            head_sha: None,
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
        {
            return false;
        }
        self.head_sha = Some(snapshot.head_sha);
        self.outcome = match snapshot.required_checks {
            None => Outcome::Unverified,
            Some(mut gates) => {
                gates.push(snapshot.reviews);
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
        };
        // A completed read token is single-use, including duplicate responses.
        self.generation = self
            .generation
            .checked_add(1)
            .expect("CI read generation exhausted");
        true
    }

    /// Current result, invalidated by every event or disconnection.
    pub fn outcome(&self) -> Outcome {
        self.outcome
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
        self.head_sha = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(head: &str, checks: Option<Vec<Gate>>, reviews: Gate) -> Snapshot {
        Snapshot {
            head_sha: head.into(),
            confirmed_head_sha: head.into(),
            required_checks: checks,
            reviews,
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
}
