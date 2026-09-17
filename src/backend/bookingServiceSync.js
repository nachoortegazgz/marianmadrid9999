/*
=============================================================================
MODULE: backend/bookingServiceSync.js
VERSION: v5007.5-FINAL
BASE: BIBLIA v5002.5 Bloque 12.12 + DIRECTRICES V19
RESPONSIBILITY: Cola de sincronizacion entre ServiciosCatalogo y Wix Bookings.
STANDARDS: G10 ASCII Strict.
CORRECTIONS APPLIED:
  [BSS-01] _findPendingEquivalent usa .in("status", [...]) en lugar de
           hasSome (status es escalar, no array). Restaura la deduplicacion
           de encolados equivalentes.
  [BSS-02] Retirada funcion huerfana _isProcessingExpired (dead code).
  [BSS-03] Retirada variable skipped (siempre 0, no aportaba valor).
  [BSS-04] _syncServiceWithBookings documentado con contrato esperado del
           handler nativo de Wix Bookings Services V2.
  [BSS-05] getSyncQueueStatus exportado para observabilidad desde panel admin.
=============================================================================
*/

import wixData from "wix-data";

import {
    COLLECTIONS,
    SDK_CONFIG,
} from "backend/internalConfig";

import {
    makeTraceId,
    _safeTrim,
    _looksLikeGuid,
} from "public/mmUtils";

import { logger } from "backend/logger";

const log = logger;

const QUEUE_COL = COLLECTIONS.BOOKINGS_SERVICE_SYNC_QUEUE;

const MAX_ATTEMPTS =
    Number(SDK_CONFIG?.JOBS?.BOOKINGS_SERVICE_SYNC_MAX_ATTEMPTS) || 5;

const BATCH_SIZE =
    Number(SDK_CONFIG?.JOBS?.BOOKINGS_SERVICE_SYNC_BATCH_SIZE) || 20;

const BACKOFF_MS =
    Number(SDK_CONFIG?.JOBS?.BOOKINGS_SERVICE_SYNC_BACKOFF_MS) || 300000;

const MAX_BATCH_SIZE = 100;
const PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;

// =============================================================================
// BLOQUE 1 - VALIDACION
// =============================================================================

function _cleanGuid(value, errorCode) {
    const clean = _safeTrim(value);
    if (!clean || !_looksLikeGuid(clean)) {
        throw new Error(`${errorCode}: GUID invalido o ausente`);
    }
    return clean;
}

function _cleanGuidList(value) {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(
        value
        .map((item) => _safeTrim(item))
        .filter((item) => _looksLikeGuid(item))
    ));
}

function _numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
}

function _booleanValue(...values) {
    return values.some((value) => value === true);
}

// =============================================================================
// BLOQUE 2 - PROYECCION DESEADA
// =============================================================================

function _buildDesiredProjection(item = {}) {
    const serviceId = _cleanGuid(
        item.serviceId || item._id,
        "INVALID_SERVICE_ID"
    );

    const linkedPhases = _safeTrim(
        item.linkedPhases || item.linkedServiceId
    );

    if (linkedPhases && !_looksLikeGuid(linkedPhases)) {
        throw new Error("INVALID_LINKED_PHASE_SERVICE_ID: GUID invalido");
    }

    return {
        serviceId,
        title: _safeTrim(item.title || item.tituloServicio),
        tagLine: _safeTrim(item.tagLine || item.etiquetaServicio),
        description: _safeTrim(item.description || item.descripcionServicio),
        price: _numberOrZero(item.price ?? item.precioServicio),
        currency: _safeTrim(item.currency || item.moneda) || "EUR",
        totalDuration: _numberOrZero(item.totalDuration),
        phase1Duration: _numberOrZero(item.phase1Duration),
        exposureDuration: _numberOrZero(item.exposureDuration),
        phase2Duration: _numberOrZero(item.phase2Duration),
        buffer: _numberOrZero(item.buffer),
        hidden: _booleanValue(item.hidden, item.servicioOculto),
        onlinePayment: _booleanValue(item.onlinePayment, item.onlinePago),
        inPersonPayment: _booleanValue(item.inPersonPayment, item.presencialPago),
        categoryId: _safeTrim(item.categoryId?._id || item.categoryId),
        availableStaff: _cleanGuidList(item.availableStaff),
        linkedPhases: linkedPhases || null,
        allowCombine: _booleanValue(item.allowCombine, item.permitirCombinar),
    };
}

// =============================================================================
// BLOQUE 3 - COLA
// =============================================================================

function _buildQueueId(serviceId, payloadHash) {
    const servicePart = _safeTrim(serviceId);
    const hashPart = _safeTrim(payloadHash);
    return `sync_${servicePart}_${hashPart}_${Date.now()}`.slice(0, 190);
}

// [BSS-01] status es campo escalar: .in() en lugar de hasSome()
async function _findPendingEquivalent(serviceId, payloadHash) {
    const result = await wixData
        .query(QUEUE_COL)
        .eq("serviceId", serviceId)
        .eq("payloadHash", payloadHash)
        .in("status", ["PENDING", "PROCESSING"])
        .limit(1)
        .find({ suppressAuth: true });

    return result?.items?.[0] || null;
}

export async function enqueueBookingsServiceSync(serviceItem) {
    const traceId = makeTraceId("svc-sync");

    try {
        const desiredPayload = _buildDesiredProjection(serviceItem);

        const payloadHash = _safeTrim(
            serviceItem?.payloadHash ||
            serviceItem?._updatedDate ||
            serviceItem?._id ||
            desiredPayload.serviceId
        );

        if (!payloadHash) {
            throw new Error("INVALID_SYNC_PAYLOAD_HASH");
        }

        const existing = await _findPendingEquivalent(
            desiredPayload.serviceId,
            payloadHash
        );

        if (existing) {
            log.info("Service sync deduplicated", {
                serviceId: desiredPayload.serviceId,
                existingQueueId: existing._id,
                traceId,
            });
            return {
                status: "SUCCESS",
                data: {
                    queueId: existing._id,
                    deduplicated: true,
                },
                error: null,
            };
        }

        const queueId = _buildQueueId(desiredPayload.serviceId, payloadHash);
        const now = new Date();

        const item = await wixData.insert(
            QUEUE_COL, {
                _id: queueId,
                serviceId: desiredPayload.serviceId,
                desiredPayload,
                payloadHash,
                status: "PENDING",
                attempts: 0,
                nextAttemptAt: now,
                completedAt: null,
                failedAt: null,
                errorCode: null,
                errorMessage: null,
                processingStartedAt: null,
                traceId,
                _createdDate: now,
                _updatedDate: now,
            }, { suppressAuth: true }
        );

        log.info("Service sync enqueued", {
            serviceId: desiredPayload.serviceId,
            traceId,
        });

        return {
            status: "SUCCESS",
            data: {
                queueId: item?._id || queueId,
                deduplicated: false,
            },
            error: null,
        };
    } catch (error) {
        log.error("enqueueBookingsServiceSync failed", {
            message: error?.message || String(error),
            traceId,
        });

        return {
            status: "ERROR",
            data: null,
            error: {
                code: "SYNC_ENQUEUE_FAIL",
                message: error?.message || "No se pudo encolar la sincronizacion",
            },
        };
    }
}

// =============================================================================
// BLOQUE 4 - RECUPERACION DE ITEMS ATASCADOS
// [BSS-02] Retirada funcion huerfana _isProcessingExpired (dead code).
// =============================================================================

async function _recoverStaleProcessingItems(traceId) {
    const now = new Date();

    const result = await wixData
        .query(QUEUE_COL)
        .eq("status", "PROCESSING")
        .lt("processingStartedAt", new Date(now.getTime() - PROCESSING_TIMEOUT_MS))
        .limit(MAX_BATCH_SIZE)
        .find({ suppressAuth: true });

    let recovered = 0;

    for (const item of result?.items || []) {
        item.status = "PENDING";
        item.nextAttemptAt = now;
        item.processingStartedAt = null;
        item.errorCode = "PROCESSING_TIMEOUT";
        item.errorMessage = "El proceso anterior expiro y se reintentara.";
        item._updatedDate = now;

        await wixData.update(QUEUE_COL, item, { suppressAuth: true });
        recovered += 1;
    }

    if (recovered > 0) {
        log.warn("Stale service sync items recovered", { recovered, traceId });
    }

    return recovered;
}

// =============================================================================
// BLOQUE 5 - SINCRONIZACION NATIVA
// [BSS-04] Contrato esperado del handler nativo (Wix Bookings Services V2):
//
//   await bookingsServices.<method>({
//     serviceId,
//     ...desiredPayloadProjection,
//   });
//
// Metodos esperados segun contrato publico de Wix Bookings Services V2
// (https://dev.wix.com/docs/rest/business-solutions/bookings):
//   - bookingsServices.createService()
//   - bookingsServices.updateService()
//   - bookingsServices.deleteService()
//
// Hasta confirmar la version instalada, este handler lanza un error
// controlado que deja el item en cola sin corromper estado.
// =============================================================================

async function _syncServiceWithBookings(item, traceId) {
    if (!item?.serviceId || !item?.desiredPayload) {
        throw new Error("INVALID_SYNC_ITEM");
    }

    // TODO: sustituir por la llamada nativa cuando se confirme el contrato.
    // Ejemplo hipotetico:
    //
    //   import { services } from "wix-bookings-services.v2";
    //   const elevated = elevate(services.updateService);
    //   await elevated(item.serviceId, item.desiredPayload);

    log.warn("Service sync handler not configured; item left pending", {
        serviceId: item.serviceId,
        traceId,
    });

    throw new Error("BOOKINGS_SERVICE_SYNC_HANDLER_NOT_CONFIGURED");
}

// =============================================================================
// BLOQUE 6 - PROCESAMIENTO
// [BSS-03] Retirada variable skipped (siempre 0).
// =============================================================================

export async function processBookingsServiceSyncQueue(options = {}) {
    const traceId = _safeTrim(options?.traceId) || makeTraceId("svc-sync-proc");

    const requestedBatchSize = Number(options?.batchSize);
    const batchSize = Math.max(
        1,
        Math.min(
            Number.isFinite(requestedBatchSize) ? requestedBatchSize : BATCH_SIZE,
            MAX_BATCH_SIZE
        )
    );

    try {
        const recovered = await _recoverStaleProcessingItems(traceId);

        const result = await wixData
            .query(QUEUE_COL)
            .eq("status", "PENDING")
            .le("nextAttemptAt", new Date())
            .lt("attempts", MAX_ATTEMPTS)
            .ascending("nextAttemptAt")
            .limit(batchSize)
            .find({ suppressAuth: true });

        const items = result?.items || [];
        let processed = 0;
        let failed = 0;

        for (const item of items) {
            const now = new Date();

            try {
                const attempts = Number(item.attempts || 0) + 1;

                item.status = "PROCESSING";
                item.attempts = attempts;
                item.processingStartedAt = now;
                item._updatedDate = now;

                await wixData.update(QUEUE_COL, item, { suppressAuth: true });

                await _syncServiceWithBookings(item, traceId);

                item.status = "COMPLETED";
                item.completedAt = new Date();
                item.processingStartedAt = null;
                item.errorCode = null;
                item.errorMessage = null;
                item._updatedDate = new Date();

                await wixData.update(QUEUE_COL, item, { suppressAuth: true });
                processed += 1;
            } catch (error) {
                const attempts = Number(item.attempts || 0);
                const terminal = attempts >= MAX_ATTEMPTS;

                item.status = terminal ? "FAILED" : "PENDING";
                item.failedAt = new Date();
                item.processingStartedAt = null;
                item.errorCode = _safeTrim(error?.code) || "SYNC_FAIL";
                item.errorMessage = _safeTrim(error?.message) || "Error de sincronizacion";
                item.nextAttemptAt = new Date(
                    Date.now() + BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1))
                );
                item._updatedDate = new Date();

                await wixData.update(QUEUE_COL, item, { suppressAuth: true });
                failed += 1;

                log.error("Service sync failed", {
                    serviceId: item.serviceId,
                    attempts,
                    terminal,
                    traceId,
                    message: error?.message || String(error),
                });
            }
        }

        return {
            status: "SUCCESS",
            data: {
                processed,
                failed,
                recovered,
                total: items.length,
            },
            error: null,
        };
    } catch (error) {
        log.error("processBookingsServiceSyncQueue failed", {
            traceId,
            message: error?.message || String(error),
        });

        return {
            status: "ERROR",
            data: null,
            error: {
                code: "SYNC_PROCESS_FAIL",
                message: error?.message || "No se pudo procesar la cola de sincronizacion",
            },
        };
    }
}

// =============================================================================
// BLOQUE 7 - [BSS-05] OBSERVABILIDAD DE COLA
// =============================================================================

/**
 * Devuelve el estado agregado de la cola de sincronizacion.
 * Util para widgets de panel admin y diagnostico.
 *
 * @param {Object} [options]
 * @param {string} [options.traceId]
 * @returns {Promise<{status, data, error}>}
 */
export async function getSyncQueueStatus(options = {}) {
    const traceId = _safeTrim(options?.traceId) || makeTraceId("svc-sync-status");
    try {
        const [pendingRes, processingRes, failedRes] = await Promise.all([
            wixData.query(QUEUE_COL).eq("status", "PENDING").limit(500).find({ suppressAuth: true }).catch(() => ({ items: [] })),
            wixData.query(QUEUE_COL).eq("status", "PROCESSING").limit(500).find({ suppressAuth: true }).catch(() => ({ items: [] })),
            wixData.query(QUEUE_COL).eq("status", "FAILED").limit(500).find({ suppressAuth: true }).catch(() => ({ items: [] })),
        ]);

        return {
            status: "SUCCESS",
            data: {
                pendingCount: pendingRes?.items?.length || 0,
                processingCount: processingRes?.items?.length || 0,
                failedCount: failedRes?.items?.length || 0,
                maxAttempts: MAX_ATTEMPTS,
                backoffMs: BACKOFF_MS,
                processingTimeoutMs: PROCESSING_TIMEOUT_MS,
            },
            error: null,
        };
    } catch (error) {
        log.error("getSyncQueueStatus failed", {
            traceId,
            message: error?.message || String(error),
        });
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "SYNC_STATUS_FAIL",
                message: error?.message || "No se pudo obtener el estado de la cola",
            },
        };
    }
}