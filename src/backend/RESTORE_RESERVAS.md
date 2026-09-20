# EMERGENCY: Restore reservas.web.js

During automated fixes on 2026-09-20, `src/backend/reservas.web.js` was accidentally truncated.

## Restore (required before next site publish)

```bash
git fetch origin
git show 1f56f07b36a7dbbdee4b165f0ac94f70076834e8:src/backend/reservas.web.js > src/backend/reservas.web.js
git add src/backend/reservas.web.js
git commit -m "fix(reservas): restore full availability module from 1f56f07"
git push
```

Optional patches after restore:
1. Deterministic dual staff when client does not choose (hash of dateYMD+serviceId over shared staff list).
2. Export `_cleanExpiredDualSlotsInternal` for DualSlotCache CMS purge (crons.js already purges inline).

## Already applied successfully
- ONLY STAFF page: Markdown fence removed
- crons.js: real CANCEL_BOOKING compensation + DualSlotCache purge without broken import
