# Bounded atomic balance evidence

The active effort is defined in `.github/atomic-evidence-policy.json`. An effort
ID identifies one operational budget across manual runs, account-summary
handoffs, failed runs, cancellations and reruns. The helper counts matching
GitHub run attempts; `chain_index` alone never grants a new budget. Creating a
new effort requires a deliberate policy change with a new ID. Failed history
must remain available for accounting.

The September 14 recovery effort permits at most 12 attempts, 12 complete
canonical scopes per batch and 45 exact search submissions per workflow. Filers
33 and 191 are deferred in the default three-pass mode. A request containing
another member of an excluded canonical scope is rejected before capture. This does not change the
ordinary scheduled coverage workflow.

Every atomic dispatch must provide the configured `effort_id`. Admission runs
after shared ORESTAR coordination and branch refresh. A summary sweep consults
the same policy and history before handing off; it cannot start an independent
budget by setting `chain_index=1`. Exhausted/disabled handoffs stop without
submitting a child. API or policy ambiguity fails closed.

The search ceiling is a conservative operating bound, not a claimed ORESTAR
quota. Three observed runs completed 50 exact searches and then lost count
responses on searches 51 and 52; a browser restart did not recover them. One
workflow-local ledger reserves a submission before the search click, including
ambiguous timeouts, and is inherited by stabilization subprocesses. It cannot
be reinitialized or increased by a later pass. Reaching the ceiling stops the
collector without automatic refusal retries or partial-scope certification.

Default planning reserves estimated search cost for three genuine
capture/exact passes, counting every physical filer in a canonical scope.
Unknown or oversized work is deferred. Successful collections record their
actual search cost for later planning. A separately reviewed legacy hint in
`.github/atomic-search-costs.json` can guide scheduling only while it matches the
saved observation's identity; it supplies no transaction or balance evidence.
Fresh source growth may still exhaust the hard budget. Before recapture,
stabilization checks that the remaining supported passes fit, using measured
costs where available.

After a run, verify complete-scope exact collection, publication, aggregation,
terminal stabilization and the resulting source/report. A successful exact
comparison may still contain missing or surplus IDs. Stable evidence makes a
balance comparison trustworthy; it does not prove cash agreement. Missing-ID
remediation requires its own complete-scope verification and fresh aggregation
and atomic proof after any transaction change. Preserve source exceptions and
annual gaps until authoritative evidence supports their treatment.

## Isolated single-pass recovery

The reviewed policy allows filer 191 alone to request `max_passes=1` with an
explicit `filer_ids=191`. This makes one real summary capture followed by one
complete exact collection, publication, aggregation and stabilization
assessment. The policy keeps 33 and 191 excluded from ordinary three-pass
batches; this exception removes only the authorized IDs for the admitted
attempt. Filer 33 remains deferred. Missing or empty `single_pass_filer_ids`
policy configuration permits no exception.

Admission requires the same enabled effort ID and complete GitHub attempt
history. The planner independently requires exactly one complete canonical
scope, every expanded physical member in the policy allowlist, and a supported
search estimate that fits the unchanged 45-search ceiling. An alias cannot
admit an unapproved scope member. The reviewed 191 scheduling hint is usable
only while it matches the saved observation's identity; it grants no evidence.
The plan records `reserved_exact_passes`, which the stabilization runner must
match. Normal handoffs continue to reserve three passes.

One pass can succeed only when final assessment finds the whole original scope
stable. If cash, transaction count or fresh annual treatment remains unsettled,
the run fails after preserving truthful published evidence. It cannot recapture
or automatically dispatch another batch. A separately selected later attempt
must obtain fresh complete evidence and consumes another attempt in the same
12-attempt effort. Failed runs, cancellations and reruns all remain charged;
selecting this mode or resetting `chain_index` does not renew the budget.

## Project a completed transaction recovery

After targeted identity remediation and its zero-missing verification finish,
run the manual `Refresh Balance Projections` (`refresh-balances.yml`) workflow
on main. It waits for the shared writer lane, hydrates the current published
transactions, summaries and auxiliary evidence, runs normal aggregation and
donor re-keying, and checks that the published source/report match this fresh
projection. It does not fetch ORESTAR data or republish unchanged raw profiles.
A changed manifest, transaction fingerprint, checkpoint, or inconsistent cache
makes the workflow fail instead of claiming a coherent result.

Ordinary exact verification records its actual per-filer search submission
count as scheduling telemetry. This lets subsequent atomic admission estimate
repaired large scopes from the fresh verification. Telemetry does not replace
full-scope identity evidence or relax the 45-search atomic ceiling. After the
projection, complete a fresh atomic window for the affected canonical scopes
and inspect residual cash differences and annual/source exceptions.
