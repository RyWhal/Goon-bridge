# Common Issues

## Bills "Newest activity" sort

- The Bills & Votes default "Newest activity" sort must follow the exact date shown in the bottom-left action line on each bill card.
- That visible date comes from `latestAction.actionDate`.
- Do not switch the sort key to `updateDate` unless the rendered bill card date changes to match it.
- The default bills browse path should be cache-first and order by the persisted `latest_action_date` column. Reserve live Congress.gov scans for narrower filtered searches and detail hydration.
- The members browse path should stay cache-only. It is a small static dataset, and live per-member hydration has repeatedly caused deployed Worker requests to exceed the Pages proxy timeout.
- Symptom of regression: the default first page mixes dates like January, February, and March out of order, while a narrow date-filtered search returns the expected cluster for a single day.
