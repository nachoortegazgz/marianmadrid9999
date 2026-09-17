/*
=============================================================================
MODULE: backend/booking/bookingSaga.js
VERSION: v5007.10-SSOT (PATCH-06 + PATCH-07 + PATCH-08 + PATCH-09)
SSOT: SSOT CONSOLIDADO v5002.6 | ESQUEMA CMS v5002.5 | DOSSIER RESERVAS v0609
MISSION: Orquestador transaccional. Saga compensable para reservas simples
         y duales con gap de exposicion. Gestiona locks, heartbeat,
         idempotencia triple capa y creacion paralela F1+F2.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           Nomenclatura v19.6: serviceId, linkedPhases, resourceId.
=============================================================================
INVENTARIO DE FUNCIONES:
  [EXPORT] _normalizePersistedMeta(meta)
  [INTERNAL] _resolveStablePairToken({serviceId, resourceId, f1Start, f2Start, email, existingPairToken})
  [INTERNAL] _bestEffortUnlockAll(lockKeys, lockOwnerId)
  [INTERNAL] _compensateCreatedBookings(createdBookings, traceId)
  [INTERNAL] _createBookingWithSelectiveElevation(payload, traceId)
  [INTERNAL] _validateCreateBookingResponse(booking, phase, traceId)
  [INTERNAL] _checkDoubleBookingFlag(booking, phase, traceId)
  [CLASS]  BookingSagaOrchestrator
  [EXPORT] executeBookingSaga(unsafePayload)
=============================================================================
DEPENDENCIAS:
  - backend/internalConfig.js (COLLECTIONS, CONCURRENCY, SDK_CONFIG,
    ESTADO_CITA, ESTADO_PAGO, FORMA_PAGO, APP_IDS)
  - backend/logger.js (logger canonico)
  - backend/booking/bookingCore.js (primitivas atomicas, locks, transacciones)
  - backend/reservas.web.js (resolucion de servicios, slots, invalidacion cache)
  - public/mmUtils.js (makeTraceId, helpers seguros)
  - wix-bookings.v2, wix-ecom-backend, wix-auth, wix-data
=============================================================================
COLECCIONES QUE ESCRIBE: CitasF2, BookingTransactions, SlotLocks,
                         CompensacionesPendientes, DualSlotCache
COLECCIONES QUE LEE: ServiciosCatalogo, MapaStaff, CitasF2, BookingTransactions
=============================================================================
HISTORIAL DE CAMBIOS:
  v5007.10 | 2026-09-15 | PATCHES ALINEADOS CON DOC OFICIAL:
           |            | [PATCH-06] Elevacion selectiva mejorada:
           |            |   elevate(bookings.createBooking)(payload) en
           |            |   lugar de wrapper global. Ref: doc oficial
           |            |   "Keep elevation scoped to the specific call".
           |            | [PATCH-07] App ID canonico desde APP_IDS.BOOKINGS
           |            |   (no hardcoded). Ref: doc oficial checkout.
           |            | [PATCH-08] Validacion defensiva de respuesta de
           |            |   createBooking: verifica que booking.id existe.
           |            | [PATCH-09] Deteccion de flag doubleBooked tras
           |            |   confirmacion. Ref: doc oficial "system sets a
           |            |   booking's doubleBooked flag to true".
  v5007.9 | 2026-09-15 | PATCHES:
           |            | [PATCH-04] Extraccion nominal del step de checkout.
           |            | [PATCH-05] try/finally cleanup garantizado.
           |            | [FIX-COH-01] Logger desde backend/logger.
           |            | [FIX-COH-02] skipAvailabilityValidation=true.
  v5007.8 | 2026-09-15 | AUDITORIA APLICADA:
           |            | [AUDIT-BOOKING-01] skipAvailabilityValidation=true.
           |            | [AUDIT-BOOKING-02] _createBookingWithSelectiveElevation.
  v5007.7 | 2026-09-14 | FIX EDITOR RESIDUAL.
  v5007.6 | 2026-09-14 | FIX EDITOR.
  v5007.5 | 2026-09-14 | Alineacion SSOT v5002.6 completa.
  v5007.4 | 2026-09-14 | Fix HAL-S1.
  v5007.3 | 2026-09-10 | FIX A5.
  v5002.5 | 2026-09-10 | Fix S-01.
  v5002.3 | 2026-09-06 | Version inicial.
=============================================================================
*/

import { bookings } from "wix-bookings.v2";
import { checkout } from "wix-ecom-backend";
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

// [FIX-COH-01] logger importado directamente desde backend/logger
import { logger } from "backend/logger";

import {
    createBookingElevated,
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
const COMPENSACIONESCOL = COLLECTIONS.COMPENSACIONES_PENDIENTES;

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
                // [HAL-S12 FIX] kind aligned with internalConfig enum CANCEL_BOOKING
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
// BLOCK 5 - [AUDIT-BOOKING-02 + PATCH-06] SELECTIVE ELEVATION
//
// Referencia oficial Wix:
//   "Keep elevation scoped to the specific call that needs higher permissions.
//    Don't use elevation if the operation already works with the caller's
//    existing permissions."
//   "Be selective about when to use elevate(), especially when writing
//    backend code that can be triggered from the frontend using a web method."
//
// Patron:
//   1. Intento sin elevate -> respeta permisos del caller.
//   2. Si el error es ACCESS_DENIED -> se eleva la llamada especifica
//      (elevate(bookings.createBooking)) en lugar de usar un wrapper global
//      pre-elevado. Esto garantiza que la elevacion se aplica unicamente
//      cuando es necesaria.
//   3. Cualquier otro error -> propaga sin elevar.
// =============================================================================
async function _createBookingWithSelectiveElevation(payload, traceId) {
    try {
        // Intento sin elevate (respeta permisos del caller)
        return await bookings.createBooking(payload);
    } catch (err) {
        const code = _safeTrim(err?.code || err?.details?.applicationError?.code).toUpperCase();
        const isAccessDenied = code === "ACCESS_DENIED" ||
            String(err?.message || "").toUpperCase().includes("ACCESS_DENIED");

        if (!isAccessDenied) {
            throw err;
        }

        log.info("Elevating createBooking due to ACCESS_DENIED", { traceId: traceId });
        // [PATCH-06] Elevar la llamada especifica (no wrapper global)
        // Ref: "Keep elevation scoped to the specific call that needs
        //       higher permissions."
        return await elevate(bookings.createBooking)(payload);
    }
}

// =============================================================================
// BLOCK 6 - [PATCH-08] VALIDACION DEFENSIVA DE RESPUESTA DE CREATEBOOKING
//
// La doc oficial no garantiza que el objeto retornado tenga .id en todos
// los casos. Se valida defensivamente antes de continuar.
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
// BLOCK 7 - [PATCH-09] DETECCION DE FLAG DOUBLEBOOKED
//
// Ref doc oficial:
//   "Wix Bookings prevents double bookings by default, but conflicts can
//    occasionally occur. When they do, the system sets a booking's
//    doubleBooked flag to true and requires the business to manually
//    resolve the conflict."
//
// Se verifica el flag tras la confirmacion para detectar conflictos.
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
// BLOCK 8 - SAGA ORCHESTRATOR
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
// BLOCK 9 - EXECUTE BOOKING SAGA (MAIN FUNCTION)
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

        const rawServiceId = _safeTrim(
            unsafePayload?.serviceId ||
            metaCita.serviceId ||
            ""
        );
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
            const existingPaymentStatus = String(
                existingCita.paymentStatus || ""
            ).toUpperCase();

            if (existingPaymentStatus === ESTADO_PAGO.PENDING_PAYMENT) {
                log.info("Idempotent duplicate: PENDING_PAYMENT, returning existing checkout", {
                    pairToken: pairToken,
                    traceId: traceId,
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
                pairToken: pairToken,
                traceId: traceId,
                status: existingCita.status,
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
        // PHASE 2: INIT TRANSACTION ON BOOKING_TRANSACTIONS
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
                throw createBookingError(
                    ERROR_CODES.INVALID_PAYLOAD,
                    "Payload mismatch for existing pairToken", { traceId: traceId }
                );
            }
            if (txResult.error === "TRANSACTION_PREVIOUSLY_FAILED") {
                throw createBookingError(
                    ERROR_CODES.BOOKING_CREATION_FAILED,
                    "Previous transaction failed", { traceId: traceId }
                );
            }
            if (txResult.existing?.status === "COMPLETED") {
                return {
                    status: "SUCCESS",
                    data: txResult.existing.result,
                    error: null,
                    idempotent: true,
                };
            }
            throw createBookingError(
                ERROR_CODES.TOKEN_BUSY,
                "Transaction in progress or timeout", { traceId: traceId }
            );
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

        // =========================================================================
        // PHASE 4: ACQUIRE LOCKS + HEARTBEAT
        // =========================================================================
        const phases = [{
            rawSlot: Object.assign({}, validatedSlotF1, { serviceId: serviceId }),
            localStart: f1LocalStart,
            localEnd: f1LocalEnd,
        }, ];
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
                                "Lock failed: " + (lockResult?.message || "unknown"), { traceId: traceId, lockKey: lockKey }
                            );
                        }
                    }
                    heartbeatInterval = setInterval(function () {
                        lockKeys.forEach(function (key) {
                            // [PATCH-05] Loguear fallos de renovacion (no silenciar)
                            _renewLock(key, lockOwnerId, LOCKTTLMS).catch(function (err) {
                                log.warn("heartbeat: lock renewal failed", {
                                    key: key,
                                    traceId: traceId,
                                    error: err?.message,
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
                        validatedSlotF1,
                        finalResourceId,
                        serviceId,
                        serviceConfig.phase1Duration
                    );
                    if (!pristineF1) {
                        throw createBookingError(
                            ERROR_CODES.INVALID_PAYLOAD,
                            "Failed to build pristine slot F1", { traceId: traceId }
                        );
                    }

                    const contactDetails = {
                        firstName: _safeTrim(unsafePayload?.firstName || metaCita.firstName || ""),
                        lastName: _safeTrim(unsafePayload?.lastName || metaCita.lastName || ""),
                        email: email,
                        phone: _safeTrim(unsafePayload?.phone || metaCita.phone || ""),
                    };

                    // [FIX-COH-02] skipAvailabilityValidation=true
                    // Disponibilidad ya validada con Time Slots V2 en PHASE 3.
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
                            // [AUDIT-BOOKING-02 + PATCH-06] elevate selectivo
                            const res = await _createBookingWithSelectiveElevation(f1Payload, traceId);
                            bookingF1 = res?.booking || res;
                            // [PATCH-08] Validacion defensiva de respuesta
                            const f1Id = _validateCreateBookingResponse(bookingF1, "F1", traceId);
                            // [PATCH-09] Deteccion de flag doubleBooked
                            _checkDoubleBookingFlag(bookingF1, "F1", traceId);
                            createdBookings.push({
                                bookingId: f1Id,
                                phase: "F1",
                            });
                            return bookingF1;
                        };

                        const createF2 = async function () {
                            await new Promise(function (r) {
                                setTimeout(r, 400 + Math.random() * 600);
                            });
                            const pristineF2 = await _forceStaffInPristineSlot(
                                validatedSlotF2,
                                finalResourceId,
                                linkedPhases,
                                serviceConfig.phase2Duration
                            );
                            if (!pristineF2) {
                                throw createBookingError(
                                    ERROR_CODES.INVALID_PAYLOAD,
                                    "Failed to build pristine slot F2", { traceId: traceId }
                                );
                            }
                            // [FIX-COH-02] skipAvailabilityValidation=true
                            const f2Payload = {
                                serviceId: linkedPhases,
                                bookedEntity: { slot: pristineF2 },
                                contactDetails: contactDetails,
                                options: { flowControlSettings: { skipAvailabilityValidation: true } },
                            };
                            // [AUDIT-BOOKING-02 + PATCH-06] elevate selectivo
                            const res = await _createBookingWithSelectiveElevation(f2Payload, traceId);
                            bookingF2 = res?.booking || res;
                            // [PATCH-08] Validacion defensiva de respuesta
                            const f2Id = _validateCreateBookingResponse(bookingF2, "F2", traceId);
                            // [PATCH-09] Deteccion de flag doubleBooked
                            _checkDoubleBookingFlag(bookingF2, "F2", traceId);
                            createdBookings.push({
                                bookingId: f2Id,
                                phase: "F2",
                            });
                            return bookingF2;
                        };

                        await Promise.all([createF1(), createF2()]);
                    } else {
                        // [AUDIT-BOOKING-02 + PATCH-06] elevate selectivo
                        const res = await _createBookingWithSelectiveElevation(f1Payload, traceId);
                        bookingF1 = res?.booking || res;
                        // [PATCH-08] Validacion defensiva de respuesta
                        const f1Id = _validateCreateBookingResponse(bookingF1, "F1", traceId);
                        // [PATCH-09] Deteccion de flag doubleBooked
                        _checkDoubleBookingFlag(bookingF1, "F1", traceId);
                        createdBookings.push({
                            bookingId: f1Id,
                            phase: "F1",
                        });
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
            unsafePayload?.paymentMethod ||
            metaCita.paymentMethod ||
            "PRESENCIAL"
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
                                        // [PATCH-07] App ID canonico desde internalConfig
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
                            // [PATCH-09] Deteccion de flag doubleBooked en confirmacion
                            // Ref doc oficial: "If a session is double booked,
                            // confirmOrDeclineBooking() can catch this and decline
                            // the duplicate booking."
                            const confirmResult = await confirmOrDeclineBookingElevated(
                                booking.bookingId, {
                                    paymentStatus: "NOT_PAID",
                                }
                            );
                            // [PATCH-09] Deteccion post-confirmacion
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
        // [PATCH-05] PHASE 5 + PHASE 6 envueltos en try/finally
        // Garantiza cleanup de heartbeat y locks en cualquier path.
        // =========================================================================
        const sagaStartTime = Date.now();
        try {
            // =========================================================================
            // PHASE 5: EXECUTE SAGA
            // =========================================================================
            await saga.execute();

            // =========================================================================
            // PHASE 6: PERSIST TO CITAS_F2 + COMPLETE TRANSACTION
            // =========================================================================
            // [PATCH-04] Extraccion nominal del step de checkout/presencial
            const checkoutStepName = isOnline ? "CreateCheckout" : "ConfirmPresencial";
            const checkoutStepResult = saga.completedSteps
                .find((s) => s.name === checkoutStepName)?.result || null;
            const resolvedCheckoutUrl = checkoutStepResult?.checkoutUrl || null;

            const bookingF1Id = createdBookings.find(function (b) {
                return b.phase === "F1";
            })?.bookingId;
            const bookingF2Id = createdBookings.find(function (b) {
                return b.phase === "F2";
            })?.bookingId;

            const paymentStatus = isOnline ?
                ESTADO_PAGO.PENDING_PAYMENT :
                ESTADO_PAGO.UNPAID;
            const citaStatus = isOnline ?
                ESTADO_CITA.PENDING_PAYMENT :
                ESTADO_CITA.CONFIRMED;

            await _persistBooking({
                    bookingId: bookingF1Id,
                    revision: 1,
                    serviceId: serviceId,
                    scheduleId: null,
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
                },
                traceId
            );

            if (isDual && bookingF2Id) {
                await _persistBooking({
                        bookingId: bookingF2Id,
                        revision: 1,
                        serviceId: linkedPhases,
                        scheduleId: null,
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
                    },
                    traceId
                );
            }

            const finalResult = {
                bookingIds: createdBookings.map(function (b) { return b.bookingId; }),
                pairToken: pairToken,
                requiresPayment: isOnline,
                checkoutUrl: resolvedCheckoutUrl,
                status: citaStatus,
            };

            await _completeTransaction(pairToken, finalResult);

            const madridDateYMD = f1LocalStart.slice(0, 10);
            await _invalidateCachesInternal(serviceId, madridDateYMD, finalResourceId, traceId);

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
            // [PATCH-05] Cleanup garantizado
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
            await _bestEffortUnlockAll(lockKeys, lockOwnerId).catch(function () {});
        }

    } catch (error) {
        const norm = normalizeError(error);
        log.error("executeBookingSaga failed", {
            code: norm.code,
            error: norm.message,
            traceId: traceId,
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
