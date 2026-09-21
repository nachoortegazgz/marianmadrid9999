/*
=============================================================================
MODULE: backend/contabilidad.js
VERSION: v5007.8-FISCAL
RESPONSIBILITY: Proyeccion contable de movimientos de caja.
FIXES v5007.8:
  - FIX-FISCAL-02: Cuenta de retencion segun rolFiscal:
                   EMISOR -> 475100 al HABER
                   RECEPTOR -> 473000 al DEBE
=============================================================================
*/

import wixData from "wix-data";
import { getSecret } from "wix-secrets-backend";
import {
    COLLECTIONS,
    SDK_CONFIG,
    TIPO_MOVIMIENTO,
    CUENTAS_PGC,
    CLAVES_AEAT,
    ROL_FISCAL,
} from "backend/internalConfig";
import { SECRETS } from "backend/mmSecrets";
import { hmacSha256Hex, hashChain } from "backend/securityEngine";
import { _roundMoney, _cleanText, _safeTrim, makeTraceId } from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;
const MONEY_EPSILON = 0.005;
const TIME_ZONE = SDK_CONFIG?.TZ || "Europe/Madrid";
const SCHEMA_VERSION = "ASIENTO_V3_FISCAL";
const INTEGRITY_ALGORITHM_VERSION = "HMAC_SHA256_V1";

function _normalizeDate(value) {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? new Date() : date;
}

function _toFiscalKeys(date) {
    const localDate = date.toLocaleDateString("sv-SE", { timeZone: TIME_ZONE });
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
        line.journalEntryId, line.lineNumber, line.accountCode,
        line.debitAmount, line.creditAmount,
        line.taxableAmount, line.taxRate, line.taxAmount, line.traceId,
        line.nifTercero || "",
        line.irpfWithholdingAmount || 0,
        line.importeRecargoEquivalencia || 0,
        line.correctionReason || "",
    ].join("|");
}

async function _asAccountingLine(base, number, accountCode, accountName, debit, credit, tax = null) {
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
        netAmount: _roundMoney(_safeAmount(debit) - _safeAmount(credit)),
        operationCategory: base.operationCategory,
        lineDescription: base.description,
        taxableAmount: tax?.taxableAmount ?? null,
        taxRate: tax?.taxRate ?? null,
        taxAmount: tax?.taxAmount ?? null,
        externalReference: base.externalReference || null,
        traceId: base.traceId,
        registeredAt: base.registeredAt,
        _createdDate: new Date(),

        nifTercero: base.nifTercero || null,
        razonSocialTercero: base.razonSocialTercero || null,
        numeroSerieFacturaEmisor: base.numeroSerieFacturaEmisor || null,
        claveRegistroFactura: base.claveRegistroFactura || null,
        importeRetencionIRPF: Number(base.irpfWithholdingAmount) || 0,
        baseImponibleRetencion: Number(base.withholdingBase) || 0,
        importeRecargoEquivalencia: Number(base.importeRecargoEquivalencia) || 0,
        motivoRectificacion: base.correctionReason || null,
        idFacturaRectificada: base.idFacturaRectificada || null,
        rolFiscal: base.rolFiscal || ROL_FISCAL.EMISOR,
    };

    if (!line.accountCode || !line.accountName) {
        throw new Error("ACCOUNTING_PROJECTION_INVALID_ACCOUNT");
    }

    line.lineHash = await hashChain(base.sourceHash || "", _linePayload(line));
    return line;
}

function _getDefaultAccountMap(movementType) {
    const type = String(movementType || "").toUpperCase();

    const maps = {
        VENTA_EFECTIVO: [CUENTAS_PGC.CAJA, "Caja", CUENTAS_PGC.PRESTACIONES_SERVICIOS, "Prestaciones de servicios", CUENTAS_PGC.IVA_REPERCUTIDO, "Hacienda Publica IVA repercutido"],
        VENTA_TARJETA: [CUENTAS_PGC.BANCOS, "Bancos", CUENTAS_PGC.PRESTACIONES_SERVICIOS, "Prestaciones de servicios", CUENTAS_PGC.IVA_REPERCUTIDO, "Hacienda Publica IVA repercutido"],
        VENTA_BIZUM: [CUENTAS_PGC.BANCOS, "Bancos", CUENTAS_PGC.PRESTACIONES_SERVICIOS, "Prestaciones de servicios", CUENTAS_PGC.IVA_REPERCUTIDO, "Hacienda Publica IVA repercutido"],
        VENTA_ONLINE: [CUENTAS_PGC.BANCOS, "Bancos", CUENTAS_PGC.PRESTACIONES_SERVICIOS, "Prestaciones de servicios", CUENTAS_PGC.IVA_REPERCUTIDO, "Hacienda Publica IVA repercutido"],
        VENTA_TARJETA_REGALO: [CUENTAS_PGC.CAJA, "Caja", CUENTAS_PGC.ANTICIPOS_CLIENTES, "Anticipos de clientes", "", ""],
        CANJE_TARJETA_REGALO: [CUENTAS_PGC.ANTICIPOS_CLIENTES, "Anticipos de clientes", CUENTAS_PGC.PRESTACIONES_SERVICIOS, "Prestaciones de servicios", CUENTAS_PGC.IVA_REPERCUTIDO, "Hacienda Publica IVA repercutido"],
        REEMBOLSO: [CUENTAS_PGC.DEVOLUCIONES_VENTAS, "Devoluciones de ventas", CUENTAS_PGC.CAJA, "Caja", CUENTAS_PGC.IVA_REPERCUTIDO, "Hacienda Publica IVA repercutido"],
        PAGO_PROVEEDOR: [CUENTAS_PGC.PROVEEDORES, "Proveedores", CUENTAS_PGC.CAJA, "Caja", "", ""],
        GASTO: [CUENTAS_PGC.COMPRAS_GASTOS, "Compras y gastos", CUENTAS_PGC.PROVEEDORES, "Proveedores", CUENTAS_PGC.IVA_SOPORTADO, "Hacienda Publica IVA soportado"],
        AJUSTE: [CUENTAS_PGC.CAJA, "Caja", CUENTAS_PGC.PARTIDAS_PENDIENTES, "Partidas pendientes de aplicacion", "", ""],
        SERVICIO_PROFESIONAL: [CUENTAS_PGC.PRESTACIONES_SERVICIOS, "Prestaciones de servicios", CUENTAS_PGC.CAJA, "Caja", CUENTAS_PGC.IVA_REPERCUTIDO, "Hacienda Publica IVA repercutido"],
    };

    const values = maps[type];
    if (!values) return null;

    return {
        activa: true, validadaPorGestoria: true,
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
        map?.activa && map?.validadaPorGestoria &&
        map?.codigoCuentaDebePredeterminada && map?.nombreCuentaDebePredeterminada &&
        map?.codigoCuentaHaberPredeterminada && map?.nombreCuentaHaberPredeterminada
    );
}

function _findAccountMap(movementType) {
    return _getDefaultAccountMap(movementType);
}

async function _getExisting(journalEntryId) {
    return wixData
        .get(COLLECTIONS.ASIENTOS_CONTABLES, journalEntryId, { suppressAuth: true, consistentRead: true })
        .catch(() => null);
}

async function _insertLineIfMissing(line) {
    const existing = await wixData
        .get(COLLECTIONS.LIBRO_ASIENTOS_CONTABLES_DETALLE, line._id, { suppressAuth: true, consistentRead: true })
        .catch(() => null);

    if (existing) return { idempotent: true, item: existing };

    const inserted = await wixData.insert(
        COLLECTIONS.LIBRO_ASIENTOS_CONTABLES_DETALLE, line, { suppressAuth: true }
    );
    return { idempotent: false, item: inserted };
}

function _buildBase(movimiento) {
    const operationDate = _normalizeDate(movimiento?.registeredAt || movimiento?.operationDate);
    const fiscalKeys = _toFiscalKeys(operationDate);
    const sourceId = _cleanText(movimiento?._id, 120);
    const movementType = String(movimiento?.movementType || movimiento?.movementType || "AJUSTE").toUpperCase();
    const hashOrigen = _getSourceHash(movimiento);

    const recordSource = _cleanText(movimiento?.recordSource || movimiento?.origen || "MOVIMIENTO_CAJA", 80);

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
        description: _cleanText(movimiento?.description || movimiento?.concepto || movementType, 500),
        recordSource,
        sourceId,
        transactionId: _cleanText(movimiento?.transactionId, 120),
        externalReference: _cleanText(movimiento?.invoiceNumber || movimiento?.numTicketFactura, 120) || null,
        invoiceNumber: _cleanText(movimiento?.invoiceNumber || movimiento?.numTicketFactura, 120) || null,
        invoiceIssueDate: operationDate,
        fiscalOperationDate: operationDate,
        currency: "EUR",
        totalDocumentAmount: _roundMoney(Math.abs(_safeAmount(movimiento?.accountingAmount ?? movimiento?.totalAmount))),
        paymentMethod: _cleanText(movimiento?.paymentMethod, 40) || null,
        entryStatus: "CONFIRMADO",
        previousHash: _safeTrim(movimiento?.previousRecordHash || movimiento?.hashCadena) || null,
        sourceHash: hashOrigen,
        hashOrigen,
        schemaVersion: SCHEMA_VERSION,
        integrityAlgorithmVersion: INTEGRITY_ALGORITHM_VERSION,
        traceId: _cleanText(movimiento?.traceId || makeTraceId("contabilidad"), 120),

        nifTercero: _cleanText(movimiento?.nifTercero, 20) || null,
        razonSocialTercero: _cleanText(movimiento?.razonSocialTercero, 200) || null,
        numeroSerieFacturaEmisor: _cleanText(movimiento?.numeroSerieFacturaEmisor, 60) || null,
        claveRegistroFactura: _cleanText(movimiento?.claveRegistroFactura || CLAVES_AEAT.F1, 4),
        baseImponibleRetencion: Number(movimiento?.withholdingBase) || 0,
        importeRetencionIRPF: Number(movimiento?.irpfWithholdingAmount) || 0,
        importeRecargoEquivalencia: Number(movimiento?.importeRecargoEquivalencia) || 0,
        rolFiscal: _cleanText(movimiento?.rolFiscal || ROL_FISCAL.EMISOR, 10),
        motivoRectificacion: _cleanText(movimiento?.correctionReason, 4) || null,
        idFacturaRectificada: _cleanText(movimiento?.idFacturaRectificada, 120) || null,

        datosOrigenAsiento: {
            fuente: recordSource,
            idExterno: _cleanText(movimiento?.orderId || movimiento?.transactionId || movimiento?.refundId || sourceId, 120),
            orderId: _cleanText(movimiento?.orderId, 120) || null,
            refundId: _cleanText(movimiento?.refundId, 120) || null,
            bookingIds: _cleanText(movimiento?.linkedBookingIds, 500) || null,
        },
    };
}

async function _buildLines(base, movimiento, map) {
    const signedTotal = _safeAmount(movimiento?.accountingAmount ?? movimiento?.totalAmount);
    const total = Math.abs(signedTotal);
    const vat = Math.abs(_safeAmount(movimiento?.taxAmount ?? movimiento?.cuotaIva));
    const sourceTaxable = Math.abs(_safeAmount(movimiento?.taxableAmount ?? movimiento?.baseImponible));
    const net = _roundMoney(sourceTaxable > MONEY_EPSILON ? sourceTaxable : total - vat);
    const taxRateValue = Number(movimiento?.taxRate ?? movimiento?.tasaIva);
    const taxRate = Number.isFinite(taxRateValue) ? taxRateValue : null;

    const retencionIRPF = Math.abs(Number(movimiento?.irpfWithholdingAmount) || 0);
    const recargoEquivalencia = Math.abs(Number(movimiento?.importeRecargoEquivalencia) || 0);

    // [FIX-FISCAL-02] Cuenta de retencion segun rol
    const rolFiscal = base.rolFiscal || ROL_FISCAL.EMISOR;
    const retencionCuentaCode = rolFiscal === ROL_FISCAL.RECEPTOR
        ? CUENTAS_PGC.HP_RETENCIONES_IRPF_A_FAVOR
        : CUENTAS_PGC.HP_RETENCIONES_IRPF_A_INGRESAR;
    const retencionCuentaName = rolFiscal === ROL_FISCAL.RECEPTOR
        ? "H.P. Retenciones IRPF a favor"
        : "H.P. Retenciones IRPF a ingresar";

    if (total <= MONEY_EPSILON || net < -MONEY_EPSILON || vat > total + MONEY_EPSILON) {
        throw new Error("ACCOUNTING_PROJECTION_INVALID_AMOUNT");
    }

    const tax = { taxableAmount: net, taxRate, taxAmount: vat || null };
    const vatCode = _cleanText(map.codigoCuentaIvaRepercutido, 40);
    const vatName = _cleanText(map.nombreCuentaIvaRepercutido, 120);
    const lines = [];
    const isRefund = signedTotal < 0;

    if (!isRefund) {
        lines.push(await _asAccountingLine(base, 1, map.codigoCuentaDebePredeterminada, map.nombreCuentaDebePredeterminada, total, 0, null));
        lines.push(await _asAccountingLine(base, 2, map.codigoCuentaHaberPredeterminada, map.nombreCuentaHaberPredeterminada, 0, net, tax));

        if (vat > MONEY_EPSILON) {
            if (!vatCode || !vatName) throw new Error("ACCOUNTING_PROJECTION_MISSING_VAT_ACCOUNT");
            lines.push(await _asAccountingLine(base, 3, vatCode, vatName, 0, vat, tax));
        }

        if (recargoEquivalencia > MONEY_EPSILON) {
            lines.push(await _asAccountingLine(base, lines.length + 1, CUENTAS_PGC.HP_RECARGO_EQUIVALENCIA, "H.P. Recargo de equivalencia", 0, recargoEquivalencia, tax));
        }

        // [FIX-FISCAL-02] Retencion al debe o al haber segun rol
        if (retencionIRPF > MONEY_EPSILON) {
            if (rolFiscal === ROL_FISCAL.RECEPTOR) {
                // Nos retienen: DEBE HP retenciones a favor
                lines.push(await _asAccountingLine(base, lines.length + 1, retencionCuentaCode, retencionCuentaName, retencionIRPF, 0, tax));
            } else {
                // Retenemos: HABER HP retenciones a ingresar
                lines.push(await _asAccountingLine(base, lines.length + 1, retencionCuentaCode, retencionCuentaName, 0, retencionIRPF, tax));
            }
        }
    } else {
        lines.push(await _asAccountingLine(base, 1, map.codigoCuentaHaberPredeterminada, map.nombreCuentaHaberPredeterminada, net, 0, tax));

        if (vat > MONEY_EPSILON) {
            if (!vatCode || !vatName) throw new Error("ACCOUNTING_PROJECTION_MISSING_VAT_ACCOUNT");
            lines.push(await _asAccountingLine(base, 2, vatCode, vatName, vat, 0, tax));
        }

        if (recargoEquivalencia > MONEY_EPSILON) {
            lines.push(await _asAccountingLine(base, lines.length + 1, CUENTAS_PGC.HP_RECARGO_EQUIVALENCIA, "H.P. Recargo de equivalencia", recargoEquivalencia, 0, tax));
        }

        if (retencionIRPF > MONEY_EPSILON) {
            if (rolFiscal === ROL_FISCAL.RECEPTOR) {
                lines.push(await _asAccountingLine(base, lines.length + 1, retencionCuentaCode, retencionCuentaName, 0, retencionIRPF, tax));
            } else {
                lines.push(await _asAccountingLine(base, lines.length + 1, retencionCuentaCode, retencionCuentaName, retencionIRPF, 0, tax));
            }
        }

        lines.push(await _asAccountingLine(base, lines.length + 1, map.codigoCuentaDebePredeterminada, map.nombreCuentaDebePredeterminada, 0, total, null));
    }

    const totalDebe = _roundMoney(lines.reduce((sum, line) => sum + Number(line.debitAmount || 0), 0));
    const totalHaber = _roundMoney(lines.reduce((sum, line) => sum + Number(line.creditAmount || 0), 0));

    if (Math.abs(totalDebe - totalHaber) > MONEY_EPSILON) {
        throw new Error("ACCOUNTING_PROJECTION_UNBALANCED");
    }

    return { lines, totalDebe, totalHaber };
}

export async function projectLedgerMovementToAccounting(movimiento) {
    const traceId = makeTraceId("contabilidad");

    try {
        const sourceId = _cleanText(movimiento?._id, 120);
        const sourceHash = _getSourceHash(movimiento);
        const transactionId = _cleanText(movimiento?.transactionId, 120);

        if (!sourceId || !sourceHash || !transactionId) {
            return { status: "SKIPPED", reason: "INVALID_SOURCE_LEDGER" };
        }

        if (movimiento?.movementType === TIPO_MOVIMIENTO.PROPINA || movimiento?.taxTreatment === "PROPINA_PENDIENTE_GESTORIA") {
            return { status: "SKIPPED", reason: "TIP_TREATMENT_PENDING_PROFESSIONAL_REVIEW" };
        }

        if (SDK_CONFIG?.ACCOUNTING?.ENABLED !== true) {
            return { status: "SKIPPED", reason: "ACCOUNTING_DISABLED" };
        }

        const base = _buildBase(movimiento);
        const existing = await _getExisting(base.journalEntryId);

        if (existing) {
            return { status: "SUCCESS", idempotent: true, idAsiento: base.journalEntryId };
        }

        const map = _findAccountMap(base.operationCategory);

        if (!_isApprovedMap(map)) {
            return { status: "SKIPPED", reason: "NO_APPROVED_ACCOUNT_MAP" };
        }

        const projected = await _buildLines(base, movimiento, map);

        const fiscalKey = await getSecret(SECRETS.FISCAL_KEY);
        if (!fiscalKey) throw new Error("ACCOUNTING_PROJECTION_SIGNING_KEY_MISSING");

        const headerPayload = [
            base.journalEntryId, base.sequenceNumber, base.sourceId, base.transactionId,
            projected.totalDebe, projected.totalHaber,
            ...projected.lines.map((line) => line.lineHash),
        ].join("|");

        const hashAsiento = await hashChain(base.sourceHash, headerPayload);
        const firmaAsiento = [
            await hmacSha256Hex(fiscalKey, headerPayload),
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

        const savedHeader = await wixData.insert(COLLECTIONS.ASIENTOS_CONTABLES, header, { suppressAuth: true });

        return {
            status: "SUCCESS",
            idempotent: false,
            idAsiento: savedHeader?._id || base.journalEntryId,
            lineCount: projected.lines.length,
        };
    } catch (error) {
        log.error("projectLedgerMovementToAccounting failed", {
            traceId,
            message: error?.message || String(error),
        });
        throw error;
    }
}

export function isAccountingProjectionError(error) {
    return String(error?.message || error || "").startsWith("ACCOUNTING_PROJECTION_");
}
