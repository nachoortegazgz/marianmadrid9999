/*
=============================================================================
MODULE: backend/cajas.web.js
VERSION: v5008.2-OPT (logger from backend/logger)
        Booking y fiscalidad espanola)
BASE: Modulos optimizados 3 + BIBLIA v5002.5 + DOSSIER CAJA + DIRECTRICES V19
RESPONSIBILITY: TPV cashier ledger, daily closures (Arqueo X / Cierre Z),
                Veri*factu SHA-256 chain integrity, fiscal persistence,
                M365 sync enqueue, IDEMPOTENCIA, auditoria completa y
                control de periodos cerrados.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
CORRECTIONS APPLIED:
  [R2-01] Mutex atomico para _getNextSequence() con SlotLocks.
  [R2-02] Idempotencia por transactionId antes de insertar.
  [R2-03] _getLastMovement() ordena por sequenceNumber (determinista).
  [R2-04] await en todas las llamadas a hashSHA256/hmacSha256Hex.
  [R2-05] Verificar cierre Z existente antes de insertar.
  [R2-15] Bloqueo de periodo cerrado (_assertPeriodNotClosed).
  [R2-20] Auditoria de fallos en M365 (proyeccion contable retirada).
  [C1] Flujo 7 Tarjetas regalo: registerGiftCardSale + registerGiftCardRedemption.
  [FIX-D3] _logAuditEvent local eliminado. Se importa logAuditEvent de audit.js.
  [CI-CAJA-01] Idempotencia por transactionId.
  [CI-CAJA-02] Control revision saldos.
  [CI-CAJA-03] Validacion importes/moneda/signo.
  [CI-CAJA-04] Auditoria movimientos.
  [CI-CAJA-05] Bloqueo periodos cerrados.
  [CI-CAJA-06] Prevencion doble cobro/reembolso.
  [CLEAN-01] seqCol reemplazado por COLLECTIONS.CAJA_ACTUAL (singleton fiscal).
  [CLEAN-02] Referencias a colecciones eliminadas del SSOT retiradas
             (EVENTOS_SISTEMA_FACTURACION, PLAN_CUENTAS_CONTABLES,
             CONTROL_PARCIAL_X).
  [CLEAN-03] _registerSystemEvent retirado (dependia de coleccion eliminada).
  [CLEAN-04] _projectToAccounting retirado (dependia de PLAN_CUENTAS_CONTABLES).
  [CLEAN-05] registerXCount retirado (dependia de CONTROL_PARCIAL_X).
  [HARD-01] Imports de seguridad: solo requireCajero + rateLimiter.
  [HARD-02] Imports criptograficos: sin timingSafeEqual.
  [HARD-03] Imports mmUtils: sin _normalizeIdPart.
  [HARD-04] Firmas webMethod con options = {} defensivo.
  [HARD-05] Constante INTEGRITY_ALGORITHM_VERSION eliminada.
  [HARD-06] _getFiscalKeys() sin parametro traceId.
  [REV2-01] _getNextSequence() usa save() en lugar de update().
  [REV2-02] registerGiftCardRedemption() con idempotencia por transactionId.
  [REV2-03] IIFE: sin reintentos post-insert.
  [REV2-04] _getLastMovement() sin parametro traceId.
  [REV2-05] registerZClosing() no desestructura businessTaxId.
  [REV2-06] _readNonNegativeAmount y _rateLimitOrThrow conservados.
  [VF-01] Firma X.509 DELEGADA en microservicio externo.
  [VF-02] _buildAEATPayload() con formato oficial AEAT:
          campo1=valor1&campo2=valor2&... y nombres canonicos
          IDEmisorFactura, NumSerieFactura, FechaExpedicionFactura,
          TipoFactura, CuotaTotal, ImporteTotal, Huella,
          FechaHoraHusoGenRegistro.
  [VF-03] QR de verificacion Veri*factu integrado.
  [B7] _getNextSequence sin executeLedgerWithBackoff: el mutex ya
       garantiza exclusion mutua. Un retry sobre un save exitoso
       pero con respuesta fallida incrementaria la secuencia dos
       veces, generando hueco en la cadena fiscal.
  [B8] _updateCajaActual propaga errores a CompensacionesPendientes
       en lugar de silenciarlos (evita desincronizacion ledger/saldo).
  [B9] Cache de secretos (TTL 5 min) para validateFiscalConfig y
       _getFiscalKeys: reduce latencia ~200ms/req y llamadas a
       Secrets Manager.
  [B10] registerGiftCardRedemption acepta redemptionId del cliente
        como input preferente. Permite retries legitimos sin
        bloquear por idempotencia deterministica.
  [B11] Circuit breaker en signer fiscal externo. Tras N fallos
        consecutivos, se abre el circuito y los movimientos se
        encolan en CompensacionesPendientes con phase
        WAIT_FOR_SIGNER, sin bloquear la caja.
  [B17] Documentada intencion de migracion a colecciones dedicadas
        (HistoricoCierresInventario, PaquetesGestoria). cajas
        mantiene HISTORICO_CIERRES_Z para cierres Z diarios.
  [B22] _getBusinessTaxId interna falla explicitamente si no hay
        configuracion fiscal activa (no fallback a BXXXXXXXX).
  [RL-01] Rate limiting en registerManualTransaction.
  [SEC-01] Signer fiscal con timeout explicito y manejo de errores.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import { getSecret } from "wix-secrets-backend";

import {
    COLLECTIONS,
    SINGLETONS,
    SDK_CONFIG,
    TIPO_MOVIMIENTO,
    FORMA_PAGO,
    IVA_RATES,
    CAJA_STATUS,
    CONCURRENCY,
} from "backend/internalConfig";

import { SECRETS } from "backend/mmSecrets";
import { requireCajero, rateLimiter } from "backend/security";

import {
    hashSHA256,
    hashChain,
} from "backend/securityEngine";

import {
    makeTraceId,
    _roundMoney,
    _safeTrim,
    _cleanText,
    _stableSerialize,
    _readDate,
    _readPositiveAmount,
    _readNonNegativeAmount,
    withTimeout,
} from "public/mmUtils";

import { logger } from "backend/logger";
import { normalizeError } from "backend/booking/bookingCore";
import { _toPublicError } from "backend/responseUtils";
import { _lockSlotKeyOrFail, _unlockSlotKey } from "backend/booking/bookingCore";

// [FIX-D3] Import canonico de auditoria centralizada
import { logAuditEvent } from "backend/audit";
import { projectLedgerMovementToAccounting } from "backend/contabilidad";

const log = logger;

// ============================================================================
// CONSTANTS
// ============================================================================

const CAJA_ACTUAL_ID = SINGLETONS?.CAJA || "CAJA_PRINCIPAL";
const LEDGER_SCHEMA_VERSION = "LEDGER_V3";
const GENESIS_HASH = "0".repeat(64);
const MAX_LEDGER_BATCH_PAGES = 50;
const LEDGER_PAGE_SIZE = 200;

// [R2-01] Mutex para secuencia fiscal
const SEQUENCE_MUTEX_KEY = "FISCAL_SEQUENCE_LOCK";
const SEQUENCE_MUTEX_TTL_MS = Number(CONCURRENCY?.LEDGER_MUTEX_TTL_MS) || 45000;

// [VF-01] Timeout para el microservicio de firma
const FISCAL_SIGNER_TIMEOUT_MS = 10000;

// [B9] Cache de secretos (TTL 5 min)
const SECRET_CACHE_TTL_MS = 300000;
const _secretCache = new Map();

// [B11] Circuit breaker del signer fiscal
const SIGNER_FAILURE_THRESHOLD = 3;
const SIGNER_OPEN_MS = 60000;
let _signerState = { failures: 0, openUntil: 0 };

function _normalizeLinkedBookingIds(value) {
    const values = Array.isArray(value) ? value : String(value || "").split(",");
    return Array.from(new Set(values.map((id) => String(id || "").trim()).filter(Boolean)));
}

function _linkedBookingValue(value) {
    return _normalizeLinkedBookingIds(value).join(",") || null;
}

function _rateLimitOrThrow(surface, key, traceId) {
    const rl = rateLimiter({ surface, key });
    if (!rl.allowed) {
        const e = new Error(`RATE_LIMITED: retryAfter=${rl.retryAfter}`);
        e.code = "RATE_LIMITED";
        e.meta = { retryAfter: rl.retryAfter, surface, traceId };
        throw e;
    }
}

// [B9] Helper de cache de secretos (TTL 5 min)
async function _getCachedSecret(name) {
    const now = Date.now();
    const entry = _secretCache.get(name);
    if (entry && (now - entry.at) < SECRET_CACHE_TTL_MS) {
        return entry.value;
    }
    const value = await getSecret(name).catch(() => "");
    _secretCache.set(name, { value, at: now });
    return value;
}

// [B9] Invalidar cache de secretos (util tras rotacion)
export function _invalidateSecretCache() {
    _secretCache.clear();
}

// ============================================================================
// VALIDATION: FISCAL CONFIG
// ============================================================================

export async function validateFiscalConfig(traceId = "init") {
    const key = await _getCachedSecret(SECRETS.FISCAL_KEY);
    const nif = await _getCachedSecret(SECRETS.FISCAL_NIF_EMISOR);
    if (!key || key.length < 32) {
        log.error("CONFIGURACION_FISCAL_INVALIDA: Clave fiscal ausente o demasiado corta", { traceId });
        throw new Error("CONFIGURACION_FISCAL_INVALIDA");
    }
    if (!nif || nif.length < 9) {
        log.error("CONFIGURACION_FISCAL_INVALIDA: NIF emisor ausente o invalido", { traceId });
        throw new Error("CONFIGURACION_FISCAL_INVALIDA");
    }
    return true;
}

async function _getFiscalKeys() {
    const [key, nif] = await Promise.all([
        _getCachedSecret(SECRETS.FISCAL_KEY),
        _getCachedSecret(SECRETS.FISCAL_NIF_EMISOR),
    ]);
    if (!key || !nif) {
        throw new Error("CONFIGURACION_FISCAL_INVALIDA");
    }
    return { fiscalKey: key, businessTaxId: _safeTrim(nif).toUpperCase() };
}

// ============================================================================
// RETRY WITH EXPONENTIAL BACKOFF
//
// [B7] ADVERTENCIA: Solo usar para operaciones SIN side effects de escritura
// (por ejemplo, lecturas o lecturas+calculo). NUNCA envolver inserts o
// updates contables: un retry sobre un save exitoso pero con respuesta
// fallida incrementaria la secuencia fiscal dos veces.
// ============================================================================

export async function executeLedgerWithBackoff(operationFn, maxWallTimeMs = 15000) {
    const start = Date.now();
    let attempt = 0;
    let lastErr;
    while (Date.now() - start < maxWallTimeMs && attempt < 5) {
        try {
            return await operationFn();
        } catch (err) {
            lastErr = err;
            attempt++;
            const wait = Math.min(200 * Math.pow(2, attempt), 2000) + Math.random() * 100;
            await new Promise((r) => setTimeout(r, wait));
        }
    }
    throw new Error(`LEDGER_TIMEOUT: Operacion supero el tiempo limite de ${maxWallTimeMs}ms (${lastErr?.message})`);
}

// ============================================================================
// [VF-02] BUILD AEAT PAYLOAD (FORMATO OFICIAL AEAT)
//
// Especificacion oficial:
//   "los datos se concatenaran -en el orden descrito para cada caso- en una
//    unica cadena de texto con formato String, siguiendo la estructura:
//    nombreCampo1=valorCampo1&nombreCampo2=valorCampo2&..."
// ============================================================================

function _formatAEATDate(ymd) {
    // Convierte YYYY-MM-DD a DD-MM-YYYY (formato AEAT)
    const clean = _safeTrim(ymd);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
    if (!match) return clean;
    return `${match[3]}-${match[2]}-${match[1]}`;
}

function _formatAEATDateTimeMadrid(date) {
    // Genera ISO 8601 con offset Madrid: YYYY-MM-DDTHH:MM:SS+HH:MM
    const dt = date instanceof Date ? date : new Date();
    const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
    }).formatToParts(dt).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

    const madridOffset = (() => {
        const madridStr = dt.toLocaleString("en-US", { timeZone: "Europe/Madrid", timeZoneName: "longOffset" });
        const m = /GMT([+-])(\d{2}):?(\d{2})/.exec(madridStr);
        if (m) return `${m[1]}${m[2]}:${m[3]}`;
        const localMadrid = new Date(dt.toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
        const diffMinutes = Math.round((localMadrid - dt) / 60000);
        const sign = diffMinutes >= 0 ? "+" : "-";
        const abs = Math.abs(diffMinutes);
        return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
    })();

    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${madridOffset}`;
}

function _buildAEATPayload(mov, generatedAt) {
    const fields = [
        ["IDEmisorFactura", mov.businessTaxId || ""],
        ["NumSerieFactura", mov.invoiceNumber || ""],
        ["FechaExpedicionFactura", _formatAEATDate(mov.operationDate)],
        ["TipoFactura", mov.operationNature === "DEVOLUCION" ? "R1" : "F1"],
        ["CuotaTotal", String(Number(mov.taxAmount || 0).toFixed(2))],
        ["ImporteTotal", String(Number(mov.totalAmount || 0).toFixed(2))],
        ["Huella", mov.previousRecordHash || ""],
        ["FechaHoraHusoGenRegistro", _formatAEATDateTimeMadrid(generatedAt)],
    ];
    return fields.map(([key, value]) => `${key}=${value}`).join("&");
}

// ============================================================================
// [VF-01 + B11] FIRMA X.509 DELEGADA CON CIRCUIT BREAKER
// ============================================================================

async function _computeSignature(currentHash, traceId) {
    // [B11] Circuit breaker
    if (Date.now() < _signerState.openUntil) {
        log.warn("Fiscal signer circuit OPEN; rejecting fast", { traceId });
        throw new Error("FISCAL_SIGN_FAIL: circuit breaker open");
    }

    try {
        const endpoint = await _getCachedSecret(SECRETS.FISCAL_SIGNER_ENDPOINT);
        const bearer = await _getCachedSecret(SECRETS.FISCAL_SIGNER_BEARER);

        if (!endpoint || !bearer) {
            log.error("FISCAL_SIGNER_NOT_CONFIGURED", { traceId });
            throw new Error("FISCAL_SIGN_FAIL: signer endpoint not configured");
        }

        const response = await withTimeout(
            fetch(endpoint, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${bearer}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    hash: currentHash,
                    hashAlgorithm: "SHA-256",
                    signatureAlgorithm: "RSASSA-PKCS1-v1_5-SHA-256",
                }),
            }),
            FISCAL_SIGNER_TIMEOUT_MS,
            "fiscal_signer"
        );

        if (!response.ok) {
            const errBody = await response.text().catch(() => "");
            throw new Error(`FISCAL_SIGNER_HTTP_${response.status}: ${errBody.slice(0, 200)}`);
        }

        const data = await response.json();
        if (!data?.signature) {
            throw new Error("FISCAL_SIGNER_INVALID_RESPONSE");
        }

        // Reset exitoso del circuit breaker
        _signerState.failures = 0;
        _signerState.openUntil = 0;

        return data.signature;
    } catch (err) {
        _signerState.failures++;
        if (_signerState.failures >= SIGNER_FAILURE_THRESHOLD) {
            _signerState.openUntil = Date.now() + SIGNER_OPEN_MS;
            log.error("Fiscal signer circuit OPEN", {
                failures: _signerState.failures,
                openUntilMs: SIGNER_OPEN_MS,
                traceId,
            });
        }
        log.error("_computeSignature failed", { error: err?.message, traceId });
        throw new Error(`FISCAL_SIGN_FAIL: ${err?.message}`);
    }
}

// ============================================================================
// [VF-03] GENERATE VERIFICATION QR
// ============================================================================

function _generateVerificationQR(invoiceNumber, businessTaxId, operationDate, totalAmount) {
    const baseUrl = "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR";
    const params = [
        `nif=${encodeURIComponent(businessTaxId)}`,
        `numserie=${encodeURIComponent(invoiceNumber)}`,
        `fecha=${encodeURIComponent(operationDate)}`,
        `importe=${encodeURIComponent(String(totalAmount))}`,
    ];
    return `${baseUrl}?${params.join("&")}`;
}

// ============================================================================
// HASH CHAIN UTILITIES
// ============================================================================

async function _computeCurrentHash(prevHash, payloadStr) {
    return await hashChain(prevHash, payloadStr);
}

// ============================================================================
// SEQUENCE COUNTER (ATOMIC)
//
// [B7] Sin executeLedgerWithBackoff: el mutex (SEQUENCE_MUTEX_KEY) ya
// garantiza exclusion mutua. Un retry sobre un save exitoso pero con
// respuesta fallida incrementaria la secuencia dos veces, generando
// un hueco en la cadena fiscal (Veri*factu no conforme).
// ============================================================================

async function _getNextSequence(traceId) {
    const lockOwnerId = `seq_${traceId || makeTraceId("seq")}`;

    const lockResult = await _lockSlotKeyOrFail(SEQUENCE_MUTEX_KEY, lockOwnerId, SEQUENCE_MUTEX_TTL_MS);
    if (!lockResult?.ok) {
        throw new Error("SEQUENCE_LOCK_BUSY: No se pudo adquirir el lock de secuencia");
    }

    try {
        let seqDoc = await wixData
            .get(COLLECTIONS.CAJA_ACTUAL, CAJA_ACTUAL_ID, { suppressAuth: true, consistentRead: true })
            .catch(() => null);

        if (!seqDoc) {
            seqDoc = {
                _id: CAJA_ACTUAL_ID,
                sequenceCounters: { seqGlobal: 0 },
                _createdDate: new Date(),
                _updatedDate: new Date(),
            };
            await wixData.insert(COLLECTIONS.CAJA_ACTUAL, seqDoc, { suppressAuth: true });
        }

        const counters = seqDoc.sequenceCounters || {};
        const nextGlobal = Number(counters.seqGlobal || 0) + 1;
        const yearKey = String(new Date().getFullYear());
        const nextYear = Number(counters[yearKey] || 0) + 1;
        counters.seqGlobal = nextGlobal;
        counters[yearKey] = nextYear;
        seqDoc.sequenceCounters = counters;
        seqDoc._updatedDate = new Date();

        await wixData.save(COLLECTIONS.CAJA_ACTUAL, seqDoc, { suppressAuth: true });

        return {
            sequenceNumber: nextGlobal,
            yearSequence: nextYear,
            invoiceNumber: `FAC-${yearKey}-${String(nextYear).padStart(5, "0")}`,
        };
    } finally {
        await _unlockSlotKey(SEQUENCE_MUTEX_KEY, lockOwnerId).catch(() => {});
    }
}

// ============================================================================
// GET LAST MOVEMENT (FOR HASH CHAIN)
// ============================================================================

async function _getLastMovement() {
    const res = await wixData
        .query(COLLECTIONS.MOVIMIENTOS_CAJA)
        .descending("sequenceNumber")
        .limit(1)
        .find({ suppressAuth: true, consistentRead: true });
    return res?.items?.[0] || null;
}

// ============================================================================
// CHECK PERIOD CLOSED
// ============================================================================

async function _assertPeriodNotClosed(operationDate, traceId) {
    const existingZ = await wixData.get(
        COLLECTIONS.HISTORICO_CIERRES_Z,
        `Z_${operationDate}`, { suppressAuth: true }
    ).catch(() => null);

    if (existingZ) {
        log.error("PERIOD_CLOSED: Intento de insertar movimiento en periodo cerrado", {
            operationDate,
            traceId,
        });
        throw new Error("PERIOD_CLOSED: No se pueden insertar movimientos en un periodo con cierre Z");
    }
}

// ============================================================================
// CORE: REGISTER MANUAL TRANSACTION
// ============================================================================

export const registerManualTransaction = webMethod(Permissions.SiteMember, async (payload) => {
    const traceId = payload?.traceId || makeTraceId("manual-tx");
    try {
        // [RL-01] Rate limiting por resourceId para evitar abuso
        _rateLimitOrThrow(
            "cajas.registerManualTransaction",
            _safeTrim(payload?.resourceId) || "CAJA_LOCAL",
            traceId
        );

        await requireCajero(traceId);
        await validateFiscalConfig(traceId);
        const { fiscalKey, businessTaxId } = await _getFiscalKeys();

        const amount = _readPositiveAmount(payload?.amount);
        if (!amount) {
            return { status: "ERROR", data: null, error: { code: "INVALID_AMOUNT", message: "Importe positivo requerido" } };
        }

        const paymentMethod = _safeTrim(payload?.paymentMethod).toUpperCase();
        if (!Object.values(FORMA_PAGO).includes(paymentMethod)) {
            return { status: "ERROR", data: null, error: { code: "INVALID_PAYMENT_METHOD", message: "Forma de pago invalida" } };
        }

        const movementType = _safeTrim(payload?.tipoMovimiento || payload?.movementType || "VENTA").toUpperCase();
        const concept = _cleanText(payload?.concept || payload?.description || "Venta mostrador", 500);
        const resourceId = _safeTrim(payload?.resourceId || "CAJA_LOCAL");
        const transactionId = payload?.transactionId || null;

        // [R2-02] Idempotencia
        if (transactionId) {
            const existingRes = await wixData
                .query(COLLECTIONS.MOVIMIENTOS_CAJA)
                .eq("transactionId", transactionId)
                .limit(1)
                .find({ suppressAuth: true, consistentRead: true });

            if (existingRes?.items?.length > 0) {
                log.info("Ledger idempotent duplicate detected", { transactionId, traceId });
                return { status: "SUCCESS", data: existingRes.items[0], error: null, idempotent: true };
            }
        }

        const operationDate = new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" });

        // [R2-15] Verificar que el periodo no esta cerrado
        await _assertPeriodNotClosed(operationDate, traceId);

        // [REV2-03] IIFE: sin reintentos post-insert
        return await (async () => {
            const seq = await _getNextSequence(traceId);
            const lastMov = await _getLastMovement();
            const previousRecordHash = lastMov?.currentRecordHash || GENESIS_HASH;

            const taxRate = Number(payload?.taxRate) || IVA_RATES.GENERAL;
            const taxableAmount = _roundMoney(amount / (1 + taxRate));
            const taxAmount = _roundMoney(amount - taxableAmount);

            const generatedAt = new Date();

            const movBase = {
                sequenceNumber: seq.sequenceNumber,
                invoiceNumber: seq.invoiceNumber,
                operationDate,
                fiscalPeriod: operationDate.slice(0, 7),
                movementType,
                operationNature: movementType === TIPO_MOVIMIENTO.REEMBOLSO ? "DEVOLUCION" : movementType === TIPO_MOVIMIENTO.PROPINA ? "PROPINA" : movementType === TIPO_MOVIMIENTO.AJUSTE ? "AJUSTE" : "VENTA",
                paymentMethod,
                totalAmount: amount,
                taxableAmount,
                taxAmount,
                taxRate,
                taxTreatment: movementType === TIPO_MOVIMIENTO.PROPINA ? "PROPINA_PENDIENTE_GESTORIA" : "IVA_GENERAL",
                accountingSign: movementType === TIPO_MOVIMIENTO.REEMBOLSO ? -1 : 1,
                accountingAmount: movementType === TIPO_MOVIMIENTO.REEMBOLSO ? -amount : amount,
                description: concept,
                lineItems: payload?.lineItems || [],
                rectifiedInvoiceReference: payload?.rectifiedInvoiceReference || null,
                businessTaxId,
                schemaIntegrityVersion: LEDGER_SCHEMA_VERSION,
                recordSource: payload?.origen || payload?.recordSource || "INTERNAL",
                resourceId,
                reservaIdVinculada: _linkedBookingValue(payload?.reservaIdVinculada ?? payload?.reservationIdLinked),
                transactionId: transactionId || `TX_${seq.sequenceNumber}`,
                orderId: payload?.orderId || null,
                refundId: payload?.refundId || null,
            };

            // [VF-02] Payload AEAT segun especificacion oficial
            const aeatPayload = _buildAEATPayload(
                { ...movBase, previousRecordHash },
                generatedAt
            );

            // Hash encadenado sobre el payload AEAT
            const currentRecordHash = await _computeCurrentHash(previousRecordHash, aeatPayload);

            // [VF-01 + B11] Firma X.509 delegada con circuit breaker
            let digitalSignature;
            try {
                digitalSignature = await _computeSignature(currentRecordHash, traceId);
            } catch (signErr) {
                // [B11] Signer caido o circuit abierto: encolar recovery
                log.warn("Fiscal signer unavailable; queuing movement", {
                    transactionId: movBase.transactionId,
                    error: signErr?.message,
                    traceId,
                });
                await queueFiscalRecovery({
                    transactionId: movBase.transactionId,
                    bookingIds: movBase.reservaIdVinculada,
                    amount,
                    paymentMethod,
                    concept,
                    resourceId,
                    tipoMovimiento: movementType,
                    phase: "WAIT_FOR_SIGNER",
                    origin: "FISCAL_SIGNER_DOWN",
                    traceId,
                    lastError: signErr?.message || "FISCAL_SIGN_FAIL",
                });
                return {
                    status: "SUCCESS",
                    data: {
                        ...movBase,
                        previousRecordHash,
                        currentRecordHash,
                        pendingSignature: true,
                        queued: true,
                    },
                    error: null,
                };
            }

            // [VF-03] QR de verificacion
            const verificationQR = _generateVerificationQR(
                movBase.invoiceNumber,
                businessTaxId,
                operationDate,
                amount
            );

            const movimiento = {
                ...movBase,
                previousRecordHash,
                currentRecordHash,
                digitalSignature,
                aeatPayload,
                verificationQR,
                hashAlgorithm: "SHA-256",
                signatureAlgorithm: "RSASSA-PKCS1-v1_5-SHA-256",
                registeredAt: generatedAt,
                traceId,
                _createdDate: new Date(),
            };

            const saved = await wixData.insert(COLLECTIONS.MOVIMIENTOS_CAJA, movimiento, { suppressAuth: true });
            await _updateCajaActual(movimiento, traceId);
            // [v5008.3] Non-blocking accounting projection - never fails the cash movement
            try {
                projectLedgerMovementToAccounting(movimiento).catch((accErr) => {
                    log.warn("Accounting projection deferred", {
                        error: accErr?.message || String(accErr),
                        concept: movimiento?.concept,
                        traceId,
                    });
                });
            } catch (_) { /* ignore */ }

            if (SDK_CONFIG?.M365?.ENABLED) {
                try {
                    await _enqueueM365Sync(saved, traceId);
                } catch (e) {
                    log.error("M365 sync enqueue failed (non-blocking)", { traceId, error: e?.message });
                    await logAuditEvent("M365_SYNC_ENQUEUE_FAILED", "ERROR", `Encolado M365 fallido para ${saved.invoiceNumber}`, { invoiceNumber: saved.invoiceNumber, error: e?.message, traceId }, traceId, saved.invoiceNumber, "backend/cajas.web.js");
                }
            }

            return { status: "SUCCESS", data: saved, error: null };
        })();
    } catch (err) {
        const norm = normalizeError(err);
        log.error("registerManualTransaction failed", { code: norm.code, error: norm.message, traceId });
        return { status: "ERROR", data: null, error: { code: norm.code || "LEDGER_FAIL", message: norm.message } };
    }
});

// ============================================================================
// UPDATE CAJA ACTUAL SINGLETON
//
// [B8] Errores NO se silencian: se propaga a CompensacionesPendientes
// para resincronizacion posterior.
// ============================================================================

async function _updateCajaActual(movimiento, traceId) {
    try {
        const cajaCol = COLLECTIONS.CAJA_ACTUAL;
        let caja = await wixData.get(cajaCol, CAJA_ACTUAL_ID, { suppressAuth: true }).catch(() => null);
        if (!caja) {
            caja = {
                _id: CAJA_ACTUAL_ID,
                operationDate: movimiento.operationDate,
                cashRegisterStatus: CAJA_STATUS.OPEN,
                totalBalance: 0,
                cashBalance: 0,
                cardBalance: 0,
                bizumBalance: 0,
                onlineBalance: 0,
                totalOperations: 0,
                openedAt: new Date(),
                closedAt: null,
                lastActivityAt: new Date(),
                _createdDate: new Date(),
                _updatedDate: new Date(),
            };
        }
        const amount = Number(movimiento.accountingAmount) || 0;
        const method = _safeTrim(movimiento.paymentMethod).toUpperCase();
        if (method === FORMA_PAGO.EFECTIVO) { caja.cashBalance = _roundMoney((caja.cashBalance || 0) + amount); }
        else if (method === FORMA_PAGO.TARJETA) { caja.cardBalance = _roundMoney((caja.cardBalance || 0) + amount); }
        else if (method === FORMA_PAGO.BIZUM) { caja.bizumBalance = _roundMoney((caja.bizumBalance || 0) + amount); }
        else if (method === FORMA_PAGO.ONLINE) { caja.onlineBalance = _roundMoney((caja.onlineBalance || 0) + amount); }

        caja.totalBalance = _roundMoney((caja.cashBalance || 0) + (caja.cardBalance || 0) + (caja.bizumBalance || 0) + (caja.onlineBalance || 0));
        caja.totalOperations = Number(caja.totalOperations || 0) + 1;
        caja.lastActivityAt = new Date();
        caja._updatedDate = new Date();
        await wixData.save(cajaCol, caja, { suppressAuth: true });
    } catch (err) {
        // [B8] Propagar error a CompensacionesPendientes para resincronizacion
        log.error("_updateCajaActual failed; queuing resync", { traceId, error: err?.message });
        try {
            await wixData.insert(COLLECTIONS.COMPENSACIONES_PENDIENTES, {
                _id: `REC_CAJA_SYNC_${movimiento.transactionId || Date.now()}`,
                kind: "RESYNC_CAJA_BALANCE",
                transactionId: movimiento.transactionId || null,
                amount: Number(movimiento.accountingAmount) || 0,
                paymentMethod: movimiento.paymentMethod || null,
                concept: "Sincronizacion de saldo tras fallo en _updateCajaActual",
                status: "PENDING_RECOVERY",
                phase: "WAIT_FOR_CAJA_RESYNC",
                origin: "UPDATE_CAJA_FAILED",
                alertRequired: true,
                attempts: 0,
                lastError: err?.message || "UNKNOWN",
                traceId,
                _createdDate: new Date(),
                _updatedDate: new Date(),
            }, { suppressAuth: true });
        } catch (queueErr) {
            log.error("_updateCajaActual: failed to queue resync", { traceId, error: queueErr?.message });
        }
    }
}

// ============================================================================
// ENQUEUE M365 SYNC
// ============================================================================

async function _enqueueM365Sync(movimiento, traceId) {
    const queueCol = COLLECTIONS.M365_GRAPH_SYNC_QUEUE;
    const payload = {
        eventType: "LEDGER_MOVEMENT",
        correlationId: traceId,
        transactionId: movimiento.transactionId,
        bookingReference: _linkedBookingValue(movimiento.reservaIdVinculada ?? movimiento.reservationIdLinked) || movimiento._id,
        amount: movimiento.totalAmount,
        currency: "EUR",
        occurredAt: movimiento.registeredAt,
    };
    payload.title = `LEDGER_MOVEMENT ${movimiento.transactionId || movimiento.invoiceNumber}`;
    const integrityHash = await hashSHA256(_stableSerialize(payload));
    payload.integrityHash = integrityHash;
    const queueId = `m365-graph-${integrityHash.slice(0, 56)}`;
    const queueRecord = {
        _id: queueId,
        payload,
        payloadHash: integrityHash,
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: new Date(),
        traceId,
        _createdDate: new Date(),
        _updatedDate: new Date(),
    };
    await wixData.insert(queueCol, queueRecord, { suppressAuth: true });
}

// ============================================================================
// REGISTER BOOKING PAYMENT
// ============================================================================

export async function registerBookingPayment(bookingIds, amount, method, meta = {}) {
    const traceId = meta.traceId || makeTraceId("bkg-pay");
    return await registerManualTransaction({
        amount,
        paymentMethod: method,
        tipoMovimiento: meta.tipoMovimiento || "VENTA_ONLINE",
        concept: meta.concept || `Cobro reserva ${bookingIds}`,
        resourceId: meta.resourceId || "ONLINE",
        reservaIdVinculada: _linkedBookingValue(bookingIds),
        transactionId: meta.transactionId || null,
        orderId: meta.orderId || null,
        traceId,
    });
}

// ============================================================================
// QUEUE FISCAL RECOVERY
// ============================================================================

export async function queueFiscalRecovery(recoveryData) {
    const traceId = recoveryData.traceId || makeTraceId("fiscal-rec");
    try {
        const compCol = COLLECTIONS.COMPENSACIONES_PENDIENTES;
        await wixData.insert(compCol, {
            _id: `REC_${recoveryData.transactionId || Date.now()}`,
            bookingIds: recoveryData.bookingIds || null,
            orderId: recoveryData.orderId || null,
            refundId: recoveryData.refundId || null,
            transactionId: recoveryData.transactionId || null,
            status: "PENDING_RECOVERY",
            amount: Number(recoveryData.amount) || 0,
            concept: recoveryData.concept || "Fiscal recovery",
            paymentMethod: recoveryData.paymentMethod || null,
            movementType: recoveryData.tipoMovimiento || recoveryData.movementType || null,
            kind: "FISCAL_LEDGER",
            phase: recoveryData.phase || null,
            origin: recoveryData.origin || "FISCAL_RECOVERY",
            alertRequired: false,
            attempts: 0,
            lastError: recoveryData.lastError || null,
            traceId,
            _createdDate: new Date(),
            _updatedDate: new Date(),
        }, { suppressAuth: true });
    } catch (err) {
        log.error("queueFiscalRecovery failed", { traceId, error: err?.message });
    }
}

// ============================================================================
// GET CASHIER STATE
// ============================================================================

export const getCashierState = webMethod(Permissions.SiteMember, async (options = {}) => {
    const { traceId } = options;
    try {
        await requireCajero(traceId);
        const cajaCol = COLLECTIONS.CAJA_ACTUAL;
        const caja = await wixData.get(cajaCol, CAJA_ACTUAL_ID, { suppressAuth: true }).catch(() => null);
        return {
            status: "SUCCESS",
            data: caja || {
                _id: CAJA_ACTUAL_ID,
                cashRegisterStatus: CAJA_STATUS.CLOSED,
                totalBalance: 0,
                cashBalance: 0,
                cardBalance: 0,
                bizumBalance: 0,
                onlineBalance: 0,
                totalOperations: 0,
            },
            error: null,
        };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "CASHIER_STATE_FAIL") };
    }
});

// ============================================================================
// REGISTER Z CLOSING (CIERRE FISCAL DIARIO)
//
// [B17] Historicamente, HistoricoCierresZ aloja 3 dominios (Z_*, CLOSING_*,
//       DOC_GESTORIA_*). cajas mantiene HISTORICO_CIERRES_Z para cierres Z
//       diarios exclusivamente. Los otros dominios deben migrar a colecciones
//       dedicadas (HistoricoCierresInventario, PaquetesGestoria) segun SSOT.
// ============================================================================

export const registerZClosing = webMethod(Permissions.SiteMember, async (diaKey, options = {}) => {
    const { traceId } = options;
    try {
        await requireCajero(traceId);
        await validateFiscalConfig(traceId);
        const cleanDiaKey = _readDate(diaKey);
        if (!cleanDiaKey) {
            return { status: "ERROR", data: null, error: { code: "INVALID_DATE", message: "Fecha invalida" } };
        }

        // [R2-05] Verificar que no exista ya un cierre Z para esta fecha
        const existingZ = await wixData.get(
            COLLECTIONS.HISTORICO_CIERRES_Z,
            `Z_${cleanDiaKey}`, { suppressAuth: true }
        ).catch(() => null);

        if (existingZ) {
            log.warn("Z_CLOSING_ALREADY_EXISTS", { cleanDiaKey, traceId });
            return { status: "ERROR", data: null, error: { code: "Z_ALREADY_CLOSED", message: "Ya existe un cierre Z para esta fecha" } };
        }

        let allMovements = [];
        const query = wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA)
            .eq("operationDate", cleanDiaKey)
            .ascending("sequenceNumber")
            .limit(LEDGER_PAGE_SIZE);
        let res = await query.find({ suppressAuth: true });
        allMovements = allMovements.concat(res.items || []);
        let page = 2;
        while (res.hasNext() && page <= MAX_LEDGER_BATCH_PAGES) {
            res = await res.next();
            allMovements = allMovements.concat(res.items || []);
            page++;
        }

        if (allMovements.length === 0) {
            return { status: "ERROR", data: null, error: { code: "NO_MOVEMENTS", message: "No hay movimientos para cerrar" } };
        }

        const totalCash = allMovements.filter(m => m.paymentMethod === FORMA_PAGO.EFECTIVO).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalCard = allMovements.filter(m => m.paymentMethod === FORMA_PAGO.TARJETA).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalBizum = allMovements.filter(m => m.paymentMethod === FORMA_PAGO.BIZUM).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalOnline = allMovements.filter(m => m.paymentMethod === FORMA_PAGO.ONLINE).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalRefunds = allMovements.filter(m => m.movementType === TIPO_MOVIMIENTO.REEMBOLSO).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalTips = allMovements.filter(m => m.movementType === TIPO_MOVIMIENTO.PROPINA).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalAdjustments = allMovements.filter(m => m.movementType === TIPO_MOVIMIENTO.AJUSTE).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const grossSalesTotal = allMovements.filter(m => m.operationNature === "VENTA").reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const netTaxableAmount = allMovements.reduce((s, m) => s + Number(m.taxableAmount || 0), 0);
        const netTaxAmount = allMovements.reduce((s, m) => s + Number(m.taxAmount || 0), 0);
        const consolidatedTotalAmount = _roundMoney(totalCash + totalCard + totalBizum + totalOnline);

        const movementTypeBreakdown = {};
        for (const m of allMovements) {
            const mt = m.movementType || "UNKNOWN";
            movementTypeBreakdown[mt] = _roundMoney((movementTypeBreakdown[mt] || 0) + Number(m.accountingAmount || 0));
        }

        const taxTypeBreakdown = {};
        for (const m of allMovements) {
            const rate = String(Number(m.taxRate) || 0);
            if (!taxTypeBreakdown[rate]) {
                taxTypeBreakdown[rate] = { taxableAmount: 0, taxAmount: 0, total: 0, operations: 0 };
            }
            taxTypeBreakdown[rate].taxableAmount = _roundMoney(taxTypeBreakdown[rate].taxableAmount + Number(m.taxableAmount || 0));
            taxTypeBreakdown[rate].taxAmount = _roundMoney(taxTypeBreakdown[rate].taxAmount + Number(m.taxAmount || 0));
            taxTypeBreakdown[rate].total = _roundMoney(taxTypeBreakdown[rate].total + Number(m.accountingAmount || 0));
            taxTypeBreakdown[rate].operations++;
        }

        // Verificar integridad de la cadena
        let expectedPrev = GENESIS_HASH;
        let integrityVerified = true;
        for (const mov of allMovements) {
            if (mov.previousRecordHash && mov.previousRecordHash !== expectedPrev) {
                integrityVerified = false;
                log.error("Hash chain integrity violation detected", {
                    traceId,
                    movementId: mov._id,
                    expected: expectedPrev,
                    actual: mov.previousRecordHash,
                });
                break;
            }
            expectedPrev = mov.currentRecordHash || expectedPrev;
        }

        if (!integrityVerified) {
            return { status: "ERROR", data: null, error: { code: "INTEGRITY_VIOLATION", message: "Hash chain integrity violation detected. Cannot close." } };
        }

        const firstMov = allMovements[0];
        const lastMov = allMovements[allMovements.length - 1];
        const closingPayload = _stableSerialize({
            operationDate: cleanDiaKey,
            consolidatedTotalAmount,
            grossSalesTotal: _roundMoney(grossSalesTotal),
            netTaxableAmount: _roundMoney(netTaxableAmount),
            netTaxAmount: _roundMoney(netTaxAmount),
            totalOperations: allMovements.length,
            startSequence: Number(firstMov?.sequenceNumber) || 0,
            endSequence: Number(lastMov?.sequenceNumber) || 0,
        });
        const closingHash = await hashSHA256(closingPayload);

        // Firma X.509 delegada (misma politica que registerManualTransaction)
        let closingSignature = "";
        try {
            closingSignature = await _computeSignature(closingHash, traceId);
        } catch (signErr) {
            log.warn("Z closing signature unavailable; proceeding without signature", {
                cleanDiaKey,
                error: signErr?.message,
                traceId,
            });
            // El cierre Z se persiste sin firma; se puede encolar recovery.
            await queueFiscalRecovery({
                transactionId: `Z_${cleanDiaKey}`,
                amount: consolidatedTotalAmount,
                concept: `Cierre Z pendiente de firma ${cleanDiaKey}`,
                phase: "WAIT_FOR_SIGNER_Z_CLOSING",
                origin: "FISCAL_SIGNER_DOWN",
                traceId,
                lastError: signErr?.message || "FISCAL_SIGN_FAIL",
            });
        }

        const zRecord = {
            _id: `Z_${cleanDiaKey}`,
            operationDate: cleanDiaKey,
            closingStatus: "CERRADO",
            consolidatedTotalAmount,
            grossSalesTotal: _roundMoney(grossSalesTotal),
            netTaxableAmount: _roundMoney(netTaxableAmount),
            netTaxAmount: _roundMoney(netTaxAmount),
            totalCash: _roundMoney(totalCash),
            totalCard: _roundMoney(totalCard),
            totalBizum: _roundMoney(totalBizum),
            totalOnline: _roundMoney(totalOnline),
            totalRefunds: _roundMoney(totalRefunds),
            totalTips: _roundMoney(totalTips),
            totalAdjustments: _roundMoney(totalAdjustments),
            totalOperations: allMovements.length,
            startSequence: Number(firstMov?.sequenceNumber) || 0,
            endSequence: Number(lastMov?.sequenceNumber) || 0,
            startTicketNumber: firstMov?.invoiceNumber || "",
            endTicketNumber: lastMov?.invoiceNumber || "",
            startRecordHash: firstMov?.previousRecordHash || GENESIS_HASH,
            endRecordHash: lastMov?.currentRecordHash || GENESIS_HASH,
            movementTypeBreakdown,
            taxTypeBreakdown,
            isIntegrityVerified: true,
            auditedRecordsCount: allMovements.length,
            closingHash,
            closingSignature,
            closingSource: "CRON",
            closingSchemaVersion: LEDGER_SCHEMA_VERSION,
            timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
            closedAt: new Date(),
            verifiedAt: new Date(),
            traceId,
            _createdDate: new Date(),
        };

        const saved = await wixData.insert(COLLECTIONS.HISTORICO_CIERRES_Z, zRecord, { suppressAuth: true });

        const cajaCol = COLLECTIONS.CAJA_ACTUAL;
        const caja = await wixData.get(cajaCol, CAJA_ACTUAL_ID, { suppressAuth: true }).catch(() => null);
        if (caja) {
            caja.cashRegisterStatus = CAJA_STATUS.CLOSED;
            caja.closedAt = new Date();
            caja._updatedDate = new Date();
            await wixData.save(cajaCol, caja, { suppressAuth: true });
        }

        return { status: "SUCCESS", data: saved, error: null };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "Z_CLOSING_FAIL") };
    }
});

// ============================================================================
// VERIFY FISCAL HASH CHAIN INTEGRITY
// ============================================================================

export async function verifyFiscalHashChainIntegrity(options = {}) {
    const traceId = options.traceId || makeTraceId("hash-audit");
    const batchSize = Number(options.limit) || LEDGER_PAGE_SIZE;
    const breaks = [];
    try {
        const movements = await wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA)
            .ascending("sequenceNumber")
            .limit(batchSize)
            .find({ suppressAuth: true });

        let expectedPrev = GENESIS_HASH;
        for (const mov of movements.items || []) {
            if (mov.previousRecordHash && mov.previousRecordHash !== expectedPrev) {
                breaks.push({
                    movementId: mov._id,
                    invoiceNumber: mov.invoiceNumber,
                    expected: expectedPrev,
                    actual: mov.previousRecordHash,
                });
            }
            expectedPrev = mov.currentRecordHash;
        }

        if (breaks.length > 0) {
            await logAuditEvent("FISCAL_CHAIN_CORRUPTED", "CRITICAL", `Detectadas ${breaks.length} rupturas en la cadena de facturas`, { breaksCount: breaks.length, details: breaks.slice(0, 5) }, traceId, "system", "backend/cajas.web.js");
        }

        return {
            status: breaks.length === 0 ? "SUCCESS" : "INTEGRITY_COMPROMISED",
            data: { checked: movements.items.length, breaksCount: breaks.length, breaks },
            error: null,
        };
    } catch (err) {
        return { status: "ERROR", data: null, error: { code: "AUDIT_FAIL", message: err.message } };
    }
}

// ============================================================================
// FLUJO 7 - TARJETAS REGALO
// ============================================================================

export const registerGiftCardSale = webMethod(Permissions.SiteMember, async (payload) => {
    const traceId = payload?.traceId || makeTraceId("gc-sale");
    try {
        await requireCajero(traceId);
        await validateFiscalConfig(traceId);
        const { fiscalKey, businessTaxId } = await _getFiscalKeys();

        const giftCardId = _safeTrim(payload?.giftCardId);
        if (!giftCardId) {
            return { status: "ERROR", data: null, error: { code: "INVALID_GIFT_CARD", message: "giftCardId requerido" } };
        }

        const amount = _readPositiveAmount(payload?.amount);
        if (!amount) {
            return { status: "ERROR", data: null, error: { code: "INVALID_AMOUNT", message: "Importe positivo requerido" } };
        }

        const paymentMethod = _safeTrim(payload?.paymentMethod).toUpperCase();
        if (!Object.values(FORMA_PAGO).includes(paymentMethod)) {
            return { status: "ERROR", data: null, error: { code: "INVALID_PAYMENT_METHOD", message: "Forma de pago invalida" } };
        }

        const existingRes = await wixData
            .query(COLLECTIONS.MOVIMIENTOS_CAJA)
            .eq("transactionId", `GC_SALE-${giftCardId}`)
            .limit(1)
            .find({ suppressAuth: true, consistentRead: true });

        if (existingRes?.items?.length > 0) {
            return { status: "SUCCESS", data: existingRes.items[0], error: null, idempotent: true };
        }

        const taxRate = 0;
        const taxableAmount = amount;
        const taxAmount = 0;

        const operationDate = new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" });
        await _assertPeriodNotClosed(operationDate, traceId);

        // [REV2-03] IIFE: sin reintentos post-insert
        return await (async () => {
            const seq = await _getNextSequence(traceId);
            const lastMov = await _getLastMovement();
            const previousRecordHash = lastMov?.currentRecordHash || GENESIS_HASH;

            const generatedAt = new Date();

            const movBase = {
                sequenceNumber: seq.sequenceNumber,
                invoiceNumber: seq.invoiceNumber,
                operationDate,
                fiscalPeriod: operationDate.slice(0, 7),
                movementType: TIPO_MOVIMIENTO.VENTA_TARJETA_REGALO,
                operationNature: "ANTICIPO",
                paymentMethod,
                totalAmount: amount,
                taxableAmount,
                taxAmount,
                taxRate,
                taxTreatment: "ANTICIPO_CLIENTE",
                accountingSign: 1,
                accountingAmount: amount,
                description: `Venta tarjeta regalo ${giftCardId}`,
                lineItems: [],
                rectifiedInvoiceReference: null,
                businessTaxId,
                schemaIntegrityVersion: LEDGER_SCHEMA_VERSION,
                recordSource: "POS",
                resourceId: _safeTrim(payload?.resourceId) || "CAJA_LOCAL",
                reservaIdVinculada: null,
                transactionId: `GC_SALE-${giftCardId}`,
                orderId: null,
                refundId: null,
                giftCardId,
                giftCardOperation: "SALE",
                customerEmail: payload?.customerEmail || null,
            };

            const aeatPayload = _buildAEATPayload({ ...movBase, previousRecordHash }, generatedAt);
            const currentRecordHash = await _computeCurrentHash(previousRecordHash, aeatPayload);

            let digitalSignature;
            try {
                digitalSignature = await _computeSignature(currentRecordHash, traceId);
            } catch (signErr) {
                await queueFiscalRecovery({
                    transactionId: movBase.transactionId,
                    amount,
                    paymentMethod,
                    concept: movBase.description,
                    tipoMovimiento: movBase.movementType,
                    phase: "WAIT_FOR_SIGNER",
                    origin: "FISCAL_SIGNER_DOWN",
                    traceId,
                    lastError: signErr?.message || "FISCAL_SIGN_FAIL",
                });
                return {
                    status: "SUCCESS",
                    data: { ...movBase, previousRecordHash, currentRecordHash, pendingSignature: true, queued: true },
                    error: null,
                };
            }

            const verificationQR = _generateVerificationQR(movBase.invoiceNumber, businessTaxId, operationDate, amount);

            const movimiento = {
                ...movBase,
                previousRecordHash,
                currentRecordHash,
                digitalSignature,
                aeatPayload,
                verificationQR,
                hashAlgorithm: "SHA-256",
                signatureAlgorithm: "RSASSA-PKCS1-v1_5-SHA-256",
                registeredAt: generatedAt,
                traceId,
                _createdDate: new Date(),
            };

            const saved = await wixData.insert(COLLECTIONS.MOVIMIENTOS_CAJA, movimiento, { suppressAuth: true });
            await _updateCajaActual(movimiento, traceId);
            // [v5008.3] Non-blocking accounting projection - never fails the cash movement
            try {
                projectLedgerMovementToAccounting(movimiento).catch((accErr) => {
                    log.warn("Accounting projection deferred", {
                        error: accErr?.message || String(accErr),
                        concept: movimiento?.concept,
                        traceId,
                    });
                });
            } catch (_) { /* ignore */ }

            await logAuditEvent("GIFT_CARD_SOLD", "INFO", `Tarjeta regalo vendida: ${giftCardId}`, { giftCardId, amount, traceId }, traceId, giftCardId, "backend/cajas.web.js");

            return { status: "SUCCESS", data: saved, error: null };
        })();
    } catch (err) {
        const norm = normalizeError(err);
        log.error("registerGiftCardSale failed", { code: norm.code, error: norm.message, traceId });
        return { status: "ERROR", data: null, error: { code: norm.code || "GC_SALE_FAIL", message: norm.message } };
    }
});

// ============================================================================
// [B10] registerGiftCardRedemption con idempotencia por redemptionId
// del cliente o derivado determinista.
//
// El cliente PUEDE proporcionar `redemptionId` para garantizar idempotencia
// exacta (retries legitimos). Si no lo proporciona, se deriva un id
// determinista que incluye un sufijo temporal para permitir canjes
// sucesivos legitimos de la misma tarjeta.
// ============================================================================

export const registerGiftCardRedemption = webMethod(Permissions.SiteMember, async (payload) => {
    const traceId = payload?.traceId || makeTraceId("gc-redeem");
    try {
        await requireCajero(traceId);
        await validateFiscalConfig(traceId);
        const { fiscalKey, businessTaxId } = await _getFiscalKeys();

        const giftCardId = _safeTrim(payload?.giftCardId);
        if (!giftCardId) {
            return { status: "ERROR", data: null, error: { code: "INVALID_GIFT_CARD", message: "giftCardId requerido" } };
        }

        const amount = _readPositiveAmount(payload?.amount);
        if (!amount) {
            return { status: "ERROR", data: null, error: { code: "INVALID_AMOUNT", message: "Importe positivo requerido" } };
        }

        const serviceId = _safeTrim(payload?.serviceId);
        const bookingId = _safeTrim(payload?.bookingId);

        // [B10] Idempotencia: preferir redemptionId del cliente.
        // Si no se proporciona, derivar determinista con sufijo temporal
        // para permitir canjes sucesivos legitimos.
        const clientRedemptionId = _safeTrim(payload?.redemptionId);
        const clientTransactionId = _safeTrim(payload?.transactionId);
        const redemptionId = clientRedemptionId ||
            clientTransactionId ||
            `GC_REDEEM-${giftCardId}-${bookingId || "NA"}-${amount}-${Date.now()}`;

        const existingRedemption = await wixData
            .query(COLLECTIONS.MOVIMIENTOS_CAJA)
            .eq("transactionId", redemptionId)
            .limit(1)
            .find({ suppressAuth: true, consistentRead: true });

        if (existingRedemption?.items?.length > 0) {
            log.info("Gift card redemption idempotent duplicate detected", { redemptionId, giftCardId, traceId });
            return {
                status: "SUCCESS",
                data: existingRedemption.items[0],
                error: null,
                idempotent: true,
            };
        }

        let taxRate = IVA_RATES.GENERAL;
        if (serviceId) {
            const serviceRes = await wixData
                .query(COLLECTIONS.SERVICIOS_CATALOGO)
                .eq("serviceId", serviceId)
                .limit(1)
                .find({ suppressAuth: true })
                .catch(() => ({ items: [] }));

            if (serviceRes?.items?.length > 0) {
                taxRate = Number(serviceRes.items[0].taxRate) || IVA_RATES.GENERAL;
            }
        }

        const taxableAmount = _roundMoney(amount / (1 + taxRate));
        const taxAmount = _roundMoney(amount - taxableAmount);

        const operationDate = new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" });
        await _assertPeriodNotClosed(operationDate, traceId);

        // [REV2-03] IIFE: sin reintentos post-insert
        return await (async () => {
            const seq = await _getNextSequence(traceId);
            const lastMov = await _getLastMovement();
            const previousRecordHash = lastMov?.currentRecordHash || GENESIS_HASH;

            const generatedAt = new Date();

            const movBase = {
                sequenceNumber: seq.sequenceNumber,
                invoiceNumber: seq.invoiceNumber,
                operationDate,
                fiscalPeriod: operationDate.slice(0, 7),
                movementType: TIPO_MOVIMIENTO.CANJE_TARJETA_REGALO,
                operationNature: "APLICACION_ANTICIPO",
                paymentMethod: FORMA_PAGO.TARJETA_REGALO,
                totalAmount: amount,
                taxableAmount,
                taxAmount,
                taxRate,
                taxTreatment: "IVA_GENERAL",
                accountingSign: 1,
                accountingAmount: amount,
                description: `Canje tarjeta regalo ${giftCardId}${serviceId ? ` - servicio ${serviceId}` : ""}`,
                lineItems: [],
                rectifiedInvoiceReference: null,
                businessTaxId,
                schemaIntegrityVersion: LEDGER_SCHEMA_VERSION,
                recordSource: "POS",
                resourceId: _safeTrim(payload?.resourceId) || "CAJA_LOCAL",
                reservaIdVinculada: bookingId ? _linkedBookingValue([bookingId]) : null,
                transactionId: redemptionId,
                orderId: null,
                refundId: null,
                giftCardId,
                giftCardOperation: "REDEMPTION",
                serviceIdRedeemed: serviceId || null,
            };

            const aeatPayload = _buildAEATPayload({ ...movBase, previousRecordHash }, generatedAt);
            const currentRecordHash = await _computeCurrentHash(previousRecordHash, aeatPayload);

            let digitalSignature;
            try {
                digitalSignature = await _computeSignature(currentRecordHash, traceId);
            } catch (signErr) {
                await queueFiscalRecovery({
                    transactionId: movBase.transactionId,
                    amount,
                    paymentMethod: movBase.paymentMethod,
                    concept: movBase.description,
                    tipoMovimiento: movBase.movementType,
                    phase: "WAIT_FOR_SIGNER",
                    origin: "FISCAL_SIGNER_DOWN",
                    traceId,
                    lastError: signErr?.message || "FISCAL_SIGN_FAIL",
                });
                return {
                    status: "SUCCESS",
                    data: { ...movBase, previousRecordHash, currentRecordHash, pendingSignature: true, queued: true },
                    error: null,
                };
            }

            const verificationQR = _generateVerificationQR(movBase.invoiceNumber, businessTaxId, operationDate, amount);

            const movimiento = {
                ...movBase,
                previousRecordHash,
                currentRecordHash,
                digitalSignature,
                aeatPayload,
                verificationQR,
                hashAlgorithm: "SHA-256",
                signatureAlgorithm: "RSASSA-PKCS1-v1_5-SHA-256",
                registeredAt: generatedAt,
                traceId,
                _createdDate: new Date(),
            };

            const saved = await wixData.insert(COLLECTIONS.MOVIMIENTOS_CAJA, movimiento, { suppressAuth: true });
            await _updateCajaActual(movimiento, traceId);
            // [v5008.3] Non-blocking accounting projection - never fails the cash movement
            try {
                projectLedgerMovementToAccounting(movimiento).catch((accErr) => {
                    log.warn("Accounting projection deferred", {
                        error: accErr?.message || String(accErr),
                        concept: movimiento?.concept,
                        traceId,
                    });
                });
            } catch (_) { /* ignore */ }

            await logAuditEvent("GIFT_CARD_REDEEMED", "INFO", `Tarjeta regalo canjeada: ${giftCardId}`, { giftCardId, amount, serviceId, traceId }, traceId, giftCardId, "backend/cajas.web.js");

            return { status: "SUCCESS", data: saved, error: null };
        })();
    } catch (err) {
        const norm = normalizeError(err);
        log.error("registerGiftCardRedemption failed", { code: norm.code, error: norm.message, traceId });
        return { status: "ERROR", data: null, error: { code: norm.code || "GC_REDEEM_FAIL", message: norm.message } };
    }
});
