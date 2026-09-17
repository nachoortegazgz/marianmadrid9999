/*
MODULE: backend/booking/bookingSaga.js
VERSION: v5008.0-MINIMAL-OFFICIAL
PURPOSE: Saga for simple and dual (gap) bookings. Official Create Booking payload only.
STANDARDS: ASCII only. Sequential F1 then F2. Zero deprecated APIs.
*/

import { bookings } from "wix-bookings.v2";
import { elevate } from "wix-auth";
import wixData from "wix-data";
import {
    COLLECTIONS,
    CONCURRENCY,
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
    createBookingError,
    normalizeError,
    ERROR_CODES,
    _extractCheckoutId,
} from "backend/booking/bookingCore";
import {
    _resolveServiceIdInternal,
    _invalidateCachesInternal,
    _getServiceBySlugOrIdInternal,
    _resolveStaffForSlotInternal,
} from "backend/reservas.web";

export { _extractCheckoutId };

const log = logger;
const LOCKTTLMS = Number(CONCURRENCY?.MUTEX_TTL_MS) || 300000;
const HEARTBEATMS = Number(CONCURRENCY?.HEARTBEAT_MS) || 15000;
const CITASCOL = COLLECTIONS.CITAS_F2;
const COMPENSACIONESCOL = COLLECTIONS.COMPENSACIONES_PENDIENTES;

function _resolveStablePairToken(opts) {
    const existing = _safeTrim(opts.existingPairToken);
    if (existing) return existing;
    const emailHash = _hashKey(_safeTrim(opts.email).toLowerCase());
    const payload = _stableSerialize({
        serviceId: _safeTrim(opts.serviceId),
        resourceId: _safeTrim(opts.resourceId),
        f1Start: _safeTrim(opts.f1Start),
        f2Start: _safeTrim(opts.f2Start || ""),
    });
    return "pt_" + _hashKey(payload + "|" + emailHash).slice(0, 32);
}

export function _normalizePersistedMeta(meta) {
    if (!meta || typeof meta !== "object") return {};
    try {
        if (typeof meta === "string") return JSON.parse(meta);
        return meta;
    } catch (_) {
        return {};
    }
}

async function _bestEffortUnlockAll(lockKeys, lockOwnerId) {
    for (const key of lockKeys || []) {
        try {
            await _unlockSlotKey(key, lockOwnerId);
        } catch (e) {
            log.warn("_bestEffortUnlockAll failed", { key, error: e?.message });
        }
    }
}

async function _compensateCreatedBookings(createdBookings, traceId) {
    for (const booking of createdBookings || []) {
        const bookingId = booking?.bookingId || booking?.id;
        if (!bookingId) continue;
        try {
            await cancelBookingElevated(bookingId, { suppressAuth: true });
            log.info("Compensated booking cancelled", { bookingId, traceId });
        } catch (cancelErr) {
            log.error("Compensation cancel failed; queuing", {
                bookingId,
                traceId,
                error: cancelErr?.message,
            });
            try {
                await wixData.insert(
                    COMPENSACIONESCOL,
                    {
                        id: "COMP" + bookingId + "_" + Date.now(),
                        kind: "CANCEL_BOOKING",
                        bookingId,
                        phase: booking?.phase || "UNKNOWN",
                        status: "PENDING",
                        attempts: 0,
                        amount: 0,
                        concept: "Booking compensation after saga failure",
                        alertRequired: true,
                        lastError: cancelErr?.message || "UNKNOWN",
                        traceId,
                        _createdDate: new Date(),
                        _updatedDate: new Date(),
                    },
                    { suppressAuth: true }
                );
            } catch (queueErr) {
                log.error("Failed to queue compensation", {
                    bookingId,
                    traceId,
                    error: queueErr?.message,
                });
            }
        }
    }
}

/**
 * Official Create Booking:
 *   createBooking(payload, options)
 *   payload: { bookedEntity: { slot }, contactDetails, totalParticipants }
 *   options: { flowControlSettings: { skipAvailabilityValidation } }
 * Elevate only on ACCESS_DENIED.
 */
async function _createBookingWithSelectiveElevation(payload, options, traceId) {
    try {
        return await bookings.createBooking(payload, options);
    } catch (err) {
        const code = _safeTrim(err?.code || err?.details?.applicationError?.code).toUpperCase();
        const isAccessDenied =
            code === "ACCESS_DENIED" || String(err?.message || "").toUpperCase().includes("ACCESS_DENIED");
        if (!isAccessDenied) throw err;
        log.info("Elevating createBooking due to ACCESS_DENIED", { traceId });
        return await elevate(bookings.createBooking)(payload, options);
    }
}

function _validateCreateBookingResponse(booking, phase, traceId) {
    const id = _safeTrim(booking?.id || booking?._id);
    if (!id || !_looksLikeGuid(id)) {
        throw createBookingError(
            ERROR_CODES.BOOKING_CREATION_FAILED,
            "Booking " + phase + " created but no valid ID returned",
            { traceId, phase }
        );
    }
    return id;
}

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

export class BookingSagaOrchestrator {
    constructor(traceId) {
        this.traceId = traceId;
        this.steps = [];
        this.completedSteps = [];
    }

    addStep(name, executeFn, compensateFn) {
        this.steps.push({ name, executeFn, compensateFn });
    }

    async execute() {
        for (const step of this.steps) {
            try {
                log.info("Saga step: " + step.name, { traceId: this.traceId });
                const result = await step.executeFn();
                this.completedSteps.push(Object.assign({}, step, { result }));
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
        const reversed = this.completedSteps.slice().reverse();
        for (const step of reversed) {
            if (!step.compensateFn) continue;
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

export async function executeBookingSaga(unsafePayload) {
    const traceId = unsafePayload?.traceId || makeTraceId("saga");
    const metaCita = _normalizePersistedMeta(unsafePayload?.metaCita || unsafePayload?.meta || {});

    try {
        const email = _safeTrim(
            unsafePayload?.email || metaCita.email || unsafePayload?.contactDetails?.email
        );
        if (!email) {
            throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Email is required", { traceId });
        }

        const rawServiceId = _safeTrim(unsafePayload?.serviceId || metaCita.serviceId || "");
        const serviceId = await _resolveServiceIdInternal(rawServiceId);
        if (!serviceId || !_looksLikeGuid(serviceId)) {
            throw createBookingError(ERROR_CODES.SERVICE_NOT_FOUND, "Service not found", {
                traceId,
                rawServiceId,
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
            throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "F1 slot dates are required", { traceId });
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
                const exposureMs = Math.max(0, Number(serviceConfig.exposureDuration || 0)) * 60 * 1000;
                const phase2Ms = Math.max(0, Number(serviceConfig.phase2Duration || 30)) * 60 * 1000;
                const f2StartUtc = new Date(f1EndUtc.getTime() + exposureMs);
                const f2EndUtc = new Date(f2StartUtc.getTime() + phase2Ms);
                f2LocalStart = getMadridLocalStringNoZ(f2StartUtc);
                f2LocalEnd = getMadridLocalStringNoZ(f2EndUtc);
            }
        }

        const pairToken = _resolveStablePairToken({
            serviceId,
            resourceId: requestedResourceId,
            f1Start: f1LocalStart,
            f2Start: f2LocalStart,
            email,
            existingPairToken: unsafePayload?.pairToken || metaCita.pairToken,
        });

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
                return {
                    status: "SUCCESS",
                    data: {
                        requiresPayment: true,
                        checkoutUrl: existingCita.meta?.checkoutUrl || null,
                        pairToken,
                        idempotent: true,
                    },
                    error: null,
                };
            }
            return {
                status: "SUCCESS",
                data: {
                    bookingId: existingCita.bookingId,
                    pairToken,
                    status: existingCita.status,
                    idempotent: true,
                },
                error: null,
            };
        }

        const payloadHash = _hashKey(
            _stableSerialize({
                serviceId,
                resourceId: requestedResourceId,
                f1LocalStart,
                f1LocalEnd,
                f2LocalStart,
                f2LocalEnd,
                email,
            })
        );

        const txResult = await _initTransaction(pairToken, payloadHash, traceId);
        if (!txResult.success) {
            if (txResult.error === "PAIR_TOKEN_PAYLOAD_MISMATCH") {
                throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Payload mismatch for existing pairToken", { traceId });
            }
            if (txResult.error === "TRANSACTION_PREVIOUSLY_FAILED") {
                throw createBookingError(ERROR_CODES.BOOKING_CREATION_FAILED, "Previous transaction failed", { traceId });
            }
            if (txResult.existing?.status === "COMPLETED") {
                return { status: "SUCCESS", data: txResult.existing.result, error: null, idempotent: true };
            }
            throw createBookingError(ERROR_CODES.TOKEN_BUSY, "Transaction in progress or timeout", { traceId });
        }

        const resourceValidation = await _resolveStaffForSlotInternal({
            serviceId,
            f1Start: f1LocalStart,
            f1End: f1LocalEnd,
            f2Start: isDual ? f2LocalStart : null,
            f2End: isDual ? f2LocalEnd : null,
            requestedResourceId: requestedResourceId || null,
            traceId,
        });

        if (resourceValidation?.status !== "SUCCESS") {
            await _failTransaction(pairToken, resourceValidation?.error?.code || "SLOT_UNAVAILABLE");
            throw createBookingError(
                resourceValidation?.error?.code || ERROR_CODES.SLOT_UNAVAILABLE,
                resourceValidation?.error?.message || "Slot no longer available",
                { traceId }
            );
        }

        const finalResourceId = resourceValidation.data.resourceId;
        const validatedSlotF1 = resourceValidation.data.slotF1;
        const validatedSlotF2 = resourceValidation.data.slotF2;

        const phases = [{
            rawSlot: Object.assign({}, validatedSlotF1, { serviceId }),
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
                            { traceId, lockKey }
                        );
                    }
                }
                heartbeatInterval = setInterval(function () {
                    lockKeys.forEach(function (key) {
                        _renewLock(key, lockOwnerId, LOCKTTLMS).catch(function (err) {
                            log.warn("heartbeat: lock renewal failed", { key, traceId, error: err?.message });
                        });
                    });
                }, HEARTBEATMS);
                return { lockKeys };
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
                    throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Failed to build pristine slot F1", { traceId });
                }

                const contactDetails = {
                    firstName: _safeTrim(unsafePayload?.firstName || metaCita.firstName || ""),
                    lastName: _safeTrim(unsafePayload?.lastName || metaCita.lastName || ""),
                    email,
                    phone: _safeTrim(unsafePayload?.phone || metaCita.phone || ""),
                };

                // Official contract: options is 2nd arg; totalParticipants required; no top-level serviceId
                const createOptions = { flowControlSettings: { skipAvailabilityValidation: true } };
                const f1Payload = {
                    bookedEntity: { slot: pristineF1 },
                    contactDetails,
                    totalParticipants: 1,
                };

                let bookingF1 = null;
                let bookingF2 = null;

                if (isDual && f2LocalStart && validatedSlotF2) {
                    // F1
                    let res = await _createBookingWithSelectiveElevation(f1Payload, createOptions, traceId);
                    bookingF1 = res?.booking || res;
                    const f1Id = _validateCreateBookingResponse(bookingF1, "F1", traceId);
                    _checkDoubleBookingFlag(bookingF1, "F1", traceId);
                    createdBookings.push({ bookingId: f1Id, phase: "F1" });

                    // F2 sequential (no race)
                    const pristineF2 = await _forceStaffInPristineSlot(
                        validatedSlotF2,
                        finalResourceId,
                        linkedPhases,
                        serviceConfig.phase2Duration
                    );
                    if (!pristineF2) {
                        throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Failed to build pristine slot F2", { traceId });
                    }
                    const f2Payload = {
                        bookedEntity: { slot: pristineF2 },
                        contactDetails,
                        totalParticipants: 1,
                    };
                    res = await _createBookingWithSelectiveElevation(f2Payload, createOptions, traceId);
                    bookingF2 = res?.booking || res;
                    const f2Id = _validateCreateBookingResponse(bookingF2, "F2", traceId);
                    _checkDoubleBookingFlag(bookingF2, "F2", traceId);
                    createdBookings.push({ bookingId: f2Id, phase: "F2" });
                } else {
                    const res = await _createBookingWithSelectiveElevation(f1Payload, createOptions, traceId);
                    bookingF1 = res?.booking || res;
                    const f1Id = _validateCreateBookingResponse(bookingF1, "F1", traceId);
                    _checkDoubleBookingFlag(bookingF1, "F1", traceId);
                    createdBookings.push({ bookingId: f1Id, phase: "F1" });
                }

                return { bookingF1, bookingF2, createdBookings };
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
                    const bookingIds = createdBookings.map(function (b) { return b.bookingId; }).filter(Boolean);
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
                    const checkoutUrl = await getCheckoutUrlElevated(_extractCheckoutId(checkoutRes));
                    return { requiresPayment: true, checkoutUrl, bookingIds };
                }
                for (const booking of createdBookings) {
                    const confirmResult = await confirmOrDeclineBookingElevated(booking.bookingId, {
                        paymentStatus: "NOT_PAID",
                    });
                    _checkDoubleBookingFlag(confirmResult, "CONFIRM_" + booking.phase, traceId);
                }
                return {
                    requiresPayment: false,
                    bookingIds: createdBookings.map(function (b) { return b.bookingId; }),
                };
            },
            async function () {}
        );

        const sagaStartTime = Date.now();
        try {
            await saga.execute();

            const checkoutStepName = isOnline ? "CreateCheckout" : "ConfirmPresencial";
            const checkoutStepResult =
                saga.completedSteps.find(function (s) { return s.name === checkoutStepName; })?.result || null;
            const resolvedCheckoutUrl = checkoutStepResult?.checkoutUrl || null;

            const bookingF1Id = createdBookings.find(function (b) { return b.phase === "F1"; })?.bookingId;
            const bookingF2Id = createdBookings.find(function (b) { return b.phase === "F2"; })?.bookingId;

            const paymentStatus = isOnline ? ESTADO_PAGO.PENDING_PAYMENT : ESTADO_PAGO.UNPAID;
            const citaStatus = isOnline ? ESTADO_CITA.PENDING_PAYMENT : ESTADO_CITA.CONFIRMED;

            await _persistBooking(
                {
                    bookingId: bookingF1Id,
                    revision: 1,
                    serviceId,
                    scheduleId: null,
                    resourceId: finalResourceId,
                    startDate: getUtcDateFromMadridLocal(f1LocalStart),
                    endDate: getUtcDateFromMadridLocal(f1LocalEnd),
                    bookingType: isDual ? "DUAL_F1" : "SIMPLE",
                    status: citaStatus,
                    paymentStatus,
                    pairToken,
                    contactDetails: { email },
                    meta: {
                        uiPairToken: unsafePayload?.uiPairToken || pairToken,
                        f1Start: f1LocalStart,
                        f1End: f1LocalEnd,
                        f2Start: f2LocalStart || null,
                        f2End: f2LocalEnd || null,
                        checkoutUrl: resolvedCheckoutUrl,
                    },
                    traceId,
                },
                traceId
            );

            if (isDual && bookingF2Id) {
                await _persistBooking(
                    {
                        bookingId: bookingF2Id,
                        revision: 1,
                        serviceId: linkedPhases,
                        scheduleId: null,
                        resourceId: finalResourceId,
                        startDate: getUtcDateFromMadridLocal(f2LocalStart),
                        endDate: getUtcDateFromMadridLocal(f2LocalEnd),
                        bookingType: "DUAL_F2",
                        status: citaStatus,
                        paymentStatus,
                        pairToken,
                        contactDetails: { email },
                        meta: {
                            uiPairToken: unsafePayload?.uiPairToken || pairToken,
                            linkedF1BookingId: bookingF1Id,
                        },
                        traceId,
                    },
                    traceId
                );
            }

            const finalResult = {
                bookingIds: createdBookings.map(function (b) { return b.bookingId; }),
                pairToken,
                requiresPayment: isOnline,
                checkoutUrl: resolvedCheckoutUrl,
                status: citaStatus,
            };

            await _completeTransaction(pairToken, finalResult);
            await _invalidateCachesInternal(serviceId, f1LocalStart.slice(0, 10), finalResourceId, traceId);

            log.info("executeBookingSaga completed", {
                traceId,
                pairToken,
                isDual,
                bookingIds: finalResult.bookingIds,
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
            code: norm.code,
            error: norm.message,
            traceId,
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
