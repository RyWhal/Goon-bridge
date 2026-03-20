# Policy Mapping UI Design

## Summary

Add a new experimental UI surface for the policy-to-committee mapping backend that was just built in the API layer.

The first version should live as an experimental tab and support one focused workflow:

- search by policy area
- see ranked committee mappings
- expand a row to inspect the evidence trail

This is a thin frontend on top of the new policy mapping API. It should prioritize clear inspection of the derived mapping layer rather than adding more inference, graph rendering, or admin tooling.

## Goals

- Expose the new policy-to-committee mapping API in the existing React app.
- Keep the first UI slice narrow enough to test and iterate locally without disturbing the main bill workflow.
- Make confidence, source, and evidence trail visible to the user.
- Reuse existing app patterns for experimental features and API fetching.

## Non-Goals

- Graph visualization
- Policy-area autocomplete
- Policy-area browse mode
- Inline admin refresh controls
- Inline override editing
- Bill/member deep-linking in the first version
- Merging this into the main Bills tab yet

## Placement

The new surface should live under the experimental area as a new tab.

Reasoning:

- keeps the scope low-risk
- avoids crowding the main bills workflow
- matches the maturity of the feature
- makes local iteration easier without overcommitting to a permanent IA choice

Recommended tab label:

- `Policy Maps`

## User Workflow

The first version supports one direct query flow:

1. user enters a policy area such as `Defense`
2. UI submits `GET /api/maps/policy-committees?policyArea=Defense`
3. UI renders a ranked result list
4. user expands one result row
5. UI fetches `GET /api/maps/evidence/policy-committee/:mapId`
6. UI renders the evidence trail under that row

This should feel like an inspection tool, not a dashboard.

## UI Structure

The page should have three visible states:

### Idle State

Show:

- short explainer text
- single search field
- submit button

Suggested copy direction:

- explain that this is a derived mapping explorer
- remind the user that confidence reflects display comfort, not certainty

### Results State

Render a compact ranked list of committee mappings for the searched policy area.

Each row should show:

- committee name
- chamber
- confidence
- source
- evidence count
- bill count when available

Rows should sort by:

1. confidence descending
2. bill count descending

### Expanded Evidence State

Expanding a row should reveal:

- evidence type
- source table
- source row id
- short note
- source URL when available

Only one row should be expanded at a time in v1.

## Data Flow

The frontend should remain intentionally thin.

Primary query:

- `GET /api/maps/policy-committees?policyArea=...`

On-demand evidence query:

- `GET /api/maps/evidence/policy-committee/:mapId`

Evidence should load lazily on expansion rather than upfront.

This keeps:

- initial fetches smaller
- first render faster
- evidence formatting easier to iterate independently

## Component Shape

Start with one new focused component rather than a mini subsystem.

Recommended additions:

- `src/components/PolicyMappingExplorer.tsx`

Possible later splits if the file grows:

- `PolicyMappingSearchForm`
- `PolicyMappingResultList`
- `PolicyMappingEvidenceList`

For the first pass, keep it in one component unless the file becomes unwieldy.

## State Model

Recommended local state:

- `query`
- `submittedQuery`
- `results`
- `expandedMapId`
- `evidenceByMapId`
- `loading`
- `error`

No client-side caching beyond the in-memory `evidenceByMapId` map is needed in v1.

## Interaction Rules

- submit on Enter or button click
- empty query should not fetch
- empty query should show lightweight validation copy
- expanding one row should collapse the previous expanded row
- suppress hidden rows at the API level and assume the UI only receives visible rows
- if evidence fetch fails, show a localized error state in the expanded area without collapsing the row

## API Response Handling

The UI should assume:

- mapping rows may be empty
- evidence may be empty
- source URLs may be absent
- confidence may be numeric but should be formatted for readability

Recommended formatting:

- confidence as a fixed 2-decimal badge or inline label
- counts as plain integers
- evidence shown as readable metadata blocks, not raw JSON by default

## Error And Empty States

### Validation Error

If search is empty:

- show inline prompt such as `Enter a policy area to inspect derived committee mappings.`

### Empty Result

If the API returns zero rows:

- show a neutral empty state
- keep the submitted policy area visible

Suggested message direction:

- `No visible committee mappings found for "<policy area>".`

### Request Failure

If the list request fails:

- keep the search field populated
- show a page-level error message

If an evidence request fails:

- keep the row expanded
- show a row-scoped error message

## Integration With Existing App

Add a new experimental tab entry in the routing/tab config and render the new explorer in `src/App.tsx`.

The component should use the existing `useApi` hook pattern rather than introducing a new data layer.

The visual style should follow the current experimental tools:

- compact
- inspectable
- text-forward

Do not introduce a radically different visual language for this screen.

## Testing Expectations

The implementation should include:

- component-level behavior tests if the frontend test setup supports them
- otherwise, careful local manual verification against the live local API

At minimum, implementation work should verify:

- search fetches the correct endpoint
- results sort and render correctly
- evidence loads only on expansion
- error and empty states render correctly

## Next Steps

1. Add a new experimental tab route for `Policy Maps`.
2. Create `src/components/PolicyMappingExplorer.tsx`.
3. Wire the component to `GET /api/maps/policy-committees`.
4. Add on-demand evidence loading via `GET /api/maps/evidence/policy-committee/:mapId`.
5. Render compact ranked rows with expandable evidence.
6. Verify the UI locally against the current worktree API implementation.
7. Iterate on formatting after first local feedback.

## Recommendation

Build the first UI slice as a narrow experimental explorer:

- one search field
- one ranked result list
- one expandable evidence view

This is the fastest path to a useful vertical slice and the least risky way to validate whether the mapping layer feels good in the app before broadening the feature.
