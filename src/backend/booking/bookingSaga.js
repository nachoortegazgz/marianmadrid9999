/*
=============================================================================
MODULE: backend/booking/bookingSaga.js
VERSION: v5007.16-ALIGNED
SSOT: SSOT CONSOLIDADO v5002.6 | ESQUEMA CMS v5002.5 | DOSSIER RESERVAS v0609
MISSION: Orquestador transaccional. Saga compensable para reservas simples
         y duales con gap de exposicion. Gestiona locks, heartbeat,
         idempotencia triple capa y creacion SECUENCIAL F1 -> F2.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
=============================================================================
HISTORIAL DE CAMBIOS:
  v5007.16 | 2026-09-19 | Alineacion con recomendaciones de auditoria:
           |            | [FIX-32] _validateLinkedPhaseService usa
           |            |   cleanGuidList (SSOT) en lugar de filter manual.
           |            | [FIX-34] _validateDualGap delega en computeGapMinutes
           |            |   de bookingUtils. Unifica tolerancia.
           |            | [FIX-35] Deteccion de addons en payload + WARNING.
           |            |   Bloqueador: addons no se inyectan a Writer V2
           |            |   hasta confirmar contrato de createBooking.
           |            | [FIX-36] _validateLinkedPhaseService retorna y se
           |            |   consume para calcular F2 con la duracion real
           |            |   del linked service (no la del padre).
           |            | [FIX-37] Timeouts en Writer V2, checkout, confirm
           |            |   y cancel. createBooking/createCheckout SIN retry
           |            |   (idempotencia no garantizada). confirmOrDecline
           |            |   y cancel con retry (idempotentes).
           |            | [FIX-38] _checkDoubleBookingFlag documentado como
           |            |   log-only (no bloquea la saga a mitad).
           |            | [FIX-39] Eliminado import muerto _getDualPairFromCache.
  v5007.15 | 2026-09-19 | COHERENCIA scheduleId Writer <-> CitasF2.
  v5007.14 | 2026-09-19 | Payload createBooking(booking, options),
           |            | secuencial F1->F2, compensacion completa.
  v5007.13 | 2026-09-19 | Gap maximo, validacion F2, persistencia
           |            | compensable, scheduleId real.
  v5007.12 | 2026-09-15 | W1, FF, AUDIT-BOOKING-01/02, PATCH-04..09.
  v5007.8  | 2026-09-15 | skipAvailabilityValidation,
           |            | _createBookingWithSelectiveElevation.
  v5007.7  | 2026-09-14 | FIX EDITOR RESIDUAL.
  v5007.6  | 2026-09-14 | FIX EDITOR.
  v5007.5  | 2026-09-14 | Alineacion SSOT v5002.6.
  v5007.4  | 2026-09-14 | HAL-S1..S12.
  v5007.3  | 2026-09-10 | FIX A5.
  v5002.5  | 2026-09-10 | Fix S-01.
  v5002.3  | 2026-09-06 | Version inicial.
=============================================================================
*/

import { bookings } from "wix-bookings.v2";
import { elevate } from "wix-auth";
import wixData from "wix-data";

import {
    COLLECTIONS,
    CONCURRENCY,
    SDK_CONFIG,
    SLOT_SEARCH,
    ESTADO_CITA,
    ESTADO_PAGO,
    FORMA_PAGO,
    APP_IDS,
} from "backend/internalConfig";

import {
    makeTraceId,
    _safeTrim,
    _looksLikeGuid,
    _stableSerialize,
    _hashKey,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
    _normalizeLocalIsoStr,
    _executeWithRetry,
    withTimeout,
} from "public/mmUtils";

import {
    computeGapMinutes,
    cleanGuidList,
} from "backend/booking/bookingUtils";

import { logger } from "backend/logger";

import {
    cancelBookingElevated,
    confirmOrDeclineBookingElevated,
    createCheckoutElevated,
    getCheckoutUrlElevated,
    _lockSlotKeyOrFail,
    _unlockSlotKey,
    _renewLock,
    _initTransaction,
    _completeTransaction,
    _failTransaction,
    _persistBooking,
    _forceStaffInPristineSlot,
    _resolveScheduleIdForResource,
    _buildLockKeys,
    createBookingError,
    normalizeError,
    ERROR_CODES,
    _extractCheckoutId,
} from "backend/booking/bookingCore";

export { _extractCheckoutId };

import {
    _resolveServiceIdInternal,
    _invalidateCachesInternal,
    _getServiceBySlugOrIdInternal,
    _resolveStaffForSlotInternal,
} from "backend/reservas.web";

const log = logger;

const LOCKTTLMS = Number(CONCURRENCY?.MUTEX_TTL_MS);
if (!Number.isFinite(LOCKTTLMS) || LOCKTTLMS <= 0) {
    throw new Error("MUTEX_TTL_MS must be positive");
}
const HEARTBEATMS = Number(CONCURRENCY?.HEARTBEAT_MS) || 15000;
const CITASCOL = COLLECTIONS.CITAS_F2;
const SERVICIOSCOL = COLLECTIONS.SERVICIOS_CATALOGO;
const COMPENSACIONESCOL = COLLECTIONS.COMPENSACIONES_PENDIENTES;

const MAX_DUAL_GAP_MINUTES =
    Math.max(0, Number(SLOT_SEARCH?.MAX_DUAL_GAP_MINUTES || 120));

// FIX-37: timeouts por tipo de operacion Writer V2.
const BOOKING_CREATION_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.BOOKING_CREATION_MS) || 25000;
const CHECKOUT_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.CHECKOUT_MS) || 20000;
const API_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

// =============================================================================
// BLOCK 1 - DETERMINISTIC PAIR TOKEN
// =============================================================================
function _resolveStablePairToken({ serviceId, resourceId, f1Start, f2Start, email, existingPairToken }) {
    const existing = _safeTrim(existingPairToken);
    if (existing) return existing;

    const emailHash = _hashKey(_safeTrim(email).toLowerCase());
    const payload = _stableSerialize({
        serviceId: _safeTrim(serviceId),
        resourceId: _safeTrim(resourceId),
        f1Start: _safeTrim(f1Start),
        f2Start: _safeTrim(f2Start || ""),
    });
    const hash = _hashKey(payload + "|" + emailHash);
    return "pt_" + hash.slice(0, 32);
}

// =============================================================================
// BLOCK 2 - PERSISTED META NORMALIZATION
// =============================================================================
export function _normalizePersistedMeta(meta) {
    if (!meta) return {};

    try {
        if (typeof meta === "string") {
            const parsed = JSON.parse(meta);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed
                : {};
        }

        return typeof meta === "object" && !Array.isArray(meta)
            ? meta
            : {};
    } catch (_) {
        return {};
    }
}

// =============================================================================
// BLOCK 3 - BEST-EFFORT LOCK RELEASE
// =============================================================================
async function _bestEffortUnlockAll(lockKeys, lockOwnerId) {
    for (const key of lockKeys || []) {
        try {
            await _unlockSlotKey(key, lockOwnerId);
        } catch (e) {
            log.warn("_bestEffortUnlockAll: failed to unlock", { key: key, error: e?.message });
        }
    }
}

// =============================================================================
// BLOCK 4 - BOOKING COMPENSATION
// =============================================================================
async function _compensateCreatedBookings(createdBookings, traceId) {
    for (const booking of createdBookings || []) {
        const bookingId = booking?.bookingId || booking?.id;
        if (!bookingId) continue;
        try {
            // FIX-37: timeout + retry (cancel es idempotente).
            await _executeWithRetry(
                () =>
                    withTimeout(
                        () => cancelBookingElevated(bookingId, { suppressAuth: true }),
                        API_TIMEOUT_MS,
                        "cancelBookingCompensation"
                    ),
                2,
                300
            );
            log.info("Compensated booking cancelled", { bookingId: bookingId, traceId: traceId });
        } catch (cancelErr) {
            log.error("Compensation cancel failed; queuing", {
                bookingId: bookingId,
                traceId: traceId,
                error: cancelErr?.message,
            });
            try {
                await wixData.insert(
                    COMPENSACIONESCOL, {
                        id: "COMP" + bookingId + "_" + Date.now(),
                        kind: "CANCEL_BOOKING",
                        bookingId: bookingId,
                        phase: booking?.phase || "UNKNOWN",
                        status: "PENDING",
                        attempts: 0,
                        amount: 0,
                        paymentMethod: null,
                        transactionId: null,
                        orderId: null,
                        refundId: null,
                        concept: "Booking compensation after saga failure",
                        movementType: null,
                        alertRequired: true,
                        lastError: cancelErr?.message || "UNKNOWN",
                        traceId: traceId,
                        _createdDate: new Date(),
                        _updatedDate: new Date(),
                    }, { suppressAuth: true }
                );
            } catch (queueErr) {
                log.error("Failed to queue compensation", {
                    bookingId: bookingId,
                    traceId: traceId,
                    error: queueErr?.message,
                });
            }
        }
    }
}

// =============================================================================
// BLOCK 5 - SELECTIVE ELEVATION + TIMEOUT (FIX-37)
//
// createBooking NO usa _executeWithRetry: un timeout deja la peticion en
// vuelo en Writer V2 y un retry podria crear un booking duplicado. Los
// locks protegen el slot, pero no garantizan idempotencia de Writer V2.
// =============================================================================
async function _createBookingWithSelectiveElevation(booking, options, traceId) {
    try {
        return await withTimeout(
            () => bookings.createBooking(booking, options),
            BOOKING_CREATION_TIMEOUT_MS,
            "createBooking"
        );
    } catch (err) {
        const code = _safeTrim(err?.code || err?.details?.applicationError?.code).toUpperCase();
        const isAccessDenied = code === "ACCESS_DENIED" ||
            String(err?.message || "").toUpperCase().includes("ACCESS_DENIED");
        if (!isAccessDenied) throw err;
        log.info("Elevating createBooking due to ACCESS_DENIED", { traceId: traceId });
        return await withTimeout(
            () => elevate(bookings.createBooking)(booking, options),
            BOOKING_CREATION_TIMEOUT_MS,
            "createBooking:elevated"
        );
    }
}

// =============================================================================
// BLOCK 6 - VALIDACION DEFENSIVA DE RESPUESTA
// =============================================================================
function _validateCreateBookingResponse(booking, phase, traceId) {
    const id = _safeTrim(booking?.id || booking?._id);
    if (!id || !_looksLikeGuid(id)) {
        log.error("CreateBooking returned invalid booking", {
            phase,
            traceId,
            hasId: Boolean(booking?.id),
            has_id: Boolean(booking?._id),
        });
        throw createBookingError(
            ERROR_CODES.BOOKING_CREATION_FAILED,
            `Booking ${phase} created but no valid ID returned`,
            { traceId, phase }
        );
    }
    return id;
}

// =============================================================================
// BLOCK 7 - DETECCION DE FLAG DOUBLEBOOKED (LOG-ONLY, FIX-38)
//
// Politica: se loguea WARNING y se continua la saga. NO se aborta a mitad
// porque un abort dejaria bookings ya creados sin compensar hasta que el
// saga ejecute _compensate() o el operador revise AlertasOperativas.
// Si se necesita modo estricto en tests, se debe exponer un flag aparte.
// =============================================================================
function _checkDoubleBookingFlag(booking, phase, traceId) {
    if (booking?.doubleBooked === true) {
        log.warn("DOUBLE_BOOKING_DETECTED", {
            phase,
            traceId,
            bookingId: booking?.id || booking?._id,
        });
        return true;
    }
    return false;
}

// =============================================================================
// BLOCK 8 - VALIDACION EXPLICITA DE GAP MAXIMO (FIX-34)
//
// Delega en computeGapMinutes de bookingUtils para unificar tolerancia
// con citasManager._revalidateDualInputSlots.
// =============================================================================
function _validateDualGap(f1LocalEnd, f2LocalStart, traceId) {
    const f1EndLocal = _normalizeLocalIsoStr(f1LocalEnd);
    const f2StartLocal = _normalizeLocalIsoStr(f2LocalStart);

    if (!f1EndLocal || !f2StartLocal) {
        throw createBookingError(
            ERROR_CODES.INVALID_DATES,
            "Dual gap validation: invalid dates",
            { traceId, f1LocalEnd, f2LocalStart }
        );
    }

    const f1EndUtc = getUtcDateFromMadridLocal(f1EndLocal);
    const f2StartUtc = getUtcDateFromMadridLocal(f2StartLocal);

    if (!f1EndUtc || !f2StartUtc) {
        throw createBookingError(
            ERROR_CODES.INVALID_DATES,
            "Dual gap validation: could not convert to UTC",
            { traceId, f1EndLocal, f2StartLocal }
        );
    }

    // Diferencia directa para detectar solapamiento (F2 < F1_end).
    const rawDiffMinutes =
        (f2StartUtc.getTime() - f1EndUtc.getTime()) / 60000;

    if (rawDiffMinutes < 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            `Dual gap validation: F2 starts before F1 ends (${rawDiffMinutes.toFixed(2)} min)`,
            { traceId, gapMinutes: rawDiffMinutes }
        );
    }

    // FIX-34: gap canonico via bookingUtils.
    const gapMinutes = computeGapMinutes(f1EndUtc, f2StartUtc);

    if (gapMinutes > MAX_DUAL_GAP_MINUTES) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            `Dual gap validation: gap ${gapMinutes.toFixed(2)} min exceeds MAX (${MAX_DUAL_GAP_MINUTES})`,
            { traceId, gapMinutes, maxGapMinutes: MAX_DUAL_GAP_MINUTES }
        );
    }

    return { gapMinutes, maxGapMinutes: MAX_DUAL_GAP_MINUTES };
}

// =============================================================================
// BLOCK 9 - VALIDACION DEL SERVICIO F2 (linkedPhases) (FIX-32, FIX-36)
//
// Cambios:
//   - FIX-32: usa cleanGuidList (SSOT) en lugar de filter manual.
//   - FIX-36: retorna phase2Duration real del linked service para que el
//             llamante lo use al calcular f2LocalEnd cuando falta.
// =============================================================================
async function _validateLinkedPhaseService(linkedPhases, parentLocationId, traceId) {
    const linkedServiceId = _safeTrim(linkedPhases);
    if (!linkedServiceId || !_looksLikeGuid(linkedServiceId)) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            "Linked phase service: invalid GUID",
            { traceId, linkedPhases: linkedServiceId }
        );
    }

    const res = await wixData
        .query(SERVICIOSCOL)
        .eq("serviceId", linkedServiceId)
        .limit(1)
        .find({ suppressAuth: true })
        .catch(() => ({ items: [] }));

    const service = res?.items?.[0] || null;
    if (!service) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            `Linked phase service ${linkedServiceId} not found in catalog`,
            { traceId }
        );
    }

    if (service.hidden === true) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            `Linked phase service ${linkedServiceId} is hidden`,
            { traceId }
        );
    }

    const serviceType = _safeTrim(service.serviceType).toUpperCase();
    if (serviceType && serviceType !== "APPOINTMENT" && serviceType !== "CITA") {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            `Linked phase service ${linkedServiceId} is not APPOINTMENT (type=${serviceType})`,
            { traceId }
        );
    }

    // FIX-36: fallback adicional a phase1Duration por robustez.
    const phase2Duration = Number(
        service.phase2Duration ||
        service.totalDuration ||
        service.phase1Duration ||
        0
    );
    if (phase2Duration <= 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            `Linked phase service ${linkedServiceId} has invalid duration (${phase2Duration})`,
            { traceId }
        );
    }

    // FIX-32: cleanGuidList (SSOT) en lugar de filter manual.
    const availableStaff = cleanGuidList(service.availableStaff);
    if (availableStaff.length === 0) {
        throw createBookingError(
            ERROR_CODES.STAFF_UNAVAILABLE,
            `Linked phase service ${linkedServiceId} has no available staff`,
            { traceId }
        );
    }

    const parentLoc = _safeTrim(parentLocationId);
    const f2Loc = _safeTrim(service.locationId || service.location);
    if (parentLoc && f2Loc && parentLoc !== f2Loc) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            `Linked phase service ${linkedServiceId} has incompatible locationId (${f2Loc} != ${parentLoc})`,
            { traceId }
        );
    }

    return { service, phase2Duration, availableStaff };
}

// =============================================================================
// BLOCK 10 - COMPENSACION DE PERSISTENCIA CMS
// =============================================================================
async function _deleteCitasByPairToken(pairToken, traceId) {
    const token = _safeTrim(pairToken);
    if (!token) return;

    try {
        const res = await wixData
            .query(CITASCOL)
            .eq("pairToken", token)
            .limit(10)
            .find({ suppressAuth: true, suppressHooks: true });

        const items = res?.items || [];
        for (const item of items) {
            try {
                await wixData.remove(CITASCOL, item._id, { suppressAuth: true, suppressHooks: true });
                log.info("Compensated CitaF2 removal", {
                    citaId: item._id,
                    bookingId: item.bookingId,
                    traceId,
                });
            } catch (removeErr) {
                log.error("Failed to remove CitaF2 during compensation", {
                    citaId: item._id,
                    traceId,
                    error: removeErr?.message,
                });
            }
        }
    } catch (err) {
        log.error("_deleteCitasByPairToken failed", { pairToken: token, traceId, error: err?.message });
    }
}

// =============================================================================
// BLOCK 11 - UTILIDAD: GUID OR NULL
// =============================================================================
function _isGuidOrNull(value) {
    const v = _safeTrim(value);
    if (!v) return null;
    return _looksLikeGuid(v) ? v : null;
}

// =============================================================================
// BLOCK 12 - DETECCION DE ADDONS (FIX-35)
//
// BLOQUEADOR CONOCIDO: los addons no se inyectan en bookedEntity hasta
// confirmar el contrato exacto de Writer V2 createBooking:
//   (A) bookedEntity.slot.addOnIds
//   (B) bookedEntity.addOnIds
//   (C) bookedEntity.selectedAddOns: [{ addOnId, quantity }]
//   (D) Van al checkout como lineItems adicionales
//
// Hasta confirmar, se loguea WARNING con los IDs detectados y se persisten
// en meta de CitasF2 para trazabilidad, sin enviarlos a Writer V2.
// =============================================================================
function _detectAndWarnAddons(unsafePayload, metaCita, traceId) {
    const rawAddons =
        unsafePayload?.nativeAddonIds ||
        unsafePayload?.addonIds ||
        metaCita?.nativeAddonIds ||
        metaCita?.addonIds ||
        [];

    const addonIds = Array.isArray(rawAddons)
        ? rawAddons
              .map((id) => _safeTrim(id))
              .filter((id) => _looksLikeGuid(id))
        : [];

    if (addonIds.length > 0) {
        log.warn(
            "FIX-35: Addons detected but NOT injected into Writer V2 bookedEntity. " +
                "Confirm createBooking contract (slot.addOnIds | entity.addOnIds | " +
                "selectedAddOns | checkout).",
            {
                traceId,
                addonCount: addonIds.length,
                addonIds,
            }
        );
    }

    return addonIds;
}

// =============================================================================
// BLOCK 13 - SAGA ORCHESTRATOR
// =============================================================================
export class BookingSagaOrchestrator {
    constructor(traceId) {
        this.traceId = traceId;
        this.steps = [];
        this.completedSteps = [];
    }

    addStep(name, executeFn, compensateFn) {
        this.steps.push({ name: name, executeFn: executeFn, compensateFn: compensateFn });
    }

    async execute() {
        for (const step of this.steps) {
            try {
                log.info("Saga step: " + step.name, { traceId: this.traceId });
                const result = await step.executeFn();
                this.completedSteps.push(Object.assign({}, step, { result: result }));
            } catch (error) {
                log.error("Saga step failed: " + step.name, {
                    traceId: this.traceId,
                    error: error?.message,
                });
                await this._compensate();
                throw error;
            }
        }
        return this.completedSteps.map(function (s) { return s.result; });
    }

    async _compensate() {
        const reversed = [].concat(this.completedSteps).reverse();
        for (const step of reversed) {
            if (step.compensateFn) {
                try {
                    log.info("Saga compensating: " + step.name, { traceId: this.traceId });
                    await step.compensateFn(step.result);
                } catch (compErr) {
                    log.error("Saga compensation failed: " + step.name, {
                        traceId: this.traceId,
                        error: compErr?.message,
                    });
                }
            }
        }
    }
}

// =============================================================================
// BLOCK 14 - EXECUTE BOOKING SAGA (MAIN FUNCTION)
// =============================================================================
export async function executeBookingSaga(unsafePayload) {
    const traceId = unsafePayload?.traceId || makeTraceId("saga");
    const metaCita = _normalizePersistedMeta(unsafePayload?.metaCita || unsafePayload?.meta || {});

    // FIX-35: deteccion temprana de addons con WARNING.
    const detectedAddonIds = _detectAndWarnAddons(unsafePayload, metaCita, traceId);

    try {
        if (detectedAddonIds.length > 0) {
            throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Add-ons are not supported by this booking flow", { traceId });
        }
        // =========================================================================
        // PHASE 0: VALIDATION AND RESOLUTION
        // =========================================================================
        const email = _safeTrim(
            unsafePayload?.email || metaCita.email || unsafePayload?.contactDetails?.email
        );
        if (!email) {
            throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Email is required", { traceId: traceId });
        }

        const rawServiceId = _safeTrim(unsafePayload?.serviceId || metaCita.serviceId || "");
        const serviceId = await _resolveServiceIdInternal(rawServiceId);
        if (!serviceId || !_looksLikeGuid(serviceId)) {
            throw createBookingError(ERROR_CODES.SERVICE_NOT_FOUND, "Service not found", {
                traceId: traceId,
                rawServiceId: rawServiceId,
            });
        }

        const serviceRes = await _getServiceBySlugOrIdInternal(serviceId, traceId);
        const serviceConfig = serviceRes?.data || {};
        const isDual = serviceConfig.allowCombine === true && !!serviceConfig.linkedPhases;
        const linkedPhases = isDual ? _safeTrim(serviceConfig.linkedPhases) : null;
        if (isDual && !_looksLikeGuid(linkedPhases)) {
            throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Dual booking requires one linked service", { traceId });
        }
        const parentLocationId = _safeTrim(serviceConfig.locationId || serviceConfig.location);

        const requestedResourceId = _safeTrim(unsafePayload?.resourceId || metaCita.resourceId);
        const slotF1Input = unsafePayload?.slotF1 || {};
        const slotF2Input = unsafePayload?.slotF2 || {};

        const f1LocalStart = _normalizeLocalIsoStr(
            slotF1Input.localStartDate || slotF1Input.start || metaCita.f1Start
        );
        const f1LocalEnd = _normalizeLocalIsoStr(
            slotF1Input.localEndDate || slotF1Input.end || metaCita.f1End
        );

        if (!f1LocalStart || !f1LocalEnd) {
            throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "F1 slot dates are required", {
                traceId: traceId,
            });
        }

        let f2LocalStart = "";
        let f2LocalEnd = "";
        if (isDual) {
            f2LocalStart = _normalizeLocalIsoStr(
                slotF2Input.localStartDate || slotF2Input.start || metaCita.f2Start
            );
            f2LocalEnd = _normalizeLocalIsoStr(
                slotF2Input.localEndDate || slotF2Input.end || metaCita.f2End
            );

            // FIX-36: primero validar linked service, luego calcular F2 con
            // su duracion real (no la del padre).
            let linkedValidation = null;
            linkedValidation = await _validateLinkedPhaseService(
                linkedPhases,
                parentLocationId,
                traceId
            );

            if (!f2LocalStart) {
                const f1EndUtc = getUtcDateFromMadridLocal(f1LocalEnd);
                if (!f1EndUtc) {
                    throw createBookingError(
                        ERROR_CODES.INVALID_DATES,
                        "Could not compute F1 end UTC for F2 derivation",
                        { traceId }
                    );
                }
                const exposureMs =
                    Math.max(0, Number(serviceConfig.exposureDuration || 0)) * 60 * 1000;
                // FIX-36: phase2Duration real del linked, no del padre.
                const linkedPhase2Ms =
                    Math.max(0, Number(linkedValidation.phase2Duration || 30)) * 60 * 1000;
                const f2StartUtc = new Date(f1EndUtc.getTime() + exposureMs);
                const f2EndUtc = new Date(f2StartUtc.getTime() + linkedPhase2Ms);
                f2LocalStart = getMadridLocalStringNoZ(f2StartUtc);
                f2LocalEnd = getMadridLocalStringNoZ(f2EndUtc);
            }

            _validateDualGap(f1LocalEnd, f2LocalStart, traceId);
        }

        const pairToken = _resolveStablePairToken({
            serviceId: serviceId,
            resourceId: requestedResourceId,
            f1Start: f1LocalStart,
            f2Start: f2LocalStart,
            email: email,
            existingPairToken: unsafePayload?.pairToken || metaCita.pairToken,
        });

        // =========================================================================
        // PHASE 1: IDEMPOTENCY CHECK ON CITAS_F2
        // =========================================================================
        const existingCitaRes = await wixData
            .query(CITASCOL)
            .eq("pairToken", pairToken)
            .limit(1)
            .find({ suppressAuth: true, suppressHooks: true })
            .catch(function () { return { items: [] }; });

        if (existingCitaRes?.items?.length > 0) {
            const existingCita = existingCitaRes.items[0];
            const existingPaymentStatus = String(existingCita.paymentStatus || "").toUpperCase();

            if (existingPaymentStatus === ESTADO_PAGO.PENDING_PAYMENT) {
                log.info("Idempotent duplicate: PENDING_PAYMENT, returning existing checkout", {
                    pairToken: pairToken, traceId: traceId,
                });
                return {
                    status: "SUCCESS",
                    data: {
                        requiresPayment: true,
                        checkoutUrl: existingCita.meta?.checkoutUrl || null,
                        pairToken: pairToken,
                        idempotent: true,
                    },
                    error: null,
                };
            }

            log.info("Idempotent duplicate: existing cita found", {
                pairToken: pairToken, traceId: traceId, status: existingCita.status,
            });
            return {
                status: "SUCCESS",
                data: {
                    bookingId: existingCita.bookingId,
                    pairToken: pairToken,
                    status: existingCita.status,
                    idempotent: true,
                },
                error: null,
            };
        }

        // =========================================================================
        // PHASE 2: INIT TRANSACTION
        // =========================================================================
        const payloadHash = _hashKey(
            _stableSerialize({
                serviceId: serviceId,
                resourceId: requestedResourceId,
                f1LocalStart: f1LocalStart,
                f1LocalEnd: f1LocalEnd,
                f2LocalStart: f2LocalStart,
                f2LocalEnd: f2LocalEnd,
                email: email,
            })
        );

        const txResult = await _initTransaction(pairToken, payloadHash, traceId);
        if (!txResult.success) {
            if (txResult.error === "PAIR_TOKEN_PAYLOAD_MISMATCH") {
                throw createBookingError(ERROR_CODES.INVALID_PAYLOAD,
                    "Payload mismatch for existing pairToken", { traceId: traceId });
            }
            if (txResult.error === "TRANSACTION_PREVIOUSLY_FAILED") {
                throw createBookingError(ERROR_CODES.BOOKING_CREATION_FAILED,
                    "Previous transaction failed", { traceId: traceId });
            }
            if (txResult.existing?.status === "COMPLETED") {
                return {
                    status: "SUCCESS",
                    data: txResult.existing.result,
                    error: null,
                    idempotent: true,
                };
            }
            throw createBookingError(ERROR_CODES.TOKEN_BUSY,
                "Transaction in progress or timeout", { traceId: traceId });
        }

        // =========================================================================
        // PHASE 3: REAL-TIME REVALIDATION
        // =========================================================================
        const resourceValidation = await _resolveStaffForSlotInternal({
            serviceId: serviceId,
            f1Start: f1LocalStart,
            f1End: f1LocalEnd,
            f2Start: isDual ? f2LocalStart : null,
            f2End: isDual ? f2LocalEnd : null,
            requestedResourceId: requestedResourceId || null,
            traceId: traceId,
        });

        if (resourceValidation?.status !== "SUCCESS") {
            await _failTransaction(
                pairToken,
                resourceValidation?.error?.code || "SLOT_UNAVAILABLE"
            );
            throw createBookingError(
                resourceValidation?.error?.code || ERROR_CODES.SLOT_UNAVAILABLE,
                resourceValidation?.error?.message || "Slot no longer available", { traceId: traceId }
            );
        }

        const finalResourceId = resourceValidation.data.resourceId;
        const validatedSlotF1 = resourceValidation.data.slotF1;
        const validatedSlotF2 = resourceValidation.data.slotF2;

        if (isDual && validatedSlotF1 && validatedSlotF2) {
            const f1EndFromValidated = _normalizeLocalIsoStr(
                validatedSlotF1.localEndDate || validatedSlotF1.endDate || f1LocalEnd
            );
            const f2StartFromValidated = _normalizeLocalIsoStr(
                validatedSlotF2.localStartDate || validatedSlotF2.startDate || f2LocalStart
            );
            _validateDualGap(f1EndFromValidated, f2StartFromValidated, traceId);
        }

        // =========================================================================
        // PHASE 4: ACQUIRE LOCKS + HEARTBEAT
        // =========================================================================
        const phases = [{
            rawSlot: Object.assign({}, validatedSlotF1, { serviceId: serviceId }),
            localStart: f1LocalStart,
            localEnd: f1LocalEnd,
        }];
        if (isDual && f2LocalStart) {
            phases.push({
                rawSlot: { serviceId: linkedPhases },
                localStart: f2LocalStart,
                localEnd: f2LocalEnd,
            });
        }

        const lockKeys = _buildLockKeys(phases, finalResourceId);
        const lockOwnerId = pairToken;
        let heartbeatInterval = null;

        const saga = new BookingSagaOrchestrator(traceId);
        const createdBookings = [];

        saga.addStep(
            "LockSlots",
            async function () {
                for (const lockKey of lockKeys) {
                    const lockResult = await _lockSlotKeyOrFail(lockKey, lockOwnerId, LOCKTTLMS);
                    if (!lockResult?.ok) {
                        throw createBookingError(
                            ERROR_CODES.TOKEN_BUSY,
                            "Lock failed: " + (lockResult?.message || "unknown"),
                            { traceId: traceId, lockKey: lockKey }
                        );
                    }
                }
                heartbeatInterval = setInterval(function () {
                    lockKeys.forEach(function (key) {
                        _renewLock(key, lockOwnerId, LOCKTTLMS).catch(function (err) {
                            log.warn("heartbeat: lock renewal failed", {
                                key: key, traceId: traceId, error: err?.message,
                            });
                        });
                    });
                }, HEARTBEATMS);
                return { lockKeys: lockKeys };
            },
            async function () {
                if (heartbeatInterval) {
                    clearInterval(heartbeatInterval);
                    heartbeatInterval = null;
                }
                await _bestEffortUnlockAll(lockKeys, lockOwnerId);
            }
        );

        // =========================================================================
        // CREACION SECUENCIAL + CAPTURA DE scheduleId REAL
        //
        // FIX-35: los addons detectados se persisten en meta de CitasF2
        // pero NO se envian a Writer V2 hasta confirmar contrato.
        // =========================================================================
        saga.addStep(
            "CreateBookings",
            async function () {
                const pristineF1 = await _forceStaffInPristineSlot(
                    validatedSlotF1, finalResourceId, serviceId, serviceConfig.phase1Duration
                );
                if (!pristineF1) {
                    throw createBookingError(ERROR_CODES.INVALID_PAYLOAD,
                        "Failed to build pristine slot F1", { traceId: traceId });
                }

                const contactDetails = {
                    firstName: _safeTrim(unsafePayload?.firstName || metaCita.firstName || ""),
                    lastName: _safeTrim(unsafePayload?.lastName || metaCita.lastName || ""),
                    email: email,
                    phone: _safeTrim(unsafePayload?.phone || metaCita.phone || ""),
                };

                // FIX-35 TODO: inyectar detectedAddonIds en bookedEntity cuando
                // se confirme el contrato de Writer V2.
                const f1Booking = {
                    bookedEntity: { slot: pristineF1 },
                    contactDetails: contactDetails,
                    totalParticipants: 1,
                };
                const f1Options = {
                    flowControlSettings: { skipAvailabilityValidation: false },
                };

                let bookingF1 = null;
                let bookingF2 = null;
                let pristineF2 = null;

                // --- F1 ---
                const resF1 = await _createBookingWithSelectiveElevation(f1Booking, f1Options, traceId);
                bookingF1 = resF1?.booking || resF1;
                const f1Id = _validateCreateBookingResponse(bookingF1, "F1", traceId);
                _checkDoubleBookingFlag(bookingF1, "F1", traceId);
                createdBookings.push({ bookingId: f1Id, phase: "F1" });

                // --- F2 (solo si dual) ---
                if (isDual && f2LocalStart && validatedSlotF2) {
                    pristineF2 = await _forceStaffInPristineSlot(
                        validatedSlotF2, finalResourceId, linkedPhases, linkedValidation?.phase2Duration
                    );
                    if (!pristineF2) {
                        throw createBookingError(ERROR_CODES.INVALID_PAYLOAD,
                            "Failed to build pristine slot F2", { traceId: traceId });
                    }

                    const f2Booking = {
                        bookedEntity: { slot: pristineF2 },
                        contactDetails: contactDetails,
                        totalParticipants: 1,
                    };
                    const f2Options = {
                        flowControlSettings: { skipAvailabilityValidation: false },
                    };

                    const resF2 = await _createBookingWithSelectiveElevation(f2Booking, f2Options, traceId);
                    bookingF2 = resF2?.booking || resF2;
                    const f2Id = _validateCreateBookingResponse(bookingF2, "F2", traceId);
                    _checkDoubleBookingFlag(bookingF2, "F2", traceId);
                    createdBookings.push({ bookingId: f2Id, phase: "F2" });
                }

                return {
                    bookingF1: bookingF1,
                    bookingF2: bookingF2,
                    createdBookings: createdBookings,
                    scheduleIdF1: _safeTrim(pristineF1?.scheduleId) || null,
                    scheduleIdF2: _safeTrim(pristineF2?.scheduleId) || null,
                };
            },
            async function () {
                await _compensateCreatedBookings(createdBookings, traceId);
            }
        );

        const paymentMethod = _safeTrim(
            unsafePayload?.paymentMethod || metaCita.paymentMethod || "PRESENCIAL"
        ).toUpperCase();
        const isOnline = paymentMethod === FORMA_PAGO.ONLINE;

        saga.addStep(
            isOnline ? "CreateCheckout" : "ConfirmPresencial",
            async function () {
                if (isOnline) {
                    const bookingIds = createdBookings
                        .map(function (b) { return b.bookingId; })
                        .filter(Boolean);
                    const checkoutPayload = {
                        lineItems: bookingIds.map(function (bookingId) {
                            return {
                                catalogReference: {
                                    appId: APP_IDS.BOOKINGS,
                                    catalogItemId: bookingId,
                                    options: {},
                                },
                                quantity: 1,
                            };
                        }),
                        channelType: "WEB",
                    };

                    // FIX-37: createCheckout SIN retry (idempotencia no
                    // garantizada por Wix eCommerce en timeout).
                    const checkoutRes = await withTimeout(
                        () => createCheckoutElevated(checkoutPayload),
                        CHECKOUT_TIMEOUT_MS,
                        "createCheckout"
                    );

                    // FIX-37: getCheckoutUrl con retry (lectura idempotente).
                    const checkoutUrl = await _executeWithRetry(
                        () =>
                            withTimeout(
                                () => getCheckoutUrlElevated(_extractCheckoutId(checkoutRes)),
                                API_TIMEOUT_MS,
                                "getCheckoutUrl"
                            ),
                        2,
                        300
                    );

                    return {
                        requiresPayment: true,
                        checkoutUrl: checkoutUrl,
                        bookingIds: bookingIds,
                    };
                } else {
                    for (const booking of createdBookings) {
                        // FIX-37: confirmOrDecline con retry (idempotente).
                        const confirmResult = await _executeWithRetry(
                            () =>
                                withTimeout(
                                    () =>
                                        confirmOrDeclineBookingElevated(booking.bookingId, {
                                            paymentStatus: "NOT_PAID",
                                        }),
                                    API_TIMEOUT_MS,
                                    "confirmOrDecline"
                                ),
                            2,
                            300
                        );
                        _checkDoubleBookingFlag(confirmResult, "CONFIRM_" + booking.phase, traceId);
                    }
                    return {
                        requiresPayment: false,
                        bookingIds: createdBookings.map(function (b) { return b.bookingId; }),
                    };
                }
            },
            async function () {}
        );

        const paymentStatus = isOnline ? ESTADO_PAGO.PENDING_PAYMENT : ESTADO_PAGO.UNPAID;
        const citaStatus = isOnline ? ESTADO_CITA.PENDING_PAYMENT : ESTADO_CITA.CONFIRMED;

        saga.addStep(
            "PersistCitas",
            async function () {
                const checkoutStepName = isOnline ? "CreateCheckout" : "ConfirmPresencial";
                const checkoutStepResult = saga.completedSteps
                    .find((s) => s.name === checkoutStepName)?.result || null;
                const resolvedCheckoutUrl = checkoutStepResult?.checkoutUrl || null;

                const createBookingsResult = saga.completedSteps
                    .find((s) => s.name === "CreateBookings")?.result || {};

                const bookingF1Id = createdBookings.find(function (b) { return b.phase === "F1"; })?.bookingId;
                const bookingF2Id = createdBookings.find(function (b) { return b.phase === "F2"; })?.bookingId;

                let scheduleIdF1 = _isGuidOrNull(createBookingsResult.scheduleIdF1);
                if (!scheduleIdF1) {
                    scheduleIdF1 = await _resolveScheduleIdForResource(finalResourceId, validatedSlotF1);
                }
                if (!scheduleIdF1) {
                    throw createBookingError(
                        ERROR_CODES.INVALID_PAYLOAD,
                        "Unable to resolve scheduleId for F1 (no value from pristine slot or staff fallback)",
                        { traceId, bookingId: bookingF1Id }
                    );
                }

                await _persistBooking({
                    bookingId: bookingF1Id,
                    revision: 1,
                    serviceId: serviceId,
                    scheduleId: scheduleIdF1,
                    resourceId: finalResourceId,
                    startDate: getUtcDateFromMadridLocal(f1LocalStart),
                    endDate: getUtcDateFromMadridLocal(f1LocalEnd),
                    dateYmd: f1LocalStart.slice(0, 10),
                    bookingType: isDual ? "DUAL_F1" : "SIMPLE",
                    status: citaStatus,
                    paymentStatus: paymentStatus,
                    pairToken: pairToken,
                    contactDetails: { email: email },
                    meta: {
                        uiPairToken: unsafePayload?.uiPairToken || pairToken,
                        f1Start: f1LocalStart,
                        f1End: f1LocalEnd,
                        f2Start: f2LocalStart || null,
                        f2End: f2LocalEnd || null,
                        checkoutUrl: resolvedCheckoutUrl,
                        // FIX-35: addons persistidos para trazabilidad.
                        nativeAddonIds: detectedAddonIds,
                    },
                    traceId: traceId,
                }, traceId);

                if (isDual && bookingF2Id) {
                    let scheduleIdF2 = _isGuidOrNull(createBookingsResult.scheduleIdF2);
                    if (!scheduleIdF2) {
                        scheduleIdF2 = await _resolveScheduleIdForResource(finalResourceId, validatedSlotF2);
                    }
                    if (!scheduleIdF2) {
                        throw createBookingError(
                            ERROR_CODES.INVALID_PAYLOAD,
                            "Unable to resolve scheduleId for F2 (no value from pristine slot or staff fallback)",
                            { traceId, bookingId: bookingF2Id }
                        );
                    }

                    await _persistBooking({
                        bookingId: bookingF2Id,
                        revision: 1,
                        serviceId: linkedPhases,
                        scheduleId: scheduleIdF2,
                        resourceId: finalResourceId,
                        startDate: getUtcDateFromMadridLocal(f2LocalStart),
                        endDate: getUtcDateFromMadridLocal(f2LocalEnd),
                        dateYmd: f2LocalStart.slice(0, 10),
                        bookingType: "DUAL_F2",
                        status: citaStatus,
                        paymentStatus: paymentStatus,
                        pairToken: pairToken,
                        contactDetails: { email: email },
                        meta: {
                            uiPairToken: unsafePayload?.uiPairToken || pairToken,
                            linkedF1BookingId: bookingF1Id,
                            // FIX-35: addons persistidos tambien en F2.
                            nativeAddonIds: detectedAddonIds,
                        },
                        traceId: traceId,
                    }, traceId);
                }

                return {
                    bookingF1Id: bookingF1Id,
                    bookingF2Id: bookingF2Id || null,
                    resolvedCheckoutUrl: resolvedCheckoutUrl,
                    citaStatus: citaStatus,
                    isOnline: isOnline,
                };
            },
            async function () {
                await _deleteCitasByPairToken(pairToken, traceId);
            }
        );

        // =========================================================================
        // PHASE 5: EXECUTE SAGA
        // =========================================================================
        const sagaStartTime = Date.now();
        try {
            await saga.execute();

            const persistStepResult = saga.completedSteps
                .find((s) => s.name === "PersistCitas")?.result || null;

            const finalResult = {
                bookingIds: createdBookings.map(function (b) { return b.bookingId; }),
                pairToken: pairToken,
                requiresPayment: isOnline,
                checkoutUrl: persistStepResult?.resolvedCheckoutUrl || null,
                status: persistStepResult?.citaStatus || citaStatus,
            };

            try {
                await _completeTransaction(pairToken, finalResult, traceId);
            } catch (completeErr) {
                log.error("_completeTransaction failed; compensating full saga", {
                    pairToken,
                    traceId,
                    error: completeErr?.message,
                });
                try {
                    await _deleteCitasByPairToken(pairToken, traceId);
                } catch (_) { /* best effort */ }
                try {
                    await _compensateCreatedBookings(createdBookings, traceId);
                } catch (_) { /* best effort */ }
                throw completeErr;
            }

            const madridDateYMD = f1LocalStart.slice(0, 10);
            const serviceIdForInvalidate = serviceId;
            const resourceIdForInvalidate = finalResourceId;
            setTimeout(function () {
                _invalidateCachesInternal(
                    serviceIdForInvalidate, madridDateYMD, resourceIdForInvalidate, traceId
                ).catch(function (e) {
                    log.warn("Post-commit cache invalidation failed (background)", {
                        traceId, error: e?.message,
                    });
                });
            }, 0);

            log.info("executeBookingSaga completed", {
                traceId: traceId,
                pairToken: pairToken,
                isDual: isDual,
                bookingIds: createdBookings.map(function (b) { return b.bookingId; }),
                requiresPayment: isOnline,
                elapsedMs: Date.now() - sagaStartTime,
            });

            return { status: "SUCCESS", data: finalResult, error: null };

        } finally {
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
            await _bestEffortUnlockAll(lockKeys, lockOwnerId).catch(function () {});
        }

    } catch (error) {
        const norm = normalizeError(error);
        log.error("executeBookingSaga failed", {
            code: norm.code, error: norm.message, traceId: traceId,
        });
        return {
            status: "ERROR",
            data: null,
            error: {
                code: norm.code || ERROR_CODES.UNKNOWN_ERROR,
                message: norm.message,
            },
        };
    }
}
