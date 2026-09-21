# Unusually large primary campaigns

Donor ask calculations exclude an automatically detected primary period when:

- A named opponent received at least 20% of the same party's primary vote.
- Cash contributions from January 1 of the previous year through primary day total at least $25,000.
- That total is at least 1.5 times the median of the preceding two primary periods and at least $10,000 above it. Both preceding periods must have positive receipts.

This is a conservative heuristic, not a claim that every contribution was motivated by the primary. It captures substantial opposition and an unusual fundraising increase even when the eventual winning margin is large. It applies to winners and losers, without a list of specially named candidates. Existing first-legislative-primary exclusions remain in place.

## Effect

The excluded period cannot set a candidate's own ask, a comparable donor benchmark, a new-donor first-gift estimate, or a lobbyist's historical minimum. Earlier normal cycles and giving after primary day remain eligible. If a donor's latest cycle has no eligible giving, their latest earlier eligible cycle supplies the baseline. A partial cycle cannot establish a full cycle of incumbent history or automatic fundraiser-outlier status.

Actual contributions, Last Cycle, and exported historical columns remain intact. Current-cycle gifts, including primary gifts already received, still reduce the remaining ask. The app's donor explanations and Excel methodology identify excluded periods and recipients.

## Evidence and refresh

`docs/assets/primary_campaign_exclusions.json` contains the periods, committee IDs, cash totals, prior-period median, opposition percentage, and rule. `python scraper/refresh_primary_campaigns.py` rebuilds it using read-only database queries against ORESTAR transactions and legislative primary election results. It combines a filer's associated committee IDs and excludes the same three in-kind subtypes as donor calculations.

The Primary Campaign Baselines workflow proposes a reviewable update PR weekly when `PIPELINE_SCHEDULES_ENABLED` is enabled, or on manual dispatch. A merge/deployment makes the reviewed evidence available to the app. No migration is required. Page loads fetch a small asset and query only affected filers' post-primary periods, with at most four concurrent profile workers and existing request memoization; they do not scan statewide receipts for detection.

## Limits

Detection needs completed primary results, matching candidate names, two prior funded periods, and imported transactions. It cannot flag a still-running primary, missing/ambiguous matches, or a large campaign without the required historical evidence. Changes are effective after the refresh PR is merged and deployed. Changes in office, leadership, or other fundraising conditions can also cause increases, so the generated evidence remains subject to review.

Election source rows occasionally retain explicit party headers inside candidate labels. The generator honors those headers within ordered race blocks and rejects groups whose percentages do not approximately sum to 100. Miscellaneous and write-in candidates cannot establish substantial opposition. This interpretation is local to detection; it does not rewrite election records.
