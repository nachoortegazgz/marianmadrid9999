/*
=============================================================================
MODULE: backend/facturasRecibidas.web.js
VERSION: v5007.5-CONSOLIDATED
RESPONSIBILITY: Registro de facturas recibidas y asiento contable consolidado.
COLLECTIONS:
- AsientosContables
- LibroAsientosContablesDetalle
STANDARDS: G10 ASCII Strict.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import {
    COLLECTIONS,
    SDK_CONFIG,
    FORMA_PAGO,
    TIPO_MOVIMIENTO,
} from "backend/internalConfig";
import {
    makeTraceId,
    _safeTrim,
    _readPositiveAmount,
    _readDate,
    _roundMoney,
} from "public/mmUtils";
import { logger } from "backend/logger";
import { requireAdmin, requireCajero } from "backend/security";
import { _toPublicError } from "backend/responseUtils";
import { registerManualTransaction } from "backend/cajas.web";
import { normalizeError } from "backend/booking/bookingCore";
import { logAuditEvent } from "backend/audit";

const log = logger;
const MODULE_VERSION = "RECEIVED_INVOICE_V1";

function _isValidNIF(value) {
    const nif = _safeTrim(value).toUpperCase();

    if (!nif) {
        return false;
    }

    return /^[A-Z0-9]{9}$/.test(nif);
}

function _error(code, message) {
    return {
        status: "ERROR",
        data: null,
        error: { code, message },
    };
}

async function _getExistingEntry(receptionNumber) {
    return wixData
        .get(
            COLLECTIONS.ASIENTOS_CONTABLES,
            `GASTO_${receptionNumber}`, {
                suppressAuth: true,
                consistentRead: true,
            }
        )
        .catch(() => null);
}

async function _insertAccountingLine(line) {
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
        return existing;
    }

    return wixData.insert(
        COLLECTIONS.LIBRO_ASIENTOS_CONTABLES_DETALLE,
        line, { suppressAuth: true }
    );
}

function _buildAccountingLines(invoice, journalEntryId, traceId) {
    const issueDate = new Date(invoice.issueDate);
    const now = new Date();
    const total = _roundMoney(invoice.totalInvoiceAmount);
    const taxable = _roundMoney(invoice.taxableAmount);
    const tax = _roundMoney(invoice.inputTaxAmount);
    const paymentAccount = invoice.paymentDate ? "570000" : "400000";
    const paymentName = invoice.paymentDate ? "Caja" : "Proveedores";
    const paymentType = invoice.paymentDate ?
        "PAGO_PROVEEDOR" :
        "DEUDA_PROVEEDOR";

    const lines = [{
        _id: `${journalEntryId}_L001`,
        journalEntryId,
        transactionId: invoice.transactionId,
        lineNumber: 1,
        movementType: "GASTO_PROVEEDOR",
        accountCode: "600000",
        accountName: "Compras y gastos",
        debitAmount: taxable,
        creditAmount: 0,
        netAmount: taxable,
        taxableAmount: taxable,
        taxRate: invoice.taxRate,
        taxAmount: tax,
        lineDescription: invoice.expenseConcept,
        traceId,
        operationDate: issueDate,
        registeredAt: now,
        _createdDate: now,
    }, ];

    if (tax > 0) {
        lines.push({
            _id: `${journalEntryId}_L002`,
            journalEntryId,
            transactionId: invoice.transactionId,
            lineNumber: 2,
            movementType: "IVA_SOPORTADO",
            accountCode: "472000",
            accountName: "Hacienda Publica IVA soportado",
            debitAmount: tax,
            creditAmount: 0,
            netAmount: tax,
            taxableAmount: taxable,
            taxRate: invoice.taxRate,
            taxAmount: tax,
            lineDescription: "IVA soportado",
            traceId,
            operationDate: issueDate,
            registeredAt: now,
            _createdDate: now,
        });
    }

    lines.push({
        _id: `${journalEntryId}_L${String(lines.length + 1).padStart(3, "0")}`,
        journalEntryId,
        transactionId: invoice.transactionId,
        lineNumber: lines.length + 1,
        movementType: paymentType,
        accountCode: paymentAccount,
        accountName: paymentName,
        debitAmount: 0,
        creditAmount: total,
        netAmount: -total,
        taxableAmount: null,
        taxRate: null,
        taxAmount: null,
        lineDescription: invoice.paymentDate ?
            `Pago a ${invoice.supplierName}` :
            `Deuda con ${invoice.supplierName}`,
        traceId,
        operationDate: issueDate,
        registeredAt: now,
        _createdDate: now,
    });

    return lines;
}

async function _generateExpenseAccountingEntry(invoice, traceId) {
    const journalEntryId = `GASTO_${invoice.receptionNumber}`;
    const existing = await _getExistingEntry(invoice.receptionNumber);

    if (existing) {
        return {
            item: existing,
            idempotent: true,
        };
    }

    const now = new Date();
    const total = _roundMoney(invoice.totalInvoiceAmount);

    const asiento = {
        _id: journalEntryId,
        journalEntryId,
        transactionId: invoice.transactionId,
        sequenceNumber: 0,
        fiscalYear: invoice.fiscalYear,
        fiscalPeriod: invoice.fiscalPeriod,
        operationDate: new Date(invoice.issueDate),
        fiscalOperationDate: new Date(invoice.issueDate),
        description: `Gasto: ${invoice.expenseConcept} - ${invoice.supplierName}`,
        totalDebit: total,
        totalCredit: total,
        totalDocumentAmount: total,
        entryType: "GASTO_PROVEEDOR",
        operationCategory: "GASTO_PROVEEDOR",
        entryStatus: "CONFIRMADO",
        currency: "EUR",
        paymentMethod: invoice.paymentMethod,
        invoiceNumber: invoice.supplierInvoiceSeriesNumber,
        invoiceIssueDate: new Date(invoice.issueDate),
        invoiceType: "RECIBIDA",
        supplierTaxId: invoice.supplierTaxId,
        supplierName: invoice.supplierName,
        receptionNumber: invoice.receptionNumber,
        taxableAmount: invoice.taxableAmount,
        taxRate: invoice.taxRate,
        inputTaxAmount: invoice.inputTaxAmount,
        deductibleTaxAmount: invoice.deductibleTaxAmount,
        deductibleExpenseAmount: invoice.deductibleExpenseAmount,
        paymentDate: invoice.paymentDate ?
            new Date(invoice.paymentDate) :
            null,
        recordSource: "RECEIVED_INVOICE",
        sourceId: invoice.receptionNumber,
        schemaVersion: MODULE_VERSION,
        integrityAlgorithmVersion: "HMAC_SHA256_V1",
        previousHash: null,
        entryHash: null,
        entrySignature: null,
        traceId,
        registeredAt: now,
        operationTimeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
        _createdDate: now,
    };

    const savedHeader = await wixData.insert(
        COLLECTIONS.ASIENTOS_CONTABLES,
        asiento, { suppressAuth: true }
    );

    const lines = _buildAccountingLines(
        invoice,
        journalEntryId,
        traceId
    );

    for (const line of lines) {
        await _insertAccountingLine(line);
    }

    return {
        item: savedHeader,
        idempotent: false,
        lineCount: lines.length,
    };
}

export const registerReceivedInvoice = webMethod(
    Permissions.SiteMember,
    async (payload = {}) => {
        const traceId =
            payload.traceId || makeTraceId("received-invoice");

        try {
            await requireAdmin(traceId);

            const receptionNumber = _safeTrim(
                payload.receptionNumber
            );
            const supplierInvoiceSeriesNumber = _safeTrim(
                payload.supplierInvoiceSeriesNumber
            );
            const supplierTaxId = _safeTrim(
                payload.supplierTaxId
            ).toUpperCase();
            const supplierName = _safeTrim(payload.supplierName);

            if (!receptionNumber) {
                return _error(
                    "INVALID_RECEPTION_NUMBER",
                    "receptionNumber requerido"
                );
            }

            if (!supplierInvoiceSeriesNumber) {
                return _error(
                    "INVALID_INVOICE_NUMBER",
                    "supplierInvoiceSeriesNumber requerido"
                );
            }

            if (!_isValidNIF(supplierTaxId)) {
                return _error(
                    "INVALID_SUPPLIER_TAX_ID",
                    "NIF del proveedor invalido"
                );
            }

            if (!supplierName) {
                return _error(
                    "INVALID_SUPPLIER_NAME",
                    "Nombre del proveedor requerido"
                );
            }

            const existing = await _getExistingEntry(
                receptionNumber
            );

            if (existing) {
                return {
                    status: "SUCCESS",
                    data: existing,
                    error: null,
                    idempotent: true,
                };
            }

            const issueDate = _readDate(payload.issueDate);
            const receptionDate =
                _readDate(payload.receptionDate) || issueDate;
            const paymentDate =
                _readDate(payload.paymentDate) || null;
            const totalInvoiceAmount = _readPositiveAmount(
                payload.totalInvoiceAmount
            );
            const taxRate = Number(payload.taxRate);

            if (!issueDate || !receptionDate) {
                return _error(
                    "INVALID_DATE",
                    "issueDate o receptionDate invalida"
                );
            }

            if (!totalInvoiceAmount) {
                return _error(
                    "INVALID_AMOUNT",
                    "totalInvoiceAmount positivo requerido"
                );
            }

            if (![0, 0.04, 0.1, 0.21].includes(taxRate)) {
                return _error(
                    "INVALID_TAX_RATE",
                    "taxRate debe ser 0, 0.04, 0.1 o 0.21"
                );
            }

            const taxableAmount = _roundMoney(
                totalInvoiceAmount / (1 + taxRate)
            );
            const inputTaxAmount = _roundMoney(
                totalInvoiceAmount - taxableAmount
            );
            const deductibleTaxAmount =
                payload.deductibleTaxAmount !== undefined ?
                _roundMoney(payload.deductibleTaxAmount) :
                inputTaxAmount;
            const deductibleExpenseAmount =
                payload.deductibleExpenseAmount !== undefined ?
                _roundMoney(payload.deductibleExpenseAmount) :
                taxableAmount;

            if (
                deductibleTaxAmount < 0 ||
                deductibleTaxAmount > inputTaxAmount
            ) {
                return _error(
                    "INVALID_DEDUCTIBLE_TAX",
                    "deductibleTaxAmount invalido"
                );
            }

            if (
                deductibleExpenseAmount < 0 ||
                deductibleExpenseAmount > taxableAmount
            ) {
                return _error(
                    "INVALID_DEDUCTIBLE_EXPENSE",
                    "deductibleExpenseAmount invalido"
                );
            }

            const paymentMethod =
                _safeTrim(payload.paymentMethod).toUpperCase() ||
                FORMA_PAGO.EFECTIVO;
            const fiscalYear = Number(issueDate.slice(0, 4));
            const fiscalPeriod = issueDate.slice(0, 7);
            const expenseConcept =
                _safeTrim(payload.expenseConcept) || "Gasto";
            const transactionId = `INV_REC-${receptionNumber}`;

            const invoice = {
                receptionNumber,
                supplierInvoiceSeriesNumber,
                supplierTaxId,
                supplierName,
                issueDate,
                receptionDate,
                paymentDate,
                paymentMethod,
                fiscalYear,
                fiscalPeriod,
                totalInvoiceAmount,
                taxableAmount,
                taxRate,
                inputTaxAmount,
                deductibleTaxAmount,
                deductibleExpenseAmount,
                expenseConcept,
                transactionId,
            };

            const accountingResult =
                await _generateExpenseAccountingEntry(
                    invoice,
                    traceId
                );

            if (
                paymentDate &&
                paymentMethod !== "PENDIENTE" &&
                !accountingResult.idempotent
            ) {
                await registerManualTransaction({
                    amount: totalInvoiceAmount,
                    paymentMethod,
                    tipoMovimiento: TIPO_MOVIMIENTO.PAGO_PROVEEDOR,
                    concept: `Pago factura proveedor ${supplierName} - ${supplierInvoiceSeriesNumber}`,
                    resourceId: "CAJA_LOCAL",
                    traceId,
                    transactionId,
                    origen: "RECEIVED_INVOICE_PAYMENT",
                });
            }

            await logAuditEvent(
                "RECEIVED_INVOICE_REGISTERED",
                "INFO",
                `Factura recibida registrada: ${receptionNumber}`, {
                    receptionNumber,
                    supplierTaxId,
                    totalInvoiceAmount,
                    movementType: "GASTO_PROVEEDOR",
                    traceId,
                },
                traceId,
                receptionNumber,
                "backend/facturasRecibidas.web.js"
            );

            return {
                status: "SUCCESS",
                data: accountingResult.item,
                error: null,
                idempotent: accountingResult.idempotent,
                lineCount: accountingResult.lineCount || 0,
            };
        } catch (error) {
            const normalized = normalizeError(error);

            log.error("registerReceivedInvoice failed", {
                traceId,
                code: normalized.code,
                error: normalized.message,
            });

            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(
                    error,
                    "RECEIVED_INVOICE_FAIL"
                ),
            };
        }
    }
);

export const listReceivedInvoices = webMethod(
    Permissions.SiteMember,
    async (options = {}) => {
        const traceId =
            options.traceId || makeTraceId("list-rec-inv");

        try {
            await requireCajero(traceId);

            const fiscalYear = Number(options.fiscalYear);
            const fiscalPeriod = _safeTrim(options.fiscalPeriod);
            const supplierTaxId = _safeTrim(
                options.supplierTaxId
            ).toUpperCase();

            let query = wixData
                .query(COLLECTIONS.ASIENTOS_CONTABLES)
                .eq("entryType", "GASTO_PROVEEDOR");

            if (fiscalYear) {
                query = query.eq("fiscalYear", fiscalYear);
            }

            if (fiscalPeriod) {
                query = query.eq("fiscalPeriod", fiscalPeriod);
            }

            if (supplierTaxId) {
                query = query.eq("supplierTaxId", supplierTaxId);
            }

            const result = await query
                .descending("operationDate")
                .limit(Math.min(Number(options.limit) || 50, 200))
                .find({ suppressAuth: true });

            return {
                status: "SUCCESS",
                data: {
                    invoices: result.items || [],
                    total: result.items?.length || 0,
                },
                error: null,
            };
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(
                    error,
                    "LIST_REC_INV_FAIL"
                ),
            };
        }
    }
);