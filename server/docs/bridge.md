# Bridge registry

Temporary HTTP endpoints between `fliks-server` and Nest during the strangler. Each row is added in the milestone that needs it and removed when the bridge is deleted. Planned list: phase-2 plan §6.4.

Auth: `Authorization: Bearer $FLIKS_BRIDGE_TOKEN` (random per boot; constant-time compare). Nest serves bridges under `/internal` (no `api` prefix). Public fallback must 404 `/internal/**`.

| Endpoint | Direction | Payload | Added | Removed |
|---|---|---|---|---|
