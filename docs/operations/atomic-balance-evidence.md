# Bounded atomic balance evidence

The active effort is defined in `.github/atomic-evidence-policy.json`. An effort
ID identifies one operational budget across manual runs, account-summary
handoffs, failed runs, cancellations and reruns. The helper counts matching
GitHub run attempts; `chain_index` alone never grants a new budget. Creating a
new effort requires a deliberate policy change with a new ID. Failed history
must remain available for accounting.

The September 14 recovery effort permits at most 12 attempts, 12 complete
canonical scopes per batch and 45 exact search submissions per workflow. Filers
33 and 191 are explicitly deferred. A request containing another member of an
excluded canonical scope is rejected before capture. This does not change the
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

Planning reserves estimated search cost for all three supported genuine
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
