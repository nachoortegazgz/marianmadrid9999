/*
=============================================================================
MODULE: backend/eventLog.js
VERSION: v5009-FISCAL
BASE: v5008.5 + SSOT v5009 + DOSSIER CAJA + CONSOLIDACION v2
RESPONSIBILITY: Motor atomico de registro fiscal (append-only) + proyector
                secundario + API fiscal completa (ventas, compras, consultas).
STANDARDS: G10 ASCII Strict.

REGLAS DE DISENO (decision tecnica consolidada):
  - eventLog.js es el UNICO escritor de MovimientosCaja (append-only).
  - Reutiliza hashSHA256 / hashChain de backend/securityEngine.
  - Reutiliza _lockSlotKeyOrFail / _unlockSlotKey de bookingCore para la
    secuencia global (mismo lock que cajas.web.js v5009).
  - Reutiliza _formatAEATDateTimeMadrid (formato identico a v5008.5) para
    preservar la integridad de la cadena ya existente.
  - Dual write: escribe campos AEAT (numSerieFactura, huella, ...) Y campos
    legacy (invoiceNumber, currentRecordHash, ...) con el MISMO valor. La
    cadena se lee desde legacy para no romper verifyFiscalHashChainIntegrity.
  - Delega proyeccion contable en contabilidad.projectLedgerMovementToAccounting.
  - Delega proyeccion stock en inventario.web.recordInventoryMovementSafe
    (import dinamico para evitar ciclos).
  - Absorbe facturasRecibidas.web.js (Seccion 4). Sin modulo separado.

FIXES APLICADOS v5009:
  - FIX-EV-01: secuencia global reutiliza lock de bookingCore.
  - FIX-EV-02: payload AEAT identico al de cajas.web.js v5008.5.
  - FIX-EV-03: dual write (AEAT + legacy) con mismo valor.
  - FIX-EV-04: proyeccion contable delega en contabilidad.js.
  - FIX-EV-05: proyeccion stock delega en inventario.web.js (import dinamico).
  - FIX-EV-06: reconciliarProyecciones idempotente y silenciosa.
  - FIX-EV-07: errores de proyeccion NUNCA propagan al caller del motor.
  - FIX-EV-08: absorbe API de compras (registrar/get/listar/actualizar).
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";

import {
    COLLECTIONS,
    SINGLETONS,
    SDK_CONFIG,
    TIPO_MOVIMIENTO,
    FORMA_PAGO,
    IVA_RATES,
    CONCURRENCY,
    CLAVES_AEAT,
    MOTIVOS_RECTIFICACION,
    ESTADO_DEVENGO_IVA,
    ROL_FISCAL,
    TIPO_EVENTO,
    TIPO_TERCERO,
    PROYECCION_ESTADO,
    SISTEMA_INFORMATICO,
} from "backend/internalConfig";

import {
    hashSHA256,
    hashChain,
} from "backend/securityEngine";

import {
    makeTraceId,
    _safeTrim,
    _cleanText,
    _looksLikeGuid,
    _roundMoney,
    withTimeout,
} from "public/mmUtils";

import {
    _lockSlotKeyOrFail,
    _unlockSlotKey,
} from "backend/booking/bookingCore";

import { logger } from "backend/logger";

const log = logger;

// ============================================================================
// CONSTANTES
// ============================================================================

const CAJA_ACTUAL_ID = SINGLETONS?.CAJA || "CAJA_PRINCIPAL";
const CAJA_SEQ_ID = "CAJA_SEQ";
const LEDGER_SCHEMA_VERSION = "LEDGER_V5_FISCAL";
const GENESIS_HASH = "0".repeat(64);

const SEQUENCE_MUTEX_KEY = "FISCAL_SEQUENCE_LOCK";
const SEQUENCE_MUTEX_TTL_MS = Number(CONCURRENCY?.LEDGER_MUTEX_TTL_MS) || 45000;

const PROYECCION_BATCH_LIMIT = 25;
const PROYECCION_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

const ESTADOS_PAGO_FACTURA = Object.freeze(["PENDIENTE", "PAGADO", "PARCIAL"]);

// ============================================================================
// SECCION 1 - HELPERS DE FECHA / AEAT
// ============================================================================

function _formatAEATDate(ymd) {
    const clean = _safeTrim(ymd);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
    if (!match) return clean;
    return `${match[3]}-${match[2]}-${match[1]}`;
}

function _formatAEATDateTimeMadrid(date) {
    const dt = date instanceof Date ? date : new Date();
    const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
    }).formatToParts(dt).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

    const madridOffset = (() => {
        const madridStr = dt.toLocaleString("en-US", {
            timeZone: "Europe/Madrid",
            timeZoneName: "longOffset",
        });
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

function _buildGenerationTimestamp(date) {
    const dt = date instanceof Date ? date : new Date();
    const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
    }).formatToParts(dt).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
    };
}

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

// [FIX-EV-02] Payload AEAT identico al de cajas.web.js v5008.5.
// Acepta nomenclatura AEAT o legacy indistintamente.
function _buildAEATPayload(mov, generatedAt) {
    const nifDest = _safeTrim(mov.recipientTaxId || mov.nifTercero);
    const nombreDest = _safeTrim(mov.recipientLegalName || mov.razonSocialTercero);
    const numSerie = _safeTrim(mov.invoiceNumber || mov.invoiceNumber);
    const fechaExp = _safeTrim(mov.invoiceIssueDate || mov.operationDate);
    const tipoFactura = _safeTrim(mov.invoiceType || mov.claveRegistroFactura) || CLAVES_AEAT.F1;
    const cuotaTotal = Number(mov.taxAmount ?? mov.taxAmount ?? 0);
    const importeTotal = Number(mov.totalAmount ?? mov.totalAmount ?? 0);
    const huellaAnterior = _safeTrim(mov.previousRecordHash || mov.previousRecordHash);
    const nifEmisor = _safeTrim(mov.issuerTaxId || mov.businessTaxId);
    const tipoRect = _safeTrim(mov.correctionType);
    const idFactAnt = _safeTrim(mov.previousInvoiceId || mov.idFacturaRectificada);
    const motivoRect = _safeTrim(mov.correctionReason);
    const estadoDevengo = _safeTrim(mov.estadoDevengoIVA || mov.estadoDevengoIva);
    const idAnticipo = _safeTrim(mov.idAnticipoVinculado);
    const importeRet = Number(mov.irpfWithholdingAmount || 0);
    const baseRet = Number(mov.withholdingBase || 0);
    const rolFiscal = _safeTrim(mov.rolFiscal);
    const importeRE = Number(mov.surchargeAmount ?? mov.importeRecargoEquivalencia ?? 0);
    const refBancaria = _safeTrim(mov.referenciaBancariaConciliacion);

    const fields = [
        ["IDEmisorFactura", nifEmisor || ""],
        ["NumSerieFactura", numSerie || ""],
        ["FechaExpedicionFactura", _formatAEATDate(fechaExp)],
        ["TipoFactura", tipoFactura],
        ["CuotaTotal", String(cuotaTotal.toFixed(2))],
        ["ImporteTotal", String(importeTotal.toFixed(2))],
        ["Huella", huellaAnterior || ""],
        ["FechaHoraHusoGenRegistro", _formatAEATDateTimeMadrid(generatedAt)],
    ];

    if (nifDest) fields.push(["NIFDestinatario", nifDest.slice(0, 20)]);
    if (nombreDest) fields.push(["NombreRazonDestinatario", nombreDest.slice(0, 200)]);
    if (refBancaria) fields.push(["ReferenciaBancaria", refBancaria.slice(0, 60)]);

    if (estadoDevengo === ESTADO_DEVENGO_IVA.APLICACION_ANTICIPO) {
        fields.push(["TipoRectificativa", "I"]);
        if (idAnticipo) fields.push(["IdAnticipoVinculado", idAnticipo.slice(0, 120)]);
    }

    if (tipoRect) fields.push(["TipoRectificativa", tipoRect.slice(0, 4)]);
    if (importeRet > 0) {
        fields.push(["ImporteRetencionIRPF", String(importeRet.toFixed(2))]);
        if (baseRet > 0) fields.push(["BaseImponibleRetencion", String(baseRet.toFixed(2))]);
        if (rolFiscal) fields.push(["RolFiscal", rolFiscal.slice(0, 10)]);
    }

    if (importeRE > 0) fields.push(["ImporteRecargoEquivalencia", String(importeRE.toFixed(2))]);
    if (motivoRect) fields.push(["MotivoRectificacion", motivoRect.slice(0, 4)]);
    if (idFactAnt) fields.push(["IdFacturaRectificada", idFactAnt.slice(0, 120)]);

    return fields.map(([k, v]) => `${k}=${v}`).join("&");
}

// ============================================================================
// SECCION 2 - SECUENCIA GLOBAL Y ULTIMO EVENTO
// ============================================================================

// [FIX-EV-01] Lock compartido con cajas.web.js
export async function _getNextSequenceInternal(traceId) {
    const lockOwnerId = `seq_${traceId || makeTraceId("seq")}`;

    const lockResult = await _lockSlotKeyOrFail(
        SEQUENCE_MUTEX_KEY,
        lockOwnerId,
        SEQUENCE_MUTEX_TTL_MS
    );
    if (!lockResult?.ok) {
        throw new Error("SEQUENCE_LOCK_BUSY: No se pudo adquirir el lock de secuencia");
    }

    try {
        let seqDoc = await wixData
            .get(COLLECTIONS.CAJA_ACTUAL, CAJA_SEQ_ID, { suppressAuth: true, consistentRead: true })
            .catch(() => null);

        if (!seqDoc) {
            const legacyCaja = await wixData
                .get(COLLECTIONS.CAJA_ACTUAL, CAJA_ACTUAL_ID, { suppressAuth: true, consistentRead: true })
                .catch(() => null);

            const legacyCounters =
                legacyCaja && legacyCaja.sequenceCounters
                    ? legacyCaja.sequenceCounters
                    : { seqGlobal: 0 };

            seqDoc = {
                _id: CAJA_SEQ_ID,
                sequenceCounters: { ...legacyCounters },
                migratedFrom: CAJA_ACTUAL_ID,
                migratedAt: new Date(),
                _createdDate: new Date(),
                _updatedDate: new Date(),
            };

            await wixData
                .insert(COLLECTIONS.CAJA_ACTUAL, seqDoc, { suppressAuth: true })
                .catch(async (insertErr) => {
                    const msg = String(insertErr?.message || "");
                    if (msg.includes("WDE0123") || msg.includes("WD_ITEM_ALREADY_EXISTS") || msg.includes("Duplicated")) {
                        seqDoc = await wixData
                            .get(COLLECTIONS.CAJA_ACTUAL, CAJA_SEQ_ID, { suppressAuth: true, consistentRead: true })
                            .catch(() => null);
                        if (!seqDoc) throw insertErr;
                    } else {
                        throw insertErr;
                    }
                });
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

async function _getUltimoEventoCaja() {
    const res = await wixData
        .query(COLLECTIONS.MOVIMIENTOS_CAJA)
        .descending("sequenceNumber")
        .limit(1)
        .find({ suppressAuth: true, consistentRead: true });
    return res?.items?.[0] || null;
}

// ============================================================================
// SECCION 3 - MAESTROS
// ============================================================================

async function _upsertDatosFiscales({ nifCif, razonSocial, tipoTercero, datosContacto }, traceId) {
    const nif = _safeTrim(nifCif).toUpperCase();
    if (!nif) return null;

    const existing = await wixData
        .query(COLLECTIONS.DATOS_FISCALES)
        .eq('taxId', nif)
        .limit(1)
        .find({ suppressAuth: true });

    if (existing?.items?.[0]) return existing.items[0];

    return await wixData.insert(COLLECTIONS.DATOS_FISCALES, {
        nifCif: nif,
        razonSocial: _safeTrim(razonSocial).toUpperCase() || "SIN NOMBRE",
        tipoTercero: tipoTercero || TIPO_TERCERO.CLIENTE,
        datosContacto: datosContacto || null,
        activo: true,
        traceIdAlta: traceId,
        _createdDate: new Date(),
        _updatedDate: new Date(),
    }, { suppressAuth: true });
}

async function _getServicioCatalogo(catalogId, traceId) {
    const id = _safeTrim(catalogId);
    if (!_looksLikeGuid(id)) return null;
    try {
        return await wixData.get(COLLECTIONS.SERVICIOS_CATALOGO, id, { suppressAuth: true });
    } catch (_) {
        log.warn("Catalogo no encontrado", { traceId, catalogId: id });
        return null;
    }
}

// ============================================================================
// SECCION 4 - PAYLOAD FISCAL (snapshot inmutable guardado en el doc)
// ============================================================================

function _buildPayloadFiscalSnapshot({
    tercero, catalogo, input, ts, huellaAnterior, huellaActual, fechaHoraHusoGenRegistro,
}) {
    return {
        idEmisorFactura: _safeTrim(input.issuerTaxId || input.businessTaxId),
        nombreRazonEmisor: _safeTrim(input.issuerLegalName),
        nifDestinatario: _safeTrim(tercero?.taxId || input.recipientTaxId || input.nifTercero),
        nombreRazonDestinatario: _safeTrim(tercero?.legalName || input.recipientLegalName || input.razonSocialTercero),
        domicilioDestinatario: tercero?.contactData || input.recipientAddress || null,
        emitidaPorTerceroODestinatario: _safeTrim(input.issuedByThirdPartyOrRecipient) || "E",
        nombreRazonTercero: _safeTrim(input.thirdPartyLegalName) || null,
        nifTerceroExpedidor: _safeTrim(input.issuerThirdPartyTaxId) || null,
        numSerieFactura: _safeTrim(input.invoiceNumber || input.invoiceNumber),
        fechaExpedicionFactura: _safeTrim(input.invoiceIssueDate || input.operationDate),
        fechaOperacion: _safeTrim(input.operationDate) || null,
        tipoFactura: _safeTrim(input.invoiceType || input.claveRegistroFactura) || "F1",
        tipoRectificativa: _safeTrim(input.correctionType) || null,
        descripcionOperacion: _safeTrim(input.operationDescription || input.concept),
        importeTotal: Number(input.totalAmount ?? input.totalAmount ?? 0),
        baseImponibleOImporteNoSujeto: Number(input.taxableBaseOrNonSubjectAmount ?? input.taxableAmount ?? 0),
        cuotaTotal: Number(input.taxAmount ?? input.taxAmount ?? 0),
        tipoImpositivo: Number(input.taxRate ?? input.taxRate ?? catalogo?.taxRate ?? 0),
        tipoRecargoEquivalencia: Number(input.surchargeRate ?? 0),
        cuotaRecargoEquivalencia: Number(input.surchargeAmount ?? input.importeRecargoEquivalencia ?? 0),
        importeRetencionIRPF: Number(input.irpfWithholdingAmount ?? 0),
        tipoRetencionIRPF: Number(input.irpfWithholdingRate ?? 0),
        baseImponibleRetencion: Number(input.withholdingBase ?? 0),
        claveRegimen: _safeTrim(input.regimeKey || catalogo?.aeatRegimeKey) || "01",
        calificacionOperacion: _safeTrim(input.operationClassification || catalogo?.aeatOperationClassification) || "S1",
        operacionExenta: _safeTrim(input.exemptOperation || catalogo?.aeatExemptOperation) || null,
        inversionSujetoPasivo: input.reverseCharge === true || catalogo?.reverseCharge === true,
        causaNoSujeta: _safeTrim(input.nonSubjectReason) || null,
        regimenEspecialCriterioCaja: input.cashBasisRegime === true,
        exentaPorArticulo20: input.article20Exempt === true,
        sistemaInformatico: { ...SISTEMA_INFORMATICO },
        idFacturaAnterior: _safeTrim(input.previousInvoiceId) || null,
        numSerieFacturaAnterior: _safeTrim(input.previousInvoiceNumber) || null,
        fechaExpedicionFacturaAnterior: _safeTrim(input.previousInvoiceIssueDate) || null,
        huellaAnterior: huellaAnterior || null,
        huella: huellaActual,
        fechaHoraHusoGenRegistro,
        generationTimestamp: _buildGenerationTimestamp(ts),
        desgloseDetallado: Array.isArray(input.desglose) ? input.desglose : [],
    };
}

// ============================================================================
// SECCION 5 - MOTOR — registrarEventoEconomico
// ============================================================================

export async function registrarEventoEconomico(input) {
    const traceId = input.traceId || makeTraceId("evento");
    const ts = new Date();

    // 1. Resolver tercero
    const tercero = await _upsertDatosFiscales({
        nifCif: input.recipientTaxId || input.nifTercero || input.issuerTaxId,
        razonSocial: input.recipientLegalName || input.razonSocialTercero || input.issuerLegalName,
        tipoTercero: input.thirdPartyType || TIPO_TERCERO.CLIENTE,
        datosContacto: input.contactData || input.recipientAddress || null,
    }, traceId);

    // 2. Resolver catalogo
    const catalogo = await _getServicioCatalogo(input.catalogId, traceId);

    // 3. Ultimo evento + secuencia
    const anterior = await _getUltimoEventoCaja();
    const seq = await _getNextSequenceInternal(traceId);

    const huellaAnterior = _safeTrim(anterior?.recordHash || anterior?.currentRecordHash) || GENESIS_HASH;
    const fechaHoraHusoGenRegistro = _formatAEATDateTimeMadrid(ts);

    // 4. Construir movimiento base (aun sin huella)
    const movBase = {
        sequenceNumber: seq.sequenceNumber,
        numSerieFactura: _safeTrim(input.invoiceNumber || input.invoiceNumber) || seq.invoiceNumber,
        invoiceNumber: _safeTrim(input.invoiceNumber || input.invoiceNumber) || seq.invoiceNumber,
        fechaExpedicionFactura: _safeTrim(input.invoiceIssueDate || input.operationDate) ||
            new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" }),
        operationDate: _safeTrim(input.invoiceIssueDate || input.operationDate) ||
            new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" }),
        fechaOperacion: _safeTrim(input.operationDate) || null,
        fiscalPeriod: (_safeTrim(input.invoiceIssueDate || input.operationDate) ||
            new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" })).slice(0, 7),

        tipoMovimiento: _safeTrim(input.movementType || input.movementType),
        movementType: _safeTrim(input.movementType || input.movementType),
        tipoEvento: _safeTrim(input.eventType),

        paymentMethod: _safeTrim(input.paymentMethod),
        channelType: _safeTrim(input.channelType) || "POS",

        importeTotal: Number(input.totalAmount ?? input.totalAmount ?? 0),
        totalAmount: Number(input.totalAmount ?? input.totalAmount ?? 0),
        baseImponibleOImporteNoSujeto: Number(input.taxableBaseOrNonSubjectAmount ?? input.taxableAmount ?? 0),
        taxableAmount: Number(input.taxableBaseOrNonSubjectAmount ?? input.taxableAmount ?? 0),
        cuotaTotal: Number(input.taxAmount ?? input.taxAmount ?? 0),
        taxAmount: Number(input.taxAmount ?? input.taxAmount ?? 0),
        tipoImpositivo: Number(input.taxRate ?? input.taxRate ?? IVA_RATES.GENERAL),
        taxRate: Number(input.taxRate ?? input.taxRate ?? IVA_RATES.GENERAL),
        tipoRecargoEquivalencia: Number(input.surchargeRate ?? 0),
        cuotaRecargoEquivalencia: Number(input.surchargeAmount ?? input.importeRecargoEquivalencia ?? 0),
        importeRecargoEquivalencia: Number(input.surchargeAmount ?? input.importeRecargoEquivalencia ?? 0),
        importeRetencionIRPF: Number(input.irpfWithholdingAmount ?? 0),
        tipoRetencionIRPF: Number(input.irpfWithholdingRate ?? 0),
        baseImponibleRetencion: Number(input.withholdingBase ?? 0),
        rolFiscal: _safeTrim(input.rolFiscal) || ROL_FISCAL.EMISOR,

        descripcionOperacion: _cleanText(input.operationDescription || input.concept || "", 500),
        concept: _cleanText(input.operationDescription || input.concept || "", 500),

        tipoFactura: _safeTrim(input.invoiceType || input.claveRegistroFactura) || CLAVES_AEAT.F1,
        claveRegistroFactura: _safeTrim(input.invoiceType || input.claveRegistroFactura) || CLAVES_AEAT.F1,
        tipoRectificativa: _safeTrim(input.correctionType) || null,
        motivoRectificacion: _safeTrim(input.correctionReason) || null,
        idFacturaAnterior: _safeTrim(input.previousInvoiceId || input.idFacturaRectificada) || null,
        idFacturaRectificada: _safeTrim(input.previousInvoiceId || input.idFacturaRectificada) || null,
        numSerieFacturaAnterior: _safeTrim(input.previousInvoiceNumber) || null,
        fechaExpedicionFacturaAnterior: _safeTrim(input.previousInvoiceIssueDate) || null,

        nifEmisor: _safeTrim(input.issuerTaxId || input.businessTaxId),
        businessTaxId: _safeTrim(input.issuerTaxId || input.businessTaxId),
        nombreRazonEmisor: _safeTrim(input.issuerLegalName),
        nifDestinatario: _safeTrim(tercero?.taxId || input.recipientTaxId || input.nifTercero),
        nifTercero: _safeTrim(tercero?.taxId || input.recipientTaxId || input.nifTercero),
        nombreRazonDestinatario: _safeTrim(tercero?.legalName || input.recipientLegalName || input.razonSocialTercero),
        razonSocialTercero: _safeTrim(tercero?.legalName || input.recipientLegalName || input.razonSocialTercero),
        domicilioDestinatario: tercero?.contactData || input.recipientAddress || null,
        esB2B: input.esB2B === true,

        emitidaPorTerceroODestinatario: _safeTrim(input.issuedByThirdPartyOrRecipient) || "E",
        nombreRazonTercero: _safeTrim(input.thirdPartyLegalName) || null,
        nifTerceroExpedidor: _safeTrim(input.issuerThirdPartyTaxId) || null,
        causaNoSujeta: _safeTrim(input.nonSubjectReason) || null,
        inversionSujetoPasivo: input.reverseCharge === true || catalogo?.reverseCharge === true,

        claveRegimen: _safeTrim(input.regimeKey || catalogo?.aeatRegimeKey) || "01",
        calificacionOperacion: _safeTrim(input.operationClassification || catalogo?.aeatOperationClassification) || "S1",
        operacionExenta: _safeTrim(input.exemptOperation || catalogo?.aeatExemptOperation) || null,
        regimenEspecialCriterioCaja: input.cashBasisRegime === true,
        exentaPorArticulo20: input.article20Exempt === true,

        idAnticipoVinculado: _safeTrim(input.idAnticipoVinculado) || null,
        estadoDevengoIVA: _safeTrim(input.estadoDevengoIVA) || ESTADO_DEVENGO_IVA.DEVENGADO,
        referenciaBancariaConciliacion: _safeTrim(input.referenciaBancariaConciliacion) || null,
        numeroSerieFacturaEmisor: _safeTrim(input.numeroSerieFacturaEmisor) || null,

        resourceId: _safeTrim(input.resourceId) || null,
        staffResourceId: _safeTrim(input.staffResourceId) || null,
        reservaIdVinculada: _safeTrim(input.linkedBookingIds) || null,
        transactionId: _safeTrim(input.transactionId) || `TX_${seq.sequenceNumber}`,
        orderId: _safeTrim(input.orderId) || null,
        refundId: _safeTrim(input.refundId) || null,
        pairToken: _safeTrim(input.pairToken) || null,

        thirdPartyId: tercero?._id || null,
        catalogId: catalogo?._id || null,

        schemaIntegrityVersion: LEDGER_SCHEMA_VERSION,
        schemaVersion: LEDGER_SCHEMA_VERSION,
        recordSource: _safeTrim(input.recordSource || input.origen) || "INTERNAL",
        lineItems: Array.isArray(input.lineItems) ? input.lineItems : [],
    };

    // 5. AEAT payload + huella
    const aeatPayload = _buildAEATPayload({ ...movBase, previousRecordHash: huellaAnterior }, ts);
    const huellaActual = await hashChain(huellaAnterior, aeatPayload);

    // 6. Snapshot inmutable
    const payloadFiscal = _buildPayloadFiscalSnapshot({
        tercero, catalogo, input, ts,
        huellaAnterior, huellaActual,
        fechaHoraHusoGenRegistro,
    });

    // 7. Doc cabecera (dual write)
    const doc = {
        ...movBase,
        huella: huellaActual,
        huellaAnterior,
        currentRecordHash: huellaActual,
        previousRecordHash: huellaAnterior,
        fechaHoraHusoGenRegistro,
        generationTimestamp: _buildGenerationTimestamp(ts),
        desgloseDetallado: payloadFiscal.detailedBreakdown,
        sistemaInformatico: payloadFiscal.computerSystem,
        payloadFiscal,
        proyeccionEstado: PROYECCION_ESTADO.PENDIENTE,
        proyeccionDetalleIds: [],
        traceId,
        registeredAt: ts,
        _createdDate: new Date(),
    };

    const cabecera = await wixData.insert(COLLECTIONS.MOVIMIENTOS_CAJA, doc, { suppressAuth: true });

    // 8. Detalle (lineas)
    const detalleIds = [];
    const desglose = Array.isArray(input.desglose) ? input.desglose : [];
    for (let i = 0; i < desglose.length; i++) {
        const d = desglose[i];
        const lineHash = await hashSHA256(huellaActual + JSON.stringify(d));
        const det = await wixData.insert(COLLECTIONS.LIBRO_ASIENTOS_CONTABLES_DETALLE, {
            lineHash,
            baseImponibleOImporteNoSujeto: Number(d.taxableBaseOrNonSubjectAmount ?? d.base ?? 0),
            tipoImpositivo: Number(d.taxRate ?? d.tipo ?? 0),
            cuotaRepercutida: Number(d.chargedTaxAmount ?? d.cuota ?? 0),
            sourceEventId: cabecera._id,
            lineNumber: i + 1,
            thirdPartyId: tercero?._id || null,
            catalogId: catalogo?._id || null,
            descripcionOperacion: _cleanText(d.descripcion || input.operationDescription || input.concept || "", 500),
            unidades: Number(d.units || 1),
            magnitud: Number(d.magnitude || 1),
            importeNetoUnitario: Number(d.netUnitAmount ?? d.importeNeto ?? 0),
            codigoImpuesto: _safeTrim(d.taxCode || catalogo?.taxCode) || null,
            claveRegimen: _safeTrim(d.regimeKey || payloadFiscal.regimeKey),
            calificacionOperacion: _safeTrim(d.operationClassification || payloadFiscal.operationClassification),
            operacionExenta: _safeTrim(d.exemptOperation) || null,
            inversionSujetoPasivo: d.reverseCharge === true || payloadFiscal.reverseCharge,
            cuentaContable: _safeTrim(d.accountCode || catalogo?.incomeAccountCode) || null,
            tipoRecargoEquivalencia: Number(d.surchargeRate ?? d.tipoRE ?? 0),
            cuotaRecargoEquivalencia: Number(d.surchargeAmount ?? d.cuotaRE ?? 0),
            importeRetencionIRPF: Number(d.irpfWithholdingAmount || 0),
            tipoRetencionIRPF: Number(d.irpfWithholdingRate || 0),
            _createdDate: new Date(),
        }, { suppressAuth: true });
        detalleIds.push(det._id);
    }

    // 9. Proyeccion secundaria — NUNCA propaga errores al caller
    let proyeccionEstado = PROYECCION_ESTADO.OK;
    try {
        await _proyectarSegunTipoEvento(cabecera, detalleIds, traceId);
    } catch (err) {
        proyeccionEstado = PROYECCION_ESTADO.ERROR;
        log.error("Proyeccion secundaria fallo (no bloqueante)", {
            traceId,
            eventoId: cabecera._id,
            tipoEvento: cabecera.eventType,
            message: err?.message,
        });
    }

    return {
        status: proyeccionEstado === PROYECCION_ESTADO.OK ? "SUCCESS" : "PARTIAL",
        data: {
            cabeceraId: cabecera._id,
            detalleIds,
            huella: huellaActual,
            sequenceNumber: seq.sequenceNumber,
            numSerieFactura: doc.invoiceNumber,
            proyeccionEstado,
        },
        error: null,
    };
}

// ============================================================================
// SECCION 6 - PROYECCION SECUNDARIA
// ============================================================================

async function _proyectarSegunTipoEvento(cabecera, detalleIds, traceId) {
    switch (cabecera.eventType) {
        case TIPO_EVENTO.VENTA_LINEA:
        case TIPO_EVENTO.RECTIFICATIVA:
        case TIPO_EVENTO.AJUSTE:
            await _proyectarAsientoContable(cabecera, traceId);
            break;
        case TIPO_EVENTO.COMPRA_LINEA:
            await _proyectarFacturaRecibida(cabecera, traceId);
            break;
        case TIPO_EVENTO.MOV_STOCK:
            await _proyectarMovimientoInventario(cabecera, traceId);
            break;
        case TIPO_EVENTO.CIERRE_Z:
            await _proyectarCierreZ(cabecera, traceId);
            break;
        default:
            log.warn("Tipo evento sin proyeccion", { traceId, tipoEvento: cabecera.eventType });
    }
}

// [FIX-EV-04] Delega en contabilidad.js — sin duplicar logica
async function _proyectarAsientoContable(cabecera, traceId) {
    try {
        const { projectLedgerMovementToAccounting } = await import("backend/contabilidad");
        const res = await projectLedgerMovementToAccounting(cabecera);
        if (res?.status !== "SUCCESS" && res?.status !== "SKIPPED") {
            throw new Error(`contabilidad.js: ${res?.status || "UNKNOWN"}`);
        }
    } catch (err) {
        log.warn("Proyeccion contable fallo", { traceId, eventoId: cabecera._id, message: err?.message });
        throw err;
    }
}

async function _proyectarFacturaRecibida(cabecera, traceId) {
    const fechaRecepcion = new Date();
    const numeroRecepcion = `FR-${cabecera.sequenceNumber}`;
    try {
        await wixData.insert(COLLECTIONS.FACTURAS_RECIBIDAS, {
            numeroRecepcion,
            numSerieFactura: cabecera.invoiceNumber,
            fechaExpedicionFactura: cabecera.invoiceIssueDate,
            fechaOperacion: cabecera.operationDate,
            fechaRecepcion,
            fechaRegistroContable: fechaRecepcion,
            thirdPartyId: cabecera.thirdPartyId,
            issuerTaxId: cabecera.issuerTaxId,
            issuerLegalName: cabecera.issuerLegalName,
            recipientTaxId: cabecera.recipientTaxId,
            recipientLegalName: cabecera.recipientLegalName,
            invoiceType: cabecera.invoiceType,
            operationDescription: cabecera.operationDescription,
            totalAmount: cabecera.totalAmount,
            totalTaxableBase: cabecera.taxableBaseOrNonSubjectAmount,
            totalVatAmount: cabecera.taxAmount,
            surchargeAmount: cabecera.surchargeAmount,
            irpfWithholdingAmount: cabecera.irpfWithholdingAmount,
            irpfWithholdingRate: cabecera.irpfWithholdingRate,
            detailedBreakdown: cabecera.detailedBreakdown,
            regimeKey: cabecera.regimeKey,
            operationClassification: cabecera.operationClassification,
            exemptOperation: cabecera.exemptOperation,
            reverseCharge: cabecera.reverseCharge,
            deductible: true,
            deductionPercentage: 100,
            deductibleAmount: Number(cabecera.taxAmount || 0),
            paymentStatus: "PENDIENTE",
            sourceEventId: cabecera._id,
            receptionSource: "API",
            validationStatus: "PENDIENTE",
            traceId,
            _createdDate: new Date(),
            _updatedDate: new Date(),
        }, { suppressAuth: true });
    } catch (err) {
        const msg = String(err?.message || "");
        if (msg.includes("WDE0123") || msg.includes("Duplicated") || msg.includes("already exists")) {
            log.info("FacturaRecibida ya existe (idempotente)", { traceId, numeroRecepcion });
            return;
        }
        throw err;
    }
}

// [FIX-EV-05] import dinamico — evita ciclo estatico
async function _proyectarMovimientoInventario(cabecera, traceId) {
    try {
        const mod = await import("backend/inventario.web");
        const fn = mod?.recordInventoryMovementSafe;
        if (typeof fn !== "function") {
            log.warn("inventario.recordInventoryMovementSafe no disponible", { traceId });
            return;
        }
        await fn({
            wixProductId: cabecera.fiscalPayload?.wixProductId || null,
            sku: cabecera.fiscalPayload?.sku || null,
            orderId: cabecera.orderId || null,
            refundId: cabecera.fiscalPayload?.refundId || null,
            sourceEventId: cabecera._id,
            catalogId: cabecera.catalogId,
            magnitude: cabecera.fiscalPayload?.magnitude || 1,
            thirdPartyId: cabecera.thirdPartyId,
            traceId,
        });
    } catch (err) {
        log.warn("Proyeccion inventario fallo", { traceId, eventoId: cabecera._id, message: err?.message });
        throw err;
    }
}

async function _proyectarCierreZ(cabecera, traceId) {
    try {
        await wixData.insert(COLLECTIONS.HISTORICO_CIERRES_Z, {
            _id: `Z_${cabecera.invoiceIssueDate}`,
            operationDate: cabecera.invoiceIssueDate,
            saldosPorMetodo: cabecera.fiscalPayload?.balancesByMethod || {},
            sourceEventId: cabecera._id,
            desglosePorRegimen: cabecera.fiscalPayload?.breakdownByRegime || [],
            desglosePorTipoOperacion: cabecera.fiscalPayload?.breakdownByOperationType || [],
            desglosePorTipoImpositivo: cabecera.fiscalPayload?.breakdownByTaxRate || [],
            resumenVerifactu: cabecera.fiscalPayload?.verifactuSummary || {},
            estadoEnvioAeat: "PENDIENTE",
            traceId,
            _createdDate: new Date(),
        }, { suppressAuth: true });
    } catch (err) {
        const msg = String(err?.message || "");
        if (msg.includes("WDE0123") || msg.includes("Duplicated") || msg.includes("already exists")) {
            log.info("CierreZ ya existe (idempotente)", { traceId, fecha: cabecera.invoiceIssueDate });
            return;
        }
        throw err;
    }
}

// ============================================================================
// SECCION 7 - CONSULTAS DE EVENTOS
// ============================================================================

export const getEventoPorId = webMethod(
    Permissions.Admin,
    async (eventoId) => {
        const traceId = makeTraceId("get-evento");
        try {
            if (!_looksLikeGuid(eventoId)) {
                return { status: "ERROR", data: null, error: { code: "INVALID_ID" } };
            }
            const evento = await wixData
                .get(COLLECTIONS.MOVIMIENTOS_CAJA, eventoId, { suppressAuth: true })
                .catch(() => null);
            if (!evento) {
                return { status: "ERROR", data: null, error: { code: "NOT_FOUND" } };
            }
            const detalle = await wixData
                .query(COLLECTIONS.LIBRO_ASIENTOS_CONTABLES_DETALLE)
                .eq("sourceEventId", eventoId)
                .ascending("lineNumber")
                .find({ suppressAuth: true });
            return {
                status: "SUCCESS",
                data: { cabecera: evento, detalle: detalle.items || [] },
                error: null,
            };
        } catch (error) {
            log.error("getEventoPorId fallo", { traceId, message: error?.message });
            return { status: "ERROR", data: null, error: { code: "LOOKUP_FAILED" } };
        }
    }
);

// NOTA: verifyFiscalHashChainIntegrity sigue viviendo en cajas.web.js como
// webMethod Admin. eventLog.js NO duplica esa funcion.

// ============================================================================
// SECCION 8 - API DE COMPRAS (absorbe facturasRecibidas.web.js)
// ============================================================================

export const registrarFacturaRecibida = webMethod(
    Permissions.SiteMember,
    async (payload) => {
        const traceId = payload?.traceId || makeTraceId("fact-rec");
        try {
            // 1. Validacion minima
            const nifEmisor = _safeTrim(payload?.issuerTaxId).toUpperCase();
            if (!nifEmisor) {
                return {
                    status: "ERROR", data: null,
                    error: { code: "NIF_EMISOR_REQUERIDO", message: "nifEmisor obligatorio" },
                };
            }
            const numSerie = _safeTrim(payload?.invoiceNumber);
            if (!numSerie) {
                return {
                    status: "ERROR", data: null,
                    error: { code: "NUM_SERIE_REQUERIDO", message: "numSerieFactura obligatorio" },
                };
            }
            const importeTotal = Number(payload?.totalAmount) || 0;
            if (importeTotal <= 0) {
                return {
                    status: "ERROR", data: null,
                    error: { code: "IMPORTE_INVALIDO", message: "importeTotal > 0" },
                };
            }

            // 2. Idempotencia por numSerie + NIF emisor
            const existing = await wixData
                .query(COLLECTIONS.FACTURAS_RECIBIDAS)
                .eq('invoiceNumber', numSerie)
                .eq('issuerTaxId', nifEmisor)
                .limit(1)
                .find({ suppressAuth: true });
            if (existing?.items?.[0]) {
                return {
                    status: "SUCCESS",
                    data: existing.items[0],
                    error: null,
                    idempotent: true,
                };
            }

            // 3. Delegar en el motor
            const eventResult = await registrarEventoEconomico({
                tipoEvento: TIPO_EVENTO.COMPRA_LINEA,
                tipoMovimiento: TIPO_MOVIMIENTO.PAGO_PROVEEDOR,
                paymentMethod: _safeTrim(payload?.paymentMethod) || FORMA_PAGO.EFECTIVO,
                importeTotal,
                baseImponibleOImporteNoSujeto: Number(payload?.totalTaxableBase) || 0,
                cuotaTotal: Number(payload?.totalVatAmount) || 0,
                tipoImpositivo: Number(payload?.taxRate) || 21,
                tipoRecargoEquivalencia: Number(payload?.surchargeRate) || 0,
                cuotaRecargoEquivalencia: Number(payload?.surchargeAmount) || 0,
                importeRetencionIRPF: Number(payload?.irpfWithholdingAmount) || 0,
                tipoRetencionIRPF: Number(payload?.irpfWithholdingRate) || 0,
                descripcionOperacion: _cleanText(payload?.operationDescription || "", 500),
                numSerieFactura: numSerie,
                fechaExpedicionFactura: _safeTrim(payload?.invoiceIssueDate),
                fechaOperacion: _safeTrim(payload?.operationDate) || null,
                tipoFactura: _safeTrim(payload?.invoiceType) || CLAVES_AEAT.F1,
                nifEmisor: nifEmisor,
                nombreRazonEmisor: _safeTrim(payload?.issuerLegalName),
                nifDestinatario: _safeTrim(payload?.recipientTaxId),
                nombreRazonDestinatario: _safeTrim(payload?.recipientLegalName),
                claveRegimen: _safeTrim(payload?.regimeKey) || "01",
                calificacionOperacion: _safeTrim(payload?.operationClassification) || "S1",
                operacionExenta: _safeTrim(payload?.exemptOperation) || null,
                inversionSujetoPasivo: payload?.reverseCharge === true,
                desglose: Array.isArray(payload?.detailedBreakdown) ? payload.detailedBreakdown : [],
                traceId,
            });

            return eventResult;
        } catch (err) {
            log.error("registrarFacturaRecibida fallo", { traceId, message: err?.message });
            return {
                status: "ERROR", data: null,
                error: { code: "FACT_REC_FAIL", message: err?.message },
            };
        }
    }
);

export const getFacturaRecibida = webMethod(
    Permissions.Admin,
    async (facturaId) => {
        const traceId = makeTraceId("get-fact-rec");
        try {
            if (!_looksLikeGuid(facturaId)) {
                return { status: "ERROR", data: null, error: { code: "INVALID_ID" } };
            }
            const factura = await wixData
                .get(COLLECTIONS.FACTURAS_RECIBIDAS, facturaId, { suppressAuth: true })
                .catch(() => null);
            if (!factura) {
                return { status: "ERROR", data: null, error: { code: "NOT_FOUND" } };
            }
            return { status: "SUCCESS", data: factura, error: null };
        } catch (err) {
            log.error("getFacturaRecibida fallo", { traceId, message: err?.message });
            return { status: "ERROR", data: null, error: { code: "LOOKUP_FAILED" } };
        }
    }
);

export const listarFacturasRecibidas = webMethod(
    Permissions.Admin,
    async (filters = {}) => {
        const traceId = makeTraceId("list-fact-rec");
        try {
            let q = wixData.query(COLLECTIONS.FACTURAS_RECIBIDAS);
            if (filters?.paymentStatus) {
                q = q.eq('paymentStatus', _safeTrim(filters.paymentStatus).toUpperCase());
            }
            if (filters?.thirdPartyId && _looksLikeGuid(filters.thirdPartyId)) {
                q = q.eq("thirdPartyId", filters.thirdPartyId);
            }
            if (filters?.desde) {
                q = q.ge('invoiceIssueDate', filters.desde);
            }
            if (filters?.hasta) {
                q = q.le('invoiceIssueDate', filters.hasta);
            }
            const limit = Math.min(Number(filters?.limit) || 50, 200);
            const res = await q.descending('invoiceIssueDate').limit(limit)
                .find({ suppressAuth: true });
            return {
                status: "SUCCESS",
                data: { items: res.items || [], total: res.totalCount },
                error: null,
            };
        } catch (err) {
            log.error("listarFacturasRecibidas fallo", { traceId, message: err?.message });
            return { status: "ERROR", data: null, error: { code: "QUERY_FAILED" } };
        }
    }
);

export const actualizarEstadoPagoFactura = webMethod(
    Permissions.SiteMember,
    async (facturaId, nuevoEstado, meta = {}) => {
        const traceId = meta?.traceId || makeTraceId("upd-fact-rec");
        try {
            if (!_looksLikeGuid(facturaId)) {
                return { status: "ERROR", data: null, error: { code: "INVALID_ID" } };
            }
            const factura = await wixData
                .get(COLLECTIONS.FACTURAS_RECIBIDAS, facturaId, { suppressAuth: true })
                .catch(() => null);
            if (!factura) {
                return { status: "ERROR", data: null, error: { code: "NOT_FOUND" } };
            }
            const estado = _safeTrim(nuevoEstado).toUpperCase();
            if (!ESTADOS_PAGO_FACTURA.includes(estado)) {
                return {
                    status: "ERROR", data: null,
                    error: { code: "INVALID_ESTADO", message: `estado debe ser ${ESTADOS_PAGO_FACTURA.join("|")}` },
                };
            }
            await wixData.update(COLLECTIONS.FACTURAS_RECIBIDAS, {
                _id: facturaId,
                estadoPago: estado,
                fechaPago: estado === "PAGADO" ? new Date() : factura.paymentDate,
                medioPago: meta?.paymentMethod || factura.paymentMethod,
                _updatedDate: new Date(),
            }, { suppressAuth: true });
            return {
                status: "SUCCESS",
                data: { facturaId, estadoPago: estado },
                error: null,
            };
        } catch (err) {
            log.error("actualizarEstadoPagoFactura fallo", { traceId, message: err?.message });
            return { status: "ERROR", data: null, error: { code: "UPDATE_FAILED" } };
        }
    }
);

// ============================================================================
// SECCION 9 - RECONCILIACION (cron)
// ============================================================================

// [FIX-EV-06] Idempotente y silenciosa. Reprocesa eventos con proyeccionEstado
// PENDIENTE o ERROR. Como MovimientosCaja es append-only, no actualizamos el
// estado; la proyeccion se reintenta hasta exito y las proyecciones usan
// _id deterministico o catch de Duplicated para ser idempotentes.
export async function reconciliarProyecciones() {
    const traceId = makeTraceId("recon");
    let procesados = 0;
    let fallidos = 0;
    try {
        const pendientes = await wixData
            .query(COLLECTIONS.MOVIMIENTOS_CAJA)
            .ne('projectionStatus', PROYECCION_ESTADO.OK)
            .descending("sequenceNumber")
            .limit(PROYECCION_BATCH_LIMIT)
            .find({ suppressAuth: true });

        for (const evento of pendientes.items || []) {
            try {
                await withTimeout(
                    _proyectarSegunTipoEvento(evento, evento.projectionDetailIds || [], traceId),
                    PROYECCION_TIMEOUT_MS,
                    "reconciliarProyecciones"
                );
                procesados += 1;
            } catch (err) {
                fallidos += 1;
                log.warn("Reconciliacion fallo", {
                    traceId,
                    eventoId: evento._id,
                    message: err?.message,
                });
            }
        }

        return {
            status: "SUCCESS",
            data: { procesados, fallidos, total: pendientes.items?.length || 0 },
        };
    } catch (err) {
        log.error("reconciliarProyecciones fallo global", { traceId, message: err?.message });
        return {
            status: "ERROR",
            data: { procesados, fallidos },
            error: { code: "RECON_FAIL", message: err?.message },
        };
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
    // Motor
    registrarEventoEconomico,
    _getNextSequenceInternal,

    // Consultas
    getEventoPorId,
    reconciliarProyecciones,

    // API de compras
    registrarFacturaRecibida,
    getFacturaRecibida,
    listarFacturasRecibidas,
    actualizarEstadoPagoFactura,
};
