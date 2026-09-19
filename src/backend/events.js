/*
=============================================================================
MODULE: backend/events.js
VERSION: v5008.3-OPT
BASE: Modulos optimizados 3 + BIBLIA v5002.5 + DIRECTRICES V19
RESPONSIBILITY: Server-to-server native webhooks for Wix Bookings V2 and
                Wix eCommerce V2 with exact-indexed queries, bounded
                execution, full idempotency, and JWT signature verification.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).

FIXES APLICADOS v5008.3:
  - FIX-55: idempotencia uniforme por eventId en
            wixEcom_onOrderPaymentStatusUpdated (antes solo por
            transactionId). Evita reprocesar el mismo webhook si Wix
            reintenta tras timeout de respuesta.
  - FIX-56: recordOnlineInventoryOrderInternal se invoca DESPUES de
            confirmar el ledger. Antes se descontaba stock aunque el
            ledger fallara, generando inconsistencia temporal.
  - FIX-57: restockInfo documenta el path canonico
            event.sideEffects.restockInfo. Fallback con WARN si se usa
            un path secundario.
  - FIX-58: ESTADO_CITA.CANCELED (alias obsoleto) -> ESTADO_CITA.CANCELLED.
  - FIX-59: eliminado AppStrategy + process.env.WIX_PUBLIC_KEY (no
            existen en Velo). Uso de createClient({}) para webhooks
            site-level. _verifyAndDecodeWebhook acepta tanto rawBody
            (string) como evento ya decodificado (object).
=============================================================================
*/

import wixData from "wix-data";
import { createClient } from "@wix/sdk";

import {
    makeTraceId,
    _executeWithRetry,
    _normalizeIdPart,
    withTimeout,
    _roundMoney,
} from "public/mmUtils";

import {
    COLLECTIONS,
    APP_IDS,
    TIPO_MOVIMIENTO,
    FORMA_PAGO,
    ESTADO_CITA,
    ESTADO_PAGO,
    CITA_FIELDS,
    SDK_CONFIG,
} from "backend/internalConfig";

import { logger } from "backend/logger";
import { normalizeError, _updateCitaSafe } from "backend/booking/bookingCore";
import { registerBookingPayment, queueFiscalRecovery } from "backend/cajas.web";
import {
    recordOnlineInventoryOrderInternal,
    recordOnlineInventoryRefundInternal,
} from "backend/inventario.web";

import { logAuditEventWithTimeout } from "backend/audit";

const log = logger;

const WEBHOOK_RETRIES = Number(SDK_CONFIG?.EVENTS?.RETRY_ATTEMPTS) || 3;
const WEBHOOK_RETRY_DELAY_MS = Number(SDK_CONFIG?.EVENTS?.RETRY_BASE_BACKOFF_MS) || 1000;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.WEBHOOK_MS) || 30000;

// ============================================================================
// [FIX-59] WIX CLIENT
//
// createClient({}) sin AppStrategy. Los webhooks site-level se verifican
// con el contexto de la propia site; no requieren public key externa.
// Si la version instalada de @wix/sdk no expone wixClient.webhooks.process,
// las funciones exportadas aceptaran el evento ya decodificado (object).
// ============================================================================

const wixClient = createClient({});

async function _verifyAndDecodeWebhook(rawBody, expectedEventType) {
    try {
        if (!rawBody) {
            log.warn("WEBHOOK_EMPTY_BODY", { expectedEventType });
            return null;
        }

        // Si rawBody es ya un objeto (evento ya decodificado por Wix),
        // devolverlo tal cual.
        if (typeof rawBody === "object" && !(rawBody instanceof String)) {
            return rawBody;
        }

        // Si es string, intentar decodificar via SDK.
        if (typeof wixClient?.webhooks?.process !== "function") {
            log.error("WEBHOOK_PROCESS_NOT_AVAILABLE", {
                expectedEventType,
                hint: "El runtime debe entregar el evento ya decodificado.",
            });
            return null;
        }

        const event = await wixClient.webhooks.process(rawBody);

        if (!event) {
            log.warn("WEBHOOK_VERIFICATION_FAILED", { expectedEventType });
            return null;
        }

        log.debug("WEBHOOK_VERIFIED", {
            eventType: event.eventType || expectedEventType,
            hasData: !!event.data,
        });

        return event;
    } catch (err) {
        log.error("WEBHOOK_JWT_VERIFICATION_FAILED", {
            expectedEventType,
            error: err?.message || String(err),
        });
        return null;
    }
}

function _normalizeBookingIds(value) {
    const values = Array.isArray(value) ? value : String(value || "").split(",");
    return Array.from(new Set(values.map((id) => String(id || "").trim()).filter(Boolean)));
}

const PROCESSED_EVENTS_COL = COLLECTIONS.PROCESSED_WEBHOOK_EVENTS;
const EVENT_TTL_HOURS = 72;

// ============================================================================
// EVENT STRUCTURE VALIDATION
// ============================================================================

function validateEventStructure(event, requiredFields) {
    if (!event || typeof event !== "object") {
        log.warn("EVENT_INVALID_STRUCTURE", { hasEvent: !!event });
        return false;
    }
    for (const field of requiredFields) {
        const value = field.split(".").reduce((obj, key) => obj?.[key], event);
        if (value === undefined || value === null) {
            log.warn("EVENT_MISSING_FIELD", { field, eventId: event.eventId || event._id });
            return false;
        }
    }
    return true;
}

// ============================================================================
// IDEMPOTENCY
// ============================================================================

async function isEventProcessed(eventId) {
    if (!eventId) { return false; }
    const normalizedId = _normalizeIdPart(String(eventId), 100);
    const existing = await wixData.get(PROCESSED_EVENTS_COL, normalizedId, { suppressAuth: true })
        .catch(() => null);
    return !!existing;
}

async function markEventAsProcessed(eventId, eventType, traceId, metadata = {}) {
    if (!eventId) { return; }
    const normalizedId = _normalizeIdPart(String(eventId), 100);
    const expiryDate = new Date(Date.now() + EVENT_TTL_HOURS * 3600 * 1000);
    try {
        await wixData.insert(PROCESSED_EVENTS_COL, {
            _id: normalizedId,
            eventId: String(eventId),
            eventType,
            traceId,
            processedAt: new Date(),
            expiresAt: expiryDate,
            metadata,
            status: "PROCESSED",
        }, { suppressAuth: true });
        log.debug("EVENT_MARKED_PROCESSED", { eventId, eventType });
    } catch (err) {
        log.debug("EVENT_INSERT_CONFLICT", { eventId, error: err.message });
    }
}

function _handleError(error, context, traceId) {
    const normalized = normalizeError(error);
    log.error(`Error in ${context}`, { error: normalized.message, traceId });
    return { code: normalized.code, message: normalized.message };
}

// ============================================================================
// CITA STATUS UPDATES
// ============================================================================

async function _updateCitaStatus(bookingId, nuevoEstado, traceId) {
    await _updateCitaSafe(bookingId, (cita) => {
        if (String(cita[CITA_FIELDS.STATUS] || "").toUpperCase() === String(nuevoEstado || "").toUpperCase()) {
            return null;
        }
        return {
            ...cita,
            [CITA_FIELDS.STATUS]: String(nuevoEstado || ESTADO_CITA.CONFIRMED).toUpperCase(),
        };
    }, traceId, "events_updateCitaEstado");
}

async function _markCitasRefundedByBookingIds(bookingIds, orderId, refundId, fullyRefunded, traceId) {
    const ids = _normalizeBookingIds(bookingIds);
    const results = await Promise.allSettled(
        ids.map((bookingId) =>
            _updateCitaSafe(bookingId, (cita) => {
                const meta = cita.meta || {};
                const paymentState = fullyRefunded ? ESTADO_PAGO.REFUNDED : ESTADO_PAGO.PARTIALLY_REFUNDED;
                return {
                    ...cita,
                    ...(fullyRefunded ? {
                        [CITA_FIELDS.STATUS]: ESTADO_CITA.REFUNDED } : {}),
                    [CITA_FIELDS.STATUS_PAGO]: paymentState,
                    meta: {
                        ...meta,
                        [CITA_FIELDS.STATUS_PAGO]: paymentState,
                        orderId: orderId || null,
                        refundId: refundId || null,
                        fechaReembolso: new Date(),
                    },
                };
            }, traceId, "events_markRefunded")
        )
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        log.warn("Some citas failed to update refund status", {
            traceId,
            orderId,
            totalIds: ids.length,
            failedCount: failures.length,
        });
    }
}

async function _markCitasPaidByBookingIds(bookingIds, orderId, traceId) {
    const ids = _normalizeBookingIds(bookingIds);
    const results = await Promise.allSettled(
        ids.map((bookingId) =>
            _updateCitaSafe(bookingId, (cita) => {
                const meta = cita.meta || {};
                const alreadyPaid = String(meta.paymentStatus || cita.paymentStatus || "").toUpperCase() === ESTADO_PAGO.PAID;
                if (alreadyPaid) { return null; }
                return {
                    ...cita,
                    [CITA_FIELDS.STATUS]: ESTADO_CITA.CONFIRMED,
                    [CITA_FIELDS.STATUS_PAGO]: ESTADO_PAGO.PAID,
                    meta: {
                        ...meta,
                        [CITA_FIELDS.STATUS_PAGO]: ESTADO_PAGO.PAID,
                        orderId: orderId || null,
                        fechaConfirmacionPago: new Date(),
                    },
                };
            }, traceId, "events_markPaid")
        )
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        log.warn("Some citas failed to update payment status", {
            traceId,
            orderId,
            totalIds: ids.length,
            failedCount: failures.length,
        });
    }
}

async function _markCitasPendingLedgerByBookingIds(bookingIds, orderId, traceId) {
    const ids = _normalizeBookingIds(bookingIds);
    const results = await Promise.allSettled(
        ids.map((bookingId) =>
            _updateCitaSafe(bookingId, (cita) => {
                const meta = cita.meta || {};
                const currentPaymentState = String(meta.paymentStatus || cita.paymentStatus || "").toUpperCase();
                if (currentPaymentState === ESTADO_PAGO.PAID) { return null; }
                return {
                    ...cita,
                    [CITA_FIELDS.STATUS_PAGO]: ESTADO_PAGO.PENDING_LEDGER,
                    meta: {
                        ...meta,
                        [CITA_FIELDS.STATUS_PAGO]: ESTADO_PAGO.PENDING_LEDGER,
                        orderId: orderId || null,
                        fechaPagoRecibido: new Date(),
                    },
                };
            }, traceId, "events_markPendingLedger")
        )
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        log.warn("Some citas failed to update pending ledger status", {
            traceId,
            orderId,
            totalIds: ids.length,
            failedCount: failures.length,
        });
    }
}

// ============================================================================
// WEBHOOK: BOOKING CONFIRMED
// ============================================================================

export async function wixBookingsV2_onBookingConfirmed(rawBody) {
    const traceId = makeTraceId("whook-conf");
    try {
        const event = await _verifyAndDecodeWebhook(rawBody, "BOOKING_CONFIRMED");
        if (!event) {
            return { status: "REJECTED", reason: "JWT_VERIFICATION_FAILED" };
        }

        const eventId = event?.eventId || event?._id || `conf-${event?.booking?.id || Date.now()}`;
        const alreadyProcessed = await isEventProcessed(eventId);
        if (alreadyProcessed) {
            log.info("EVENT_DUPLICATE_IGNORED", { eventId, eventType: "BOOKING_CONFIRMED" });
            return { status: "OK", duplicate: true };
        }

        const valid = validateEventStructure(event, ["booking.id", "booking.status"]);
        if (!valid) {
            log.warn("EVENT_INVALID_STRUCTURE_REJECTED", { eventId });
            await markEventAsProcessed(eventId, "BOOKING_CONFIRMED_INVALID", traceId, { rejected: true });
            return { status: "OK", rejected: true };
        }

        const booking = event?.booking || event?.entity || {};
        const bookingId = booking?.id || booking?._id || "unknown";
        await _updateCitaStatus(bookingId, ESTADO_CITA.CONFIRMED, traceId);
        await markEventAsProcessed(eventId, "BOOKING_CONFIRMED", traceId, { bookingId });
        return { status: "OK", eventId };
    } catch (error) {
        _handleError(error, "wixBookingsV2_onBookingConfirmed", traceId);
        return { status: "OK" };
    }
}

// ============================================================================
// WEBHOOK: BOOKING CANCELED
// ============================================================================

export async function wixBookingsV2_onBookingCanceled(rawBody) {
    const traceId = makeTraceId("whook-cancel");
    try {
        const event = await _verifyAndDecodeWebhook(rawBody, "BOOKING_CANCELED");
        if (!event) {
            return { status: "REJECTED", reason: "JWT_VERIFICATION_FAILED" };
        }

        const eventId = event?.eventId || event?._id || `cancel-${event?.booking?.id || Date.now()}`;
        const alreadyProcessed = await isEventProcessed(eventId);
        if (alreadyProcessed) {
            log.info("EVENT_DUPLICATE_IGNORED", { eventId, eventType: "BOOKING_CANCELED" });
            return { status: "OK", duplicate: true };
        }

        const valid = validateEventStructure(event, ["booking.id"]);
        if (!valid) {
            log.warn("EVENT_INVALID_STRUCTURE_REJECTED", { eventId });
            await markEventAsProcessed(eventId, "BOOKING_CANCELED_INVALID", traceId, { rejected: true });
            return { status: "OK", rejected: true };
        }

        const booking = event?.booking || event?.entity || {};
        const bookingId = booking?.id || booking?._id || "unknown";
        // FIX-58: CANCELLED (dos L) canonico.
        await _updateCitaStatus(bookingId, ESTADO_CITA.CANCELLED, traceId);
        await markEventAsProcessed(eventId, "BOOKING_CANCELED", traceId, { bookingId });
        return { status: "OK", eventId };
    } catch (error) {
        _handleError(error, "wixBookingsV2_onBookingCanceled", traceId);
        return { status: "OK" };
    }
}

// ============================================================================
// WEBHOOK: ORDER PAYMENT STATUS UPDATED
//
// FIX-55: idempotencia por eventId.
// FIX-56: inventario DESPUES de ledger (evita inconsistencia temporal).
// ============================================================================

export async function wixEcom_onOrderPaymentStatusUpdated(rawBody) {
    const traceId = makeTraceId("whook-pay-status");
    try {
        const event = await _verifyAndDecodeWebhook(rawBody, "ORDER_PAYMENT_STATUS_UPDATED");
        if (!event) {
            return { status: "REJECTED", reason: "JWT_VERIFICATION_FAILED" };
        }

        // FIX-55: idempotencia por eventId (uniforme con otros webhooks).
        const eventId = event?.eventId || event?._id;
        if (eventId) {
            const alreadyProcessed = await isEventProcessed(eventId);
            if (alreadyProcessed) {
                log.info("EVENT_DUPLICATE_IGNORED", { eventId, eventType: "ORDER_PAYMENT_STATUS_UPDATED" });
                return { status: "OK", duplicate: true };
            }
        }

        const order = event?.order || event?.data?.order || event?.entity || event || {};
        const orderId = String(order?._id || order?.id || "").trim();
        if (!orderId || orderId === "unknown") {
            log.warn("PAYMENT_WEBHOOK_MISSING_ORDER_ID", { traceId, eventId });
            return { status: "OK" };
        }

        const paymentStatusRaw = order.paymentStatus || "";
        const paymentStatus = String(paymentStatusRaw).toUpperCase();
        const isPaidStatus = ["PAID", "FULLY_PAID", "PAID_FULL"].includes(paymentStatus);
        if (!isPaidStatus) { return { status: "OK" }; }

        const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];

        const bookingsAppId = APP_IDS.BOOKINGS;
        const bookingLineItems = lineItems.filter((item) => item?.catalogReference?.appId === bookingsAppId);
        const bookingIds = _normalizeBookingIds(bookingLineItems.map((item) => item?.catalogReference?.catalogItemId));
        const linkedBookingIds = bookingIds.join(",");

        const orderTotal = Number(order?.priceSummary?.total?.amount ?? order?.totals?.total?.amount ?? 0) || 0;
        const lineItemsTotal = lineItems.reduce((sum, item) => {
            const itemPrice = Number(item?.price?.amount ?? item?.price ?? item?.totalPrice?.amount ?? 0) || 0;
            return sum + (itemPrice * (Number(item?.quantity) || 1));
        }, 0);
        const finalLedgerAmount = orderTotal > 0 ? orderTotal : lineItemsTotal;
        const transactionId = `ORDER-${orderId}`;

        const existingLedgerRes = await withTimeout(
            wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA).eq("transactionId", transactionId).limit(1).find({ suppressAuth: true, consistentRead: true }),
            API_TIMEOUT_MS,
            "checkExistingLedgerPreflight"
        ).catch(() => ({ items: [] }));

        if (existingLedgerRes?.items?.length > 0) {
            if (bookingIds.length) {
                await _executeWithRetry(async () => {
                    await _markCitasPaidByBookingIds(bookingIds, orderId, traceId);
                }, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
            }
            if (eventId) {
                await markEventAsProcessed(eventId, "ORDER_PAYMENT_STATUS_UPDATED", traceId, { orderId, idempotent: true });
            }
            return { status: "OK" };
        }

        if (bookingIds.length) {
            await _executeWithRetry(async () => {
                await _markCitasPendingLedgerByBookingIds(bookingIds, orderId, traceId);
            }, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
        }

        if (finalLedgerAmount <= 0) {
            if (bookingIds.length) {
                await _executeWithRetry(async () => {
                    await _markCitasPaidByBookingIds(bookingIds, orderId, traceId);
                }, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
            }
            if (eventId) {
                await markEventAsProcessed(eventId, "ORDER_PAYMENT_STATUS_UPDATED", traceId, { orderId, zeroAmount: true });
            }
            return { status: "OK" };
        }

        const orderConcept = bookingIds.length > 0 ?
            (lineItems.length > bookingIds.length ? `Pedido Mixto Cita + Tienda ${orderId}` : `Reserva Online ${orderId}`) :
            `Venta Online Tienda ${orderId}`;

        const ledgerRes = await registerBookingPayment(
            linkedBookingIds || null,
            finalLedgerAmount,
            FORMA_PAGO.ONLINE, {
                concept: orderConcept,
                resourceId: "online",
                traceId,
                transactionId,
                orderId: orderId,
                origen: "WIX_ECOM_PAYMENT_WEBHOOK",
                tipoMovimiento: TIPO_MOVIMIENTO.VENTA_ONLINE,
            }
        );

        if (ledgerRes?.status === "SUCCESS") {
            // FIX-56: inventario DESPUES del ledger. Antes se descontaba
            // aunque el ledger fallara, generando inconsistencia temporal.
            try {
                await recordOnlineInventoryOrderInternal(order, traceId);
            } catch (inventoryError) {
                log.error("Online inventory mirror failed", {
                    orderId,
                    traceId,
                    error: inventoryError?.message || String(inventoryError),
                });
                // No bloquea el flujo: la venta se registro en caja.
                // Queda pendiente de conciliacion manual.
                await logAuditEventWithTimeout(
                    "INVENTORY_MIRROR_FAILED",
                    "ERROR",
                    `Inventario no descontado para orden ${orderId} tras ledger OK`,
                    { orderId, traceId, error: inventoryError?.message || String(inventoryError) },
                    traceId,
                    orderId,
                    "backend/events.js"
                );
            }

            if (bookingIds.length) {
                await _executeWithRetry(async () => {
                    await _markCitasPaidByBookingIds(bookingIds, orderId, traceId);
                }, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
            }
            if (eventId) {
                await markEventAsProcessed(eventId, "ORDER_PAYMENT_STATUS_UPDATED", traceId, { orderId });
            }
            return { status: "OK" };
        }

        await queueFiscalRecovery({
            bookingIds: linkedBookingIds,
            amount: finalLedgerAmount,
            paymentMethod: FORMA_PAGO.ONLINE,
            transactionId,
            orderId,
            origin: "WIX_ECOM_PAYMENT_WEBHOOK",
            concept: orderConcept,
            resourceId: "online",
            tipoMovimiento: TIPO_MOVIMIENTO.VENTA_ONLINE,
            traceId,
            lastError: ledgerRes?.error?.message || "LEDGER_REGISTRATION_FAILED",
        });

        await logAuditEventWithTimeout(
            "LEDGER_REGISTRATION_FAILED",
            "ERROR",
            `Ledger registration queued for order ${orderId}`, { orderId, bookingIds, ledgerError: ledgerRes?.error || "Unknown error", traceId },
            traceId,
            orderId,
            "backend/events.js"
        );

        return { status: "OK" };
    } catch (error) {
        const normalized = _handleError(error, "wixEcom_onOrderPaymentStatusUpdated", traceId);
        await logAuditEventWithTimeout(
            "WEBHOOK_CRITICAL_ERROR",
            "ERROR",
            `Critical error in webhook: ${normalized.message}`, { error: normalized.message, traceId },
            traceId,
            "system",
            "backend/events.js"
        );
        return { status: "OK" };
    }
}

// ============================================================================
// WEBHOOK: ORDER REFUNDED
//
// FIX-57: restockInfo documenta path canonico (event.sideEffects.restockInfo).
// ============================================================================

export async function wixEcom_onOrderRefunded(rawBody) {
    const traceId = makeTraceId("whook-refund");
    try {
        const event = await _verifyAndDecodeWebhook(rawBody, "ORDER_REFUNDED");
        if (!event) {
            return { status: "REJECTED", reason: "JWT_VERIFICATION_FAILED" };
        }

        const orderId = String(event?.orderId || event?.order?._id || "").trim() || "unknown";
        const refundObj = event?.refund || event?.data?.refund || null;
        if (!refundObj || orderId === "unknown") { return { status: "OK" }; }

        const rawAmount = typeof refundObj?.amount === "object" && refundObj?.amount !== null ?
            refundObj.amount.amount :
            refundObj?.amount ?? 0;
        const refundAmount = Number(rawAmount) || 0;
        if (refundAmount <= 0) { return { status: "OK" }; }

        const refundId = String(refundObj?._id || refundObj?.id || "").trim();
        if (!refundId) {
            await logAuditEventWithTimeout(
                "REFUND_ID_MISSING",
                "ERROR",
                `Refund without stable identifier for order ${orderId}`, { orderId, traceId },
                traceId,
                orderId,
                "backend/events.js"
            );
            return { status: "OK" };
        }

        const transactionId = `REFUND-${orderId}-${refundId}`;
        const originalTransactionId = `ORDER-${orderId}`;

        const originalMovementRes = await withTimeout(
            wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA).eq("transactionId", originalTransactionId).limit(1).find({ suppressAuth: true, consistentRead: true }),
            API_TIMEOUT_MS,
            "queryOriginalMovement"
        ).catch(() => ({ items: [] }));

        const originalMovement = originalMovementRes.items?.[0];
        if (!originalMovement) {
            await queueFiscalRecovery({
                bookingIds: "",
                amount: -refundAmount,
                paymentMethod: FORMA_PAGO.ONLINE,
                transactionId,
                orderId,
                refundId,
                origin: "WIX_ECOM_REFUND_WEBHOOK",
                concept: `Refund - Order ${orderId}`,
                resourceId: "online",
                tipoMovimiento: TIPO_MOVIMIENTO.REEMBOLSO,
                phase: "WAIT_FOR_ORIGINAL_ORDER_LEDGER",
                traceId,
                lastError: "ORIGINAL_ORDER_LEDGER_MISSING",
            });
            await logAuditEventWithTimeout(
                "REFUND_WAITING_FOR_ORIGINAL_LEDGER",
                "ERROR",
                `Refund queued before original ledger for order ${orderId}`, { orderId, refundId, traceId },
                traceId,
                orderId,
                "backend/events.js"
            );
            return { status: "OK" };
        }

        const originalAmount = Number(originalMovement.totalAmount || 0);
        const linkedBookingIds = _normalizeBookingIds(
            originalMovement.reservaIdVinculada || originalMovement.reservationIdLinked
        );

        // FIX-57: path canonico. Los fallbacks se mantienen por robustez
        // pero se loguea WARN si no viene por el canonico.
        let refundRestockInfo = event?.sideEffects?.restockInfo || null;
        if (!refundRestockInfo) {
            const fallbackPath =
                (event?.data?.sideEffects?.restockInfo && "event.data.sideEffects") ||
                (refundObj?.sideEffects?.restockInfo && "refund.sideEffects") ||
                null;

            if (fallbackPath) {
                log.warn("REFUND_RESTOCK_INFO_FALLBACK_PATH", {
                    orderId,
                    refundId,
                    fallbackPath,
                    hint: "Path canonico: event.sideEffects.restockInfo",
                    traceId,
                });
                refundRestockInfo =
                    (fallbackPath === "event.data.sideEffects" && event.data.sideEffects.restockInfo) ||
                    (fallbackPath === "refund.sideEffects" && refundObj.sideEffects.restockInfo) ||
                    null;
            }
        }

        const refundOrder = event?.order ||
            event?.data?.order || { _id: orderId, lineItems: event?.lineItems || event?.data?.lineItems || [] };

        try {
            const inventoryRefund = await recordOnlineInventoryRefundInternal(refundOrder, refundObj, refundRestockInfo, traceId);
            if (inventoryRefund?.status === "SKIPPED" && inventoryRefund?.reason !== "NO_CONFIRMED_RESTOCK") {
                await logAuditEventWithTimeout(
                    "REFUND_INVENTORY_TRACE_SKIPPED",
                    "WARN",
                    `Inventory trace skipped for refund ${refundId}`, { orderId, refundId, reason: inventoryRefund.reason, traceId },
                    traceId,
                    orderId,
                    "backend/events.js"
                );
            }
        } catch (inventoryRefundError) {
            await logAuditEventWithTimeout(
                "REFUND_INVENTORY_TRACE_FAILED",
                "ERROR",
                `Inventory trace failed for refund ${refundId}`, { orderId, refundId, error: inventoryRefundError?.message || String(inventoryRefundError), traceId },
                traceId,
                orderId,
                "backend/events.js"
            );
        }

        const ledgerRes = await registerBookingPayment(
            linkedBookingIds.join(",") || null,
            -refundAmount,
            FORMA_PAGO.ONLINE, {
                concept: `Refund - Order ${orderId}`,
                resourceId: "online",
                traceId,
                transactionId,
                orderId,
                refundId,
                origen: "WIX_ECOM_REFUND_WEBHOOK",
                tipoMovimiento: TIPO_MOVIMIENTO.REEMBOLSO,
            }
        );

        if (ledgerRes?.status === "SUCCESS") {
            await _markCitasRefundedByBookingIds(linkedBookingIds, orderId, refundId, false, traceId);
        } else {
            await queueFiscalRecovery({
                bookingIds: linkedBookingIds.join(","),
                amount: -refundAmount,
                paymentMethod: FORMA_PAGO.ONLINE,
                transactionId,
                orderId,
                refundId,
                origin: "WIX_ECOM_REFUND_WEBHOOK",
                concept: `Refund - Order ${orderId}`,
                resourceId: "online",
                tipoMovimiento: TIPO_MOVIMIENTO.REEMBOLSO,
                traceId,
                lastError: ledgerRes?.error?.message || "REFUND_LEDGER_REGISTRATION_FAILED",
            });
            await logAuditEventWithTimeout(
                "REFUND_LEDGER_REGISTRATION_FAILED",
                "ERROR",
                `Refund ledger queued for order ${orderId}`, { orderId, refundId, traceId },
                traceId,
                orderId,
                "backend/events.js"
            );
            return { status: "OK" };
        }

        const refundsRes = await withTimeout(
            wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA)
            .eq("orderId", orderId)
            .eq("movementType", TIPO_MOVIMIENTO.REEMBOLSO)
            .limit(100)
            .find({ suppressAuth: true, consistentRead: true }),
            API_TIMEOUT_MS,
            "queryRefundsForOrder"
        );

        const refundedTotal = (refundsRes?.items || []).reduce(
            (sum, movement) => sum + Math.abs(Number(movement?.accountingAmount || movement?.totalAmount || 0)),
            0
        );
        const fullyRefunded = originalAmount > 0 && refundedTotal >= originalAmount;
        await _markCitasRefundedByBookingIds(linkedBookingIds, orderId, refundId, fullyRefunded, traceId);

        return { status: "OK" };
    } catch (error) {
        _handleError(error, "wixEcom_onOrderRefunded", traceId);
        return { status: "OK" };
    }
}

// ============================================================================
// WEBHOOK: ORDER CANCELED
// FIX-58: ESTADO_CITA.CANCELLED (dos L).
// ============================================================================

export async function wixEcom_onOrderCanceled(rawBody) {
    const traceId = makeTraceId("whook-order-cancel");
    try {
        const event = await _verifyAndDecodeWebhook(rawBody, "ORDER_CANCELED");
        if (!event) {
            return { status: "REJECTED", reason: "JWT_VERIFICATION_FAILED" };
        }

        const order = event?.order || event?.data?.order || event || {};
        const orderId = String(order?._id || order?.id || "").trim() || "unknown";
        if (orderId === "unknown") { return { status: "OK" }; }

        const eventId = event?.eventId || event?._id || `cancel-order-${orderId}`;
        const alreadyProcessed = await isEventProcessed(eventId);
        if (alreadyProcessed) {
            log.info("EVENT_DUPLICATE_IGNORED", { eventId, eventType: "ORDER_CANCELED" });
            return { status: "OK", duplicate: true };
        }

        const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
        const bookingsAppId = APP_IDS.BOOKINGS;
        const bookingIds = _normalizeBookingIds(
            lineItems
            .filter((item) => item?.catalogReference?.appId === bookingsAppId)
            .map((item) => item?.catalogReference?.catalogItemId)
        );

        for (const bId of bookingIds) {
            // FIX-58: CANCELLED (dos L) canonico.
            await _updateCitaStatus(bId, ESTADO_CITA.CANCELLED, traceId);
        }

        await markEventAsProcessed(eventId, "ORDER_CANCELED", traceId, { orderId, bookingIds });

        return { status: "OK", eventId };
    } catch (error) {
        _handleError(error, "wixEcom_onOrderCanceled", traceId);
        return { status: "OK" };
    }
}
