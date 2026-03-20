# Policy Mapping UI Plan

## Scope
- Add a `Policy Maps` experimental tab at `/experimental/policy-maps`.
- Build a compact policy-area search UI backed by `/api/maps/policy-committees`.
- Load evidence on demand from `/api/maps/evidence/policy-committee/:mapId`.

## Assumptions
- Backend map endpoints in the feature branch are the source of truth.
- V1 is read-only and search-driven.
- Build verification is sufficient for the frontend slice because there is no existing root frontend test harness.

## Steps
1. Extend experimental routing and app tab rendering.
2. Add a dedicated `PolicyMappingExplorer` component.
3. Verify the root build and the policy mapping endpoint tests.
