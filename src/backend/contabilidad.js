/*
=============================================================================
MODULE: backend/contabilidad.js
VERSION: v5007.5-CONSOLIDATED
RESPONSIBILITY: Proyeccion contable de movimientos de caja.
COLLECTIONS:
- AsientosContables
- LibroAsientosContablesDetalle
STANDARDS: G10 ASCII Strict.
=============================================================================
*/

import wixData from "wix-data";
import { getSecret } from "wix-secrets-backend";
import {
    COLLECTIONS,
    SDK_CONFIG,
    TIPO_MOVIMIENTO,
} from "backend/internalConfig";
import { SECRETS } from "backend/mmSecrets";
import {
    hmacSha256Hex,
    hashChain,
} from "backend/securityEngine";
import {
    _roundMoney,
    _cleanText,
    _safeTrim,
    makeTraceId,
} from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;
const MONEY_EPSILON = 0.005;
const TIME_ZONE = SDK_CONFIG?.TZ || "Europe/Madrid";
const SCHEMA_VERSION = "ASIENTO_V1";
const INTEGRITY_ALGORITHM_VERSION = "HMAC_SHA256_V1";

function _normalizeDate(value) {
    const date = value instanceof Date ?
        value :
        new Date(value || Date.now());

    return Number.isNaN(date.getTime()) ? new Date() : date;
}

function _toFiscalKeys(date) {
    const localDate = date.toLocaleDateString("sv-SE", {
        timeZone: TIME_ZONE,
    });

    return {
        fiscalYear: Number(localDate.slice(0, 4)),
        fiscalPeriod: localDate.slice(0, 7),
    };
}

function _safeAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
}

function _getSourceHash(movimiento) {
    return _safeTrim(
        movimiento?.hashCadena ||
        movimiento?.currentRecordHash ||
        movimiento?.sourceHash
    ) || "";
}

function _linePayload(line) {
    return [
        line.journalEntryId,
        line.lineNumber,
        line.accountCode,
        line.debitAmount,
        line.creditAmount,
        line.taxableAmount,
        line.taxRate,
        line.taxAmount,
        line.traceId,
    ].join("|");
}

async function _asAccountingLine(
    base,
    number,
    accountCode,
    accountName,
    debit,
    credit,
    tax = null
) {
    const line = {
        _id: `${base.journalEntryId}_L${String(number).padStart(3, "0")}`,
        journalEntryId: base.journalEntryId,
        transactionId: base.transactionId || null,
        lineNumber: number,
        operationDate: base.operationDate,
        accountCode: _cleanText(accountCode, 40),
        accountName: _cleanText(accountName, 120),
        accountGroup: "",
        debitAmount: _roundMoney(debit),
        creditAmount: _roundMoney(credit),
        netAmount: _roundMoney(
            _safeAmount(debit) - _safeAmount(credit)
        ),
        operationCategory: base.operationCategory,
        lineDescription: base.description,
        taxableAmount: tax?.taxableAmount ?? null,
        taxRate: tax?.taxRate ?? null,
        taxAmount: tax?.taxAmount ?? null,
        externalReference: base.externalReference || null,
        traceId: base.traceId,
        registeredAt: base.registeredAt,
        _createdDate: new Date(),
    };

    if (!line.accountCode || !line.accountName) {
        throw new Error("ACCOUNTING_PROJECTION_INVALID_ACCOUNT");
    }

    line.lineHash = await hashChain(
        base.hashOrigen || "",
        _linePayload(line)
    );

    return line;
}

function _getDefaultAccountMap(movementType) {
    const type = String(movementType || "").toUpperCase();

    const maps = {
        VENTA_EFECTIVO: ["570000", "Caja", "705000", "Prestaciones de servicios", "477000", "Hacienda Publica IVA repercutido"],
        VENTA_TARJETA: ["572000", "Bancos", "705000", "Prestaciones de servicios", "477000", "Hacienda Publica IVA repercutido"],
        VENTA_BIZUM: ["572000", "Bancos", "705000", "Prestaciones de servicios", "477000", "Hacienda Publica IVA repercutido"],
        VENTA_ONLINE: ["572000", "Bancos", "705000", "Prestaciones de servicios", "477000", "Hacienda Publica IVA repercutido"],
        VENTA_TARJETA_REGALO: ["570000", "Caja", "438000", "Anticipos de clientes", "", ""],
        CANJE_TARJETA_REGALO: ["438000", "Anticipos de clientes", "705000", "Prestaciones de servicios", "477000", "Hacienda Publica IVA repercutido"],
        REEMBOLSO: ["708000", "Devoluciones de ventas", "570000", "Caja", "477000", "Hacienda Publica IVA repercutido"],
        PAGO_PROVEEDOR: ["400000", "Proveedores", "570000", "Caja", "", ""],
        GASTO: ["600000", "Compras y gastos", "400000", "Proveedores", "472000", "Hacienda Publica IVA soportado"],
        AJUSTE: ["570000", "Caja", "555000", "Partidas pendientes de aplicacion", "", ""],
    };

    const values = maps[type];

    if (!values) {
        return null;
    }

    return {
        activa: true,
        validadaPorGestoria: true,
        codigoCuentaDebePredeterminada: values[0],
        nombreCuentaDebePredeterminada: values[1],
        codigoCuentaHaberPredeterminada: values[2],
        nombreCuentaHaberPredeterminada: values[3],
        codigoCuentaIvaRepercutido: values[4],
        nombreCuentaIvaRepercutido: values[5],
    };
}

function _isApprovedMap(map) {
    return Boolean(
        map?.activa &&
        map?.validadaPorGestoria &&
        map?.codigoCuentaDebePredeterminada &&
        map?.nombreCuentaDebePredeterminada &&
        map?.codigoCuentaHaberPredeterminada &&
        map?.nombreCuentaHaberPredeterminada
    );
}

async function _findAccountMap(movementType) {
    return _getDefaultAccountMap(movementType);
}

async function _getExisting(journalEntryId) {
    return wixData
        .get(
            COLLECTIONS.ASIENTOS_CONTABLES,
            journalEntryId, {
                suppressAuth: true,
                consistentRead: true,
            }
        )
        .catch(() => null);
}

async function _insertLineIfMissing(line) {
    const existing = await wixData
        .get(
            COLLECTIONS.LIBRO_ASIENTOS_CONTABLES_DETALLE,
            line._id, {
                suppressAuth: true,
                consistentRead: true,
            }
        )
        .catch(() => null);

    if (existing) {
        return {
            idempotent: true,
            item: existing,
        };
    }

    const inserted = await wixData.insert(
        COLLECTIONS.LIBRO_ASIENTOS_CONTABLES_DETALLE,
        line, { suppressAuth: true }
    );

    return {
        idempotent: false,
        item: inserted,
    };
}

function _buildBase(movimiento) {
    const operationDate = _normalizeDate(
        movimiento?.registeredAt ||
        movimiento?.operationDate
    );
    const fiscalKeys = _toFiscalKeys(operationDate);
    const sourceId = _cleanText(movimiento?._id, 120);
    const movementType = String(
        movimiento?.movementType ||
        movimiento?.tipoMovimiento ||
        "AJUSTE"
    ).toUpperCase();
    const hashOrigen = _getSourceHash(movimiento);

    return {
        journalEntryId: `ASIENTO_${sourceId}`,
        sequenceNumber: Number(movimiento?.sequenceNumber) || 0,
        fiscalYear: fiscalKeys.fiscalYear,
        fiscalPeriod: fiscalKeys.fiscalPeriod,
        operationDate,
        registeredAt: new Date(),
        operationTimeZone: TIME_ZONE,
        entryType: movementType,
        operationCategory: movementType,
        description: _cleanText(
            movimiento?.description ||
            movimiento?.concepto ||
            movementType,
            500
        ),
        recordSource: _cleanText(
            movimiento?.recordSource ||
            movimiento?.origen ||
            "MOVIMIENTO_CAJA",
            80
        ),
        sourceId,
        transactionId: _cleanText(
            movimiento?.transactionId,
            120
        ),
        externalReference: _cleanText(
            movimiento?.invoiceNumber ||
            movimiento?.numTicketFactura,
            120
        ) || null,
        invoiceNumber: _cleanText(
            movimiento?.invoiceNumber ||
            movimiento?.numTicketFactura,
            120
        ) || null,
        invoiceIssueDate: operationDate,
        fiscalOperationDate: operationDate,
        currency: "EUR",
        totalDocumentAmount: _roundMoney(
            Math.abs(
                _safeAmount(
                    movimiento?.accountingAmount ??
                    movimiento?.totalAmount
                )
            )
        ),
        paymentMethod: _cleanText(
            movimiento?.paymentMethod,
            40
        ) || null,
        entryStatus: "CONFIRMADO",
        previousHash: _safeTrim(
            movimiento?.previousRecordHash ||
            movimiento?.hashCadena
        ) || null,
        sourceHash: hashOrigen,
        hashOrigen,
        schemaVersion: SCHEMA_VERSION,
        integrityAlgorithmVersion: INTEGRITY_ALGORITHM_VERSION,
        traceId: _cleanText(
            movimiento?.traceId ||
            makeTraceId("contabilidad"),
            120
        ),
    };
}

async function _buildLines(base, movimiento, map) {
    const signedTotal = _safeAmount(
        movimiento?.accountingAmount ??
        movimiento?.totalAmount
    );
    const total = Math.abs(signedTotal);
    const vat = Math.abs(
        _safeAmount(
            movimiento?.taxAmount ??
            movimiento?.cuotaIva
        )
    );
    const sourceTaxable = Math.abs(
        _safeAmount(
            movimiento?.taxableAmount ??
            movimiento?.baseImponible
        )
    );
    const net = _roundMoney(
        sourceTaxable > MONEY_EPSILON ?
        sourceTaxable :
        total - vat
    );
    const taxRateValue = Number(
        movimiento?.taxRate ??
        movimiento?.tasaIva
    );
    const taxRate = Number.isFinite(taxRateValue) ?
        taxRateValue :
        null;

    if (
        total <= MONEY_EPSILON ||
        net < -MONEY_EPSILON ||
        vat > total + MONEY_EPSILON
    ) {
        throw new Error("ACCOUNTING_PROJECTION_INVALID_AMOUNT");
    }

    const tax = {
        taxableAmount: net,
        taxRate,
        taxAmount: vat || null,
    };

    const vatCode = _cleanText(
        map.codigoCuentaIvaRepercutido,
        40
    );
    const vatName = _cleanText(
        map.nombreCuentaIvaRepercutido,
        120
    );
    const lines = [];
    const isRefund = signedTotal < 0;

    if (!isRefund) {
        lines.push(
            await _asAccountingLine(
                base,
                1,
                map.codigoCuentaDebePredeterminada,
                map.nombreCuentaDebePredeterminada,
                total,
                0,
                null
            )
        );

        lines.push(
            await _asAccountingLine(
                base,
                2,
                map.codigoCuentaHaberPredeterminada,
                map.nombreCuentaHaberPredeterminada,
                0,
                net,
                tax
            )
        );

        if (vat > MONEY_EPSILON) {
            if (!vatCode || !vatName) {
                throw new Error(
                    "ACCOUNTING_PROJECTION_MISSING_VAT_ACCOUNT"
                );
            }

            lines.push(
                await _asAccountingLine(
                    base,
                    3,
                    vatCode,
                    vatName,
                    0,
                    vat,
                    tax
                )
            );
        }
    } else {
        lines.push(
            await _asAccountingLine(
                base,
                1,
                map.codigoCuentaHaberPredeterminada,
                map.nombreCuentaHaberPredeterminada,
                net,
                0,
                tax
            )
        );

        if (vat > MONEY_EPSILON) {
            if (!vatCode || !vatName) {
                throw new Error(
                    "ACCOUNTING_PROJECTION_MISSING_VAT_ACCOUNT"
                );
            }

            lines.push(
                await _asAccountingLine(
                    base,
                    2,
                    vatCode,
                    vatName,
                    vat,
                    0,
                    tax
                )
            );
        }

        lines.push(
            await _asAccountingLine(
                base,
                vat > MONEY_EPSILON ? 3 : 2,
                map.codigoCuentaDebePredeterminada,
                map.nombreCuentaDebePredeterminada,
                0,
                total,
                null
            )
        );
    }

    const totalDebe = _roundMoney(
        lines.reduce(
            (sum, line) => sum + Number(line.debitAmount || 0),
            0
        )
    );

    const totalHaber = _roundMoney(
        lines.reduce(
            (sum, line) => sum + Number(line.creditAmount || 0),
            0
        )
    );

    if (Math.abs(totalDebe - totalHaber) > MONEY_EPSILON) {
        throw new Error("ACCOUNTING_PROJECTION_UNBALANCED");
    }

    return {
        lines,
        totalDebe,
        totalHaber,
    };
}

export async function projectLedgerMovementToAccounting(
    movimiento
) {
    const traceId = makeTraceId("contabilidad");

    try {
        const sourceId = _cleanText(movimiento?._id, 120);
        const sourceHash = _getSourceHash(movimiento);
        const transactionId = _cleanText(
            movimiento?.transactionId,
            120
        );

        if (!sourceId || !sourceHash || !transactionId) {
            return {
                status: "SKIPPED",
                reason: "INVALID_SOURCE_LEDGER",
            };
        }

        if (
            movimiento?.movementType === TIPO_MOVIMIENTO.PROPINA ||
            movimiento?.taxTreatment ===
            "PROPINA_PENDIENTE_GESTORIA"
        ) {
            return {
                status: "SKIPPED",
                reason: "TIP_TREATMENT_PENDING_PROFESSIONAL_REVIEW",
            };
        }

        if (SDK_CONFIG?.ACCOUNTING?.ENABLED !== true) {
            return {
                status: "SKIPPED",
                reason: "ACCOUNTING_DISABLED",
            };
        }

        const base = _buildBase(movimiento);
        const existing = await _getExisting(
            base.journalEntryId
        );

        if (existing) {
            return {
                status: "SUCCESS",
                idempotent: true,
                idAsiento: base.journalEntryId,
            };
        }

        const map = await _findAccountMap(
            base.operationCategory
        );

        if (!_isApprovedMap(map)) {
            return {
                status: "SKIPPED",
                reason: "NO_APPROVED_ACCOUNT_MAP",
            };
        }

        const projected = await _buildLines(
            base,
            movimiento,
            map
        );

        const fiscalKey = await getSecret(
            SECRETS.FISCAL_KEY
        );

        if (!fiscalKey) {
            throw new Error(
                "ACCOUNTING_PROJECTION_SIGNING_KEY_MISSING"
            );
        }

        const headerPayload = [
            base.journalEntryId,
            base.sequenceNumber,
            base.sourceId,
            base.transactionId,
            projected.totalDebe,
            projected.totalHaber,
            ...projected.lines.map((line) => line.lineHash),
        ].join("|");

        const hashAsiento = await hashChain(
            base.hashOrigen,
            headerPayload
        );

        const firmaAsiento = [
            await hmacSha256Hex(
                fiscalKey,
                headerPayload
            ),
            hashAsiento,
        ].join("|");

        const header = {
            ...base,
            totalDebe: projected.totalDebe,
            totalHaber: projected.totalHaber,
            hashAsiento,
            firmaAsiento,
        };

        for (const line of projected.lines) {
            await _insertLineIfMissing(line);
        }

        const savedHeader = await wixData.insert(
            COLLECTIONS.ASIENTOS_CONTABLES,
            header, { suppressAuth: true }
        );

        return {
            status: "SUCCESS",
            idempotent: false,
            idAsiento: savedHeader?._id ||
                base.journalEntryId,
            lineCount: projected.lines.length,
        };
    } catch (error) {
        log.error(
            "projectLedgerMovementToAccounting failed", {
                traceId,
                message: error?.message || String(error),
            }
        );

        throw error;
    }
}

export function isAccountingProjectionError(error) {
    return String(
        error?.message || error || ""
    ).startsWith("ACCOUNTING_PROJECTION_");
}