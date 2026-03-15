# Common Issues

## Bills "Newest activity" sort

- The Bills & Votes default "Newest activity" sort must follow the exact date shown in the bottom-left action line on each bill card.
- That visible date comes from `latestAction.actionDate`.
- Do not switch the sort key to `updateDate` unless the rendered bill card date changes to match it.
- The API path for `sort=updateDate...` intentionally stays on the local scan path because shortcut paths have repeatedly produced first pages that looked out of order.
- Symptom of regression: the default first page mixes dates like January, February, and March out of order, while a narrow date-filtered search returns the expected cluster for a single day.
