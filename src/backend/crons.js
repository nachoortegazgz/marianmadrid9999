/*
=============================================================================
MODULE: backend/crons.js
VERSION: v5008.1-COMPENSATION-CACHE
BASE: BIBLIA v5002.5 Bloque 4.5 + DIRECTRICES V19
RESPONSIBILITY: Jobs programados (cron). 6 crons activos.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
CORRECTIONS APPLIED:
  [CRON-01] Los 6 crons de la BIBLIA implementados.
  [CRON-02] Cada cron genera traceId propio.
  [CRON-03] Errores no propagan (catch + log).
  [CRON-04] runPendingCompensationsJob ejecuta cancel nativo (CANCEL_BOOKING)
            en lugar de marcar COMPLETED sin accion (alineado Writer V2).
  [CRON-05] cleanupExpiredDualCache purga COLLECTIONS.DUAL_SLOT_CACHE en sitio
            (ya no depende de export ausente en reservas.web).
=============================================================================
*/

import wixData from "wix-data";
import { COLLECTIONS, SDK_CONFIG, CONCURRENCY } from "backend/internalConfig";
import { makeTraceId, _safeTrim, _looksLikeGuid, withTimeout } from "public/mmUtils";
import { logger } from "backend/logger";
import { verifyFiscalHashChainIntegrity } from "backend/cajas.web";
import { processBookingsServiceSyncQueue } from "backend/bookingServiceSync";
import { cancelBookingElevated } from "backend/booking/bookingCore";

const log = logger;

const API_TIMEOUT_MS =
  Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

const MAX_COMPENSATION_ATTEMPTS =
  Math.max(1, Number(CONCURRENCY?.MAX_COMPENSATION_RETRIES) || 3);

// =============================================================================
// CRON 1: cleanExpiredLocks - 15 * * * * (cada hora :15)
// =============================================================================

export async function cleanExpiredLocks() {
  const traceId = makeTraceId("cron-locks");
  try {
    const now = new Date();
    const res = await wixData
      .query(COLLECTIONS.SLOT_LOCKS)
      .lt("expiresAt", now)
      .limit(100)
      .find({ suppressAuth: true });

    let removed = 0;
    for (const item of res?.items || []) {
      await wixData
        .remove(COLLECTIONS.SLOT_LOCKS, item._id, { suppressAuth: true })
        .catch(() => null);
      removed++;
    }

    log.info("cleanExpiredLocks completed", { removed, traceId });
  } catch (err) {
    log.error("cleanExpiredLocks failed", { error: err?.message, traceId });
  }
}

// =============================================================================
// CRON 2: cleanupExpiredDualCache - 20 * * * * (cada hora :20)
// Purga filas expiradas de DualSlotCache (CMS). La certificacion dual actual
// calcula pares en caliente; esta coleccion puede quedar residual/legacy.
// =============================================================================

export async function cleanupExpiredDualCache() {
  const traceId = makeTraceId("cron-dual-cache");
  try {
    const now = new Date();
    const limit =
      Number(SDK_CONFIG?.JOBS?.DUAL_CACHE_CLEANUP_LIMIT) || 100;

    const res = await wixData
      .query(COLLECTIONS.DUAL_SLOT_CACHE)
      .lt("expiresAt", now)
      .limit(limit)
      .find({ suppressAuth: true });

    let removed = 0;
    for (const item of res?.items || []) {
      await wixData
        .remove(COLLECTIONS.DUAL_SLOT_CACHE, item._id, {
          suppressAuth: true,
        })
        .catch(() => null);
      removed++;
    }

    log.info("cleanupExpiredDualCache completed", { removed, traceId });
  } catch (err) {
    log.error("cleanupExpiredDualCache failed", {
      error: err?.message,
      traceId,
    });
  }
}

// =============================================================================
// CRON 3: runPendingCompensationsJob - 30 * * * * (cada hora :30)
// Ejecuta compensaciones pendientes (CANCEL_BOOKING via Writer V2 elevated).
// =============================================================================

async function _runOneCompensation(comp, traceId) {
  const kind = _safeTrim(comp?.kind).toUpperCase();
  const bookingId = _safeTrim(comp?.bookingId);

  if (kind === "CANCEL_BOOKING") {
    if (!bookingId || !_looksLikeGuid(bookingId)) {
      throw new Error("CANCEL_BOOKING requires a valid bookingId GUID");
    }

    await withTimeout(
      () =>
        cancelBookingElevated(bookingId, {
          suppressAuth: true,
        }),
      API_TIMEOUT_MS,
      "cron:cancelBookingCompensation"
    );

    return { ok: true, action: "CANCEL_BOOKING", bookingId };
  }

  throw new Error(`Unsupported compensation kind: ${kind || "UNKNOWN"}`);
}

export async function runPendingCompensationsJob() {
  const traceId = makeTraceId("cron-comp");
  try {
    const res = await wixData
      .query(COLLECTIONS.COMPENSACIONES_PENDIENTES)
      .in("status", ["PENDING", "RETRYING"])
      .lt("attempts", MAX_COMPENSATION_ATTEMPTS)
      .limit(
        Number(SDK_CONFIG?.JOBS?.FISCAL_RECOVERY_BATCH_SIZE) || 25
      )
      .find({ suppressAuth: true });

    let processed = 0;
    let failed = 0;

    for (const comp of res?.items || []) {
      try {
        await _runOneCompensation(comp, traceId);

        comp.status = "COMPLETED";
        comp.lastError = null;
        comp._updatedDate = new Date();
        await wixData.update(
          COLLECTIONS.COMPENSACIONES_PENDIENTES,
          comp,
          { suppressAuth: true }
        );
        processed++;
      } catch (compErr) {
        const attempts = Number(comp.attempts || 0) + 1;
        comp.attempts = attempts;
        comp.lastError = compErr?.message || "UNKNOWN";
        comp.status =
          attempts >= MAX_COMPENSATION_ATTEMPTS ? "FAILED" : "RETRYING";
        comp._updatedDate = new Date();

        await wixData
          .update(COLLECTIONS.COMPENSACIONES_PENDIENTES, comp, {
            suppressAuth: true,
          })
          .catch(() => null);

        failed++;

        if (comp.status === "FAILED" || comp.alertRequired === true) {
          await wixData
            .insert(
              COLLECTIONS.ALERTAS_OPERATIVAS,
              {
                alertType: "COMPENSATION_FAILED",
                severity: "ERROR",
                message: `Compensation ${comp.kind || "UNKNOWN"} failed for booking ${comp.bookingId || "n/a"}`,
                status: "OPEN",
                traceId,
                meta: {
                  compensationId: comp._id || null,
                  bookingId: comp.bookingId || null,
                  lastError: comp.lastError,
                  attempts,
                },
                _createdDate: new Date(),
              },
              { suppressAuth: true }
            )
            .catch(() => null);
        }
      }
    }

    log.info("runPendingCompensationsJob completed", {
      processed,
      failed,
      traceId,
    });
  } catch (err) {
    log.error("runPendingCompensationsJob failed", {
      error: err?.message,
      traceId,
    });
  }
}

// =============================================================================
// CRON 4: cleanExpiredDaysCache - 0 1 * * * (diario 01:00)
// =============================================================================

export async function cleanExpiredDaysCache() {
  const traceId = makeTraceId("cron-days-cache");
  try {
    const now = new Date();
    const res = await wixData
      .query(COLLECTIONS.AVAILABILITY_DAYS_CACHE)
      .lt("expiresAt", now)
      .limit(200)
      .find({ suppressAuth: true });

    let removed = 0;
    for (const item of res?.items || []) {
      await wixData
        .remove(COLLECTIONS.AVAILABILITY_DAYS_CACHE, item._id, {
          suppressAuth: true,
        })
        .catch(() => null);
      removed++;
    }

    log.info("cleanExpiredDaysCache completed", { removed, traceId });
  } catch (err) {
    log.error("cleanExpiredDaysCache failed", {
      error: err?.message,
      traceId,
    });
  }
}

// =============================================================================
// CRON 5: cleanExpiredSlotsCache - 10 1 * * * (diario 01:10)
// =============================================================================

export async function cleanExpiredSlotsCache() {
  const traceId = makeTraceId("cron-slots-cache");
  try {
    log.info(
      "cleanExpiredSlotsCache completed (RAM cache auto-resets on cold start)",
      { traceId }
    );
  } catch (err) {
    log.error("cleanExpiredSlotsCache failed", {
      error: err?.message,
      traceId,
    });
  }
}

// =============================================================================
// CRON 6: systemHealthCheck - 0 7 * * * (diario 07:00)
// =============================================================================

export async function systemHealthCheck() {
  const traceId = makeTraceId("cron-health");
  try {
    const results = {
      timestamp: new Date().toISOString(),
      collections: {},
      fiscalChain: null,
      secrets: {},
    };

    const criticalCols = [
      COLLECTIONS.CITAS_F2,
      COLLECTIONS.MOVIMIENTOS_CAJA,
      COLLECTIONS.SLOT_LOCKS,
      COLLECTIONS.MAPA_STAFF,
      COLLECTIONS.COMPENSACIONES_PENDIENTES,
    ];

    for (const col of criticalCols) {
      try {
        const count = await wixData.query(col).limit(1).count();
        results.collections[col] = { accessible: true, count };
      } catch (_) {
        results.collections[col] = { accessible: false, count: 0 };
      }
    }

    try {
      const chainResult = await verifyFiscalHashChainIntegrity({
        traceId,
        limit: 100,
      });
      results.fiscalChain = chainResult.status;
    } catch (_) {
      results.fiscalChain = "ERROR";
    }

    log.info("systemHealthCheck completed", { results, traceId });

    const hasIssues =
      Object.values(results.collections).some((c) => !c.accessible) ||
      results.fiscalChain !== "SUCCESS";

    if (hasIssues) {
      await wixData
        .insert(
          COLLECTIONS.ALERTAS_OPERATIVAS,
          {
            alertType: "HEALTH_CHECK_ISSUES",
            severity: "WARNING",
            message: "systemHealthCheck detected issues",
            status: "OPEN",
            traceId,
            _createdDate: new Date(),
          },
          { suppressAuth: true }
        )
        .catch(() => null);
    }
  } catch (err) {
    log.error("systemHealthCheck failed", { error: err?.message, traceId });
  }
}
