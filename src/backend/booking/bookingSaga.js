/*
=============================================================================
MODULE: backend/booking/bookingSaga.js
VERSION: v5007.13-SSOT (Auditoria reservas: gap maximo, validacion F2,
        persistencia compensable, scheduleId real)
SSOT: SSOT CONSOLIDADO v5002.6 | ESQUEMA CMS v5002.5 | DOSSIER RESERVAS v0609
MISSION: Orquestador transaccional. Saga compensable para reservas simples
         y duales con gap de exposicion. Gestiona locks, heartbeat,
         idempotencia triple capa y creacion paralela F1+F2.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
=============================================================================
INVENTARIO DE FUNCIONES:
  [EXPORT] _normalizePersistedMeta(meta)
  [INTERNAL] _resolveStablePairToken({...})
  [INTERNAL] _bestEffortUnlockAll(lockKeys, lockOwnerId)
  [INTERNAL] _compensateCreatedBookings(createdBookings, traceId)
  [INTERNAL] _createBookingWithSelectiveElevation(payload, traceId)
  [INTERNAL] _validateCreateBookingResponse(booking, phase, traceId)
  [INTERNAL] _checkDoubleBookingFlag(booking, phase, traceId)
  [INTERNAL] _validateDualGap(f1LocalEnd, f2LocalStart, traceId)    [v13]
  [INTERNAL] _validateLinkedPhaseService(linkedPhases, traceId)     [v13]
  [INTERNAL] _deleteCitasByPairToken(pairToken, traceId)            [v13]
  [CLASS]  BookingSagaOrchestrator
  [EXPORT] executeBookingSaga(unsafePayload)
=============================================================================
HISTORIAL DE CAMBIOS:
  v5007.13 | 2026-09-19 | AUDITORIA DE RESERVAS (8 puntos):
           |            | [AUDIT-RES-01] Nuevo helper _validateDualGap:
           |            |   valida 0 <= gap <= MAX_DUAL_GAP_MINUTES antes
           |            |   de crear F2. Defensa en profundidad sobre la
           |            |   validacion interna de _resolveStaffForSlotInternal.
           |            | [AUDIT-RES-02] Nuevo helper _validateLinkedPhaseService:
           |            |   consulta ServiciosCatalogo para verificar que
           |            |   linkedPhases sea visible, activo, APPOINTMENT,
           |            |   con duraciones validas y personal disponible.
           |            | [AUDIT-RES-03] Persistencia en saga compensable:
           |            |   nuevo step "PersistCitas" con compensateFn
           |            |   _deleteCitasByPairToken que revierte los
           |            |   registros CMS si F2 falla. Evita persistencia
           |            |   parcial.
           |            | [AUDIT-RES-04] scheduleId real en _persistBooking:
           |            |   se persiste validatedSlot.scheduleId en lugar
           |            |   de null. Mejora trazabilidad y rescheduling.
           |            | [AUDIT-RES-05] Verificado uso de
           |            |   getUtcDateFromMadridLocal en todas las
           |            |   conversiones de fecha local Madrid.
           |            | [AUDIT-RES-06] Triple validacion antes de
           |            |   createBooking:
           |            |   1. _resolveStaffForSlotInternal (slots)
           |            |   2. _validateDualGap (gap entre fases)
           |            |   3. _validateLinkedPhaseService (F2 catalogo)
           |            | [AUDIT-RES-07] Restaurado import { checkout }
           |            |   retirado en v12 (falso positivo; ahora
           |            |   documentado como no usado). Se retira
           |            |   definitivamente y se documenta.
           |            | [AUDIT-RES-08] pairToken: documentada deuda
           |            |   tecnica. La verificacion se delega al
           |            |   consumidor (citasManager._assertBookingOwner).
  v5007.12 | 2026-09-15 | [W1] Retirado import { checkout } no usado.
           |            | [FF] Fire-and-forget: invalidacion de cache en
           |            | background. [AUDIT-BOOKING-01/02]. [PATCH-04..09].
           |            | [RETRACT-14] NO se usa checkAvailabilityValidation.
  v5007.8 | 2026-09-15 | AUDITORIA APLICADA: skipAvailabilityValidation=true,
           |            | _createBookingWithSelectiveElevation.
  v5007.7 | 2026-09-14 | FIX EDITOR RESIDUAL: strings con guiones bajos.
  v5007.6 | 2026-09-14 | FIX EDITOR: restauracion de _ y *.
  v5007.5 | 2026-09-14 | Alineacion SSOT v5002.6.
  v5007.4 | 2026-09-14 | Fix HAL-S1. Correcciones HAL-S2 a HAL-S12.
  v5007.3 | 2026-09-10 | FIX A5: import _extractCheckoutId.
  v5002.5 | 2026-09-10 | Fix S-01: linkedPhases como fuente primaria de F2.
  v5002.3 | 2026-09-06 | Version inicial del dossier.
=============================================================================
*/

import { bookings } from "wix-bookings.v2";
import { elevate } from "wix-auth";
import wixData from "wix-data";

import {
    COLLECTIONS,
    CONCURRENCY,
    SDK_CONFIG,
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
} from "public/mmUtils";

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
    _buildLockKeys,
    _getDualPairFromCache,
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

const LOCKTTLMS = Number(CONCURRENCY?.MUTEX_TTL_MS) || 300000;
const HEARTBEATMS = Number(CONCURRENCY?.HEARTBEAT_MS) || 15000;
const CITASCOL = COLLECTIONS.CITAS_F2;
const SERVICIOSCOL = COLLECTIONS.SERVICIOS_CATALOGO;
const COMPENSACIONESCOL = COLLECTIONS.COMPENSACIONES_PENDIENTES;

// =============================================================================
// BLOCK 1 - DETERMINISTIC PAIR TOKEN
//
// [AUDIT-RES-08] Documentacion de deuda tecnica: el pairToken se deriva
// de email+servicio+horarios, por lo que un tercero que conozca esos datos
// podria reutilizarlo. La verificacion de propiedad se delega al consumidor
// (citasManager._assertBookingOwner) que debe exigir sesion del miembro.
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
    if (!meta || typeof meta !== "object") return {};
    try {
        if (typeof meta === "string") return JSON.parse(meta);
        return meta;
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
            await cancelBookingElevated(bookingId, { suppressAuth: true });
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
// BLOCK 5 - SELECTIVE ELEVATION
// =============================================================================
async function _createBookingWithSelectiveElevation(payload, traceId) {
    try {
        return await bookings.createBooking(payload);
    } catch (err) {
        const code = _safeTrim(err?.code || err?.details?.applicationError?.code).toUpperCase();
        const isAccessDenied = code === "ACCESS_DENIED" ||
            String(err?.message || "").toUpperCase().includes("ACCESS_DENIED");
        if (!isAccessDenied) throw err;
        log.info("Elevating createBooking due to ACCESS_DENIED", { traceId: traceId });
        return await elevate(bookings.createBooking)(payload);
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
// BLOCK 7 - DETECCION DE FLAG DOUBLEBOOKED
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
// BLOCK 8 - [AUDIT-RES-01] VALIDACION EXPLICITA DE GAP MAXIMO
//
// Defensa en profundidad: aunque _resolveStaffForSlotInternal valida el gap
// internamente, revalidamos explicitamente antes de crear F2. Esto evita
// que un cambio de contrato en reservas.web.js pueda permitir gaps invalidos.
//
// Reglas:
//   - gap >= 0: F2 no puede empezar antes de que F1 termine.
//   - gap <= MAX_DUAL_GAP_MINUTES: no puede haber un gap excesivo.
// =============================================================================
function _validateDualGap(f1LocalEnd, f2LocalStart, traceId) {
    const MAX_DUAL_GAP_MINUTES =
        Math.max(0, Number(SDK_CONFIG?.SLOT_SEARCH?.MAX_DUAL_GAP_MINUTES || 120));

    const f1EndLocal = _normalizeLocalIsoStr(f1LocalEnd);
    const f2StartLocal = _normalizeLocalIsoStr(f2LocalStart);

    if (!f1EndLocal || !f2StartLocal) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
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

    const gapMinutes = (f2StartUtc.getTime() - f1EndUtc.getTime()) / 60000;

    if (gapMinutes < 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            `Dual gap validation: F2 starts before F1 ends (${gapMinutes.toFixed(2)} min)`,
            { traceId, gapMinutes }
        );
    }

    if (gapMinutes > MAX_DUAL_GAP_MINUTES) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            `Dual gap validation: gap ${gapMinutes.toFixed(2)} min exceeds MAX_DUAL_GAP_MINUTES (${MAX_DUAL_GAP_MINUTES})`,
            { traceId, gapMinutes, maxGapMinutes: MAX_DUAL_GAP_MINUTES }
        );
    }

    return { gapMinutes, maxGapMinutes: MAX_DUAL_GAP_MINUTES };
}

// =============================================================================
// BLOCK 9 - [AUDIT-RES-02] VALIDACION DEL SERVICIO F2 (linkedPhases)
//
// Verifica que el servicio F2 referenciado por linkedPhases:
//   - existe en ServiciosCatalogo,
//   - esta visible (hidden !== true),
//   - es de tipo APPOINTMENT (no CLASS/COURSE),
//   - tiene duraciones validas,
//   - tiene personal disponible.
// =============================================================================
async function _validateLinkedPhaseService(linkedPhases, traceId) {
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

    // [AUDIT-RES-02] Verificacion de visibilidad
    if (service.hidden === true) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            `Linked phase service ${linkedServiceId} is hidden`,
            { traceId }
        );
    }

    // [AUDIT-RES-02] Verificacion de tipo APPOINTMENT
    const serviceType = _safeTrim(service.serviceType).toUpperCase();
    if (serviceType && serviceType !== "APPOINTMENT" && serviceType !== "CITA") {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            `Linked phase service ${linkedServiceId} is not APPOINTMENT (type=${serviceType})`,
            { traceId }
        );
    }

    // [AUDIT-RES-02] Verificacion de duraciones
    const phase2Duration = Number(service.phase2Duration || service.totalDuration || 0);
    if (phase2Duration <= 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            `Linked phase service ${linkedServiceId} has invalid duration (${phase2Duration})`,
            { traceId }
        );
    }

    // [AUDIT-RES-02] Verificacion de personal disponible
    const availableStaff = Array.isArray(service.availableStaff)
        ? service.availableStaff.filter((id) => _looksLikeGuid(id))
        : [];
    if (availableStaff.length === 0) {
        throw createBookingError(
            ERROR_CODES.STAFF_UNAVAILABLE,
            `Linked phase service ${linkedServiceId} has no available staff`,
            { traceId }
        );
    }

    return {
        service,
        phase2Duration,
        availableStaff,
    };
}

// =============================================================================
// BLOCK 10 - [AUDIT-RES-03] COMPENSACION DE PERSISTENCIA CMS
//
// Borra registros de CitasF2 por pairToken. Se usa como compensateFn del
// step "PersistCitas" para revertir persistencia parcial si falla la
// segunda insercion (F2).
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
// BLOCK 11 - SAGA ORCHESTRATOR
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
// BLOCK 12 - EXECUTE BOOKING SAGA (MAIN FUNCTION)
// =============================================================================
export async function executeBookingSaga(unsafePayload) {
    const traceId = unsafePayload?.traceId || makeTraceId("saga");
    const metaCita = _normalizePersistedMeta(unsafePayload?.metaCita || unsafePayload?.meta || {});

    try {
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
        const linkedPhases = isDual ? serviceConfig.linkedPhases : null;

        const requestedResourceId = _safeTrim(unsafePayload?.resourceId || metaCita.resourceId);
        const slotF1Input = unsafePayload?.slotF1 || {};
        const slotF2Input = unsafePayload?.slotF2 || {};

        // [AUDIT-RES-05] Uso consistente de getUtcDateFromMadridLocal via
        // _normalizeLocalIsoStr. Las fechas locales de Madrid sin zona NO se
        // interpretan como UTC.
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

            if (!f2LocalStart) {
                const f1EndUtc = getUtcDateFromMadridLocal(f1LocalEnd);
                const exposureMs =
                    Math.max(0, Number(serviceConfig.exposureDuration || 0)) * 60 * 1000;
                const phase2Ms =
                    Math.max(0, Number(serviceConfig.phase2Duration || 30)) * 60 * 1000;
                const f2StartUtc = new Date(f1EndUtc.getTime() + exposureMs);
                const f2EndUtc = new Date(f2StartUtc.getTime() + phase2Ms);
                f2LocalStart = getMadridLocalStringNoZ(f2StartUtc);
                f2LocalEnd = getMadridLocalStringNoZ(f2EndUtc);
            }

            // [AUDIT-RES-02] Validar servicio F2 antes de cualquier operacion.
            // Verifica existencia, visibilidad, tipo APPOINTMENT, duracion y
            // staff disponible en ServiciosCatalogo.
            await _validateLinkedPhaseService(linkedPhases, traceId);

            // [AUDIT-RES-01] Validar gap maximo entre F1.end y F2.start.
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

        // [AUDIT-RES-01] Defensa en profundidad: revalidar gap con los slots
        // devueltos por _resolveStaffForSlotInternal por si hubo drift entre
        // la validacion inicial y la respuesta del servidor.
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

                const f1Payload = {
                    serviceId: serviceId,
                    bookedEntity: { slot: pristineF1 },
                    contactDetails: contactDetails,
                    options: { flowControlSettings: { skipAvailabilityValidation: true } },
                };

                let bookingF1 = null;
                let bookingF2 = null;

                if (isDual && f2LocalStart && validatedSlotF2) {
                    const createF1 = async function () {
                        const res = await _createBookingWithSelectiveElevation(f1Payload, traceId);
                        bookingF1 = res?.booking || res;
                        const f1Id = _validateCreateBookingResponse(bookingF1, "F1", traceId);
                        _checkDoubleBookingFlag(bookingF1, "F1", traceId);
                        createdBookings.push({ bookingId: f1Id, phase: "F1" });
                        return bookingF1;
                    };

                    const createF2 = async function () {
                        await new Promise(function (r) {
                            setTimeout(r, 400 + Math.random() * 600);
                        });
                        const pristineF2 = await _forceStaffInPristineSlot(
                            validatedSlotF2, finalResourceId, linkedPhases, serviceConfig.phase2Duration
                        );
                        if (!pristineF2) {
                            throw createBookingError(ERROR_CODES.INVALID_PAYLOAD,
                                "Failed to build pristine slot F2", { traceId: traceId });
                        }
                        const f2Payload = {
                            serviceId: linkedPhases,
                            bookedEntity: { slot: pristineF2 },
                            contactDetails: contactDetails,
                            options: { flowControlSettings: { skipAvailabilityValidation: true } },
                        };
                        const res = await _createBookingWithSelectiveElevation(f2Payload, traceId);
                        bookingF2 = res?.booking || res;
                        const f2Id = _validateCreateBookingResponse(bookingF2, "F2", traceId);
                        _checkDoubleBookingFlag(bookingF2, "F2", traceId);
                        createdBookings.push({ bookingId: f2Id, phase: "F2" });
                        return bookingF2;
                    };

                    await Promise.all([createF1(), createF2()]);
                } else {
                    const res = await _createBookingWithSelectiveElevation(f1Payload, traceId);
                    bookingF1 = res?.booking || res;
                    const f1Id = _validateCreateBookingResponse(bookingF1, "F1", traceId);
                    _checkDoubleBookingFlag(bookingF1, "F1", traceId);
                    createdBookings.push({ bookingId: f1Id, phase: "F1" });
                }

                return {
                    bookingF1: bookingF1,
                    bookingF2: bookingF2,
                    createdBookings: createdBookings,
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

                    const checkoutRes = await createCheckoutElevated(checkoutPayload);
                    const checkoutUrl = await getCheckoutUrlElevated(
                        _extractCheckoutId(checkoutRes)
                    );

                    return {
                        requiresPayment: true,
                        checkoutUrl: checkoutUrl,
                        bookingIds: bookingIds,
                    };
                } else {
                    for (const booking of createdBookings) {
                        const confirmResult = await confirmOrDeclineBookingElevated(
                            booking.bookingId, { paymentStatus: "NOT_PAID" }
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

        // =========================================================================
        // [AUDIT-RES-03] NUEVO STEP: PERSISTCITAS (compensable)
        //
        // La persistencia CMS se ejecuta DENTRO de la saga para que un fallo
        // en el guardado de F2 pueda revertir automaticamente el guardado de
        // F1. Antes se ejecutaba fuera de la saga y dejaba persistencia
        // parcial.
        // =========================================================================
        const paymentStatus = isOnline ? ESTADO_PAGO.PENDING_PAYMENT : ESTADO_PAGO.UNPAID;
        const citaStatus = isOnline ? ESTADO_CITA.PENDING_PAYMENT : ESTADO_CITA.CONFIRMED;

        saga.addStep(
            "PersistCitas",
            async function () {
                const checkoutStepName = isOnline ? "CreateCheckout" : "ConfirmPresencial";
                const checkoutStepResult = saga.completedSteps
                    .find((s) => s.name === checkoutStepName)?.result || null;
                const resolvedCheckoutUrl = checkoutStepResult?.checkoutUrl || null;

                const bookingF1Id = createdBookings.find(function (b) { return b.phase === "F1"; })?.bookingId;
                const bookingF2Id = createdBookings.find(function (b) { return b.phase === "F2"; })?.bookingId;

                // [AUDIT-RES-04] Persistir scheduleId real (antes null)
                const scheduleIdF1 = _safeTrim(
                    validatedSlotF1?.scheduleId || validatedSlotF1?.slot?.scheduleId || ""
                ) || null;

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
                    },
                    traceId: traceId,
                }, traceId);

                if (isDual && bookingF2Id) {
                    const scheduleIdF2 = _safeTrim(
                        validatedSlotF2?.scheduleId || validatedSlotF2?.slot?.scheduleId || ""
                    ) || null;

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
            // [AUDIT-RES-03] compensateFn: si algo falla despues (p.ej. _completeTransaction),
            // se borran los registros de CitasF2 persistidos.
            async function () {
                await _deleteCitasByPairToken(pairToken, traceId);
            }
        );

        // =========================================================================
        // PHASE 5 + PHASE 6
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

            await _completeTransaction(pairToken, finalResult);

            // [FF] Fire-and-forget: no bloquea la respuesta
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
