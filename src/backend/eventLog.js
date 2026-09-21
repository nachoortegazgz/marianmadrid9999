/*
=============================================================================
MODULE: backend/eventLog.js
VERSION: v5009-FISCAL
BASE: v5008.5 + SSOT v5009 + DOSSIER CAJA + CONSOLIDACION v1
RESPONSIBILITY: Motor atomico de registro fiscal (append-only). Cabecera +
                detalle + encadenamiento Verifactu + proyeccion secundaria.
STANDARDS: G10 ASCII Strict.

REGLAS DE DISENO (decision tecnica consolidada):
  - eventLog.js es el UNICO escritor de MovimientosCaja (append-only).
  - Reutiliza hashSHA256 / hashChain de backend/securityEngine.
  - Reutiliza _lockSlotKeyOrFail / _unlockSlotKey de bookingCore para la
    secuencia global (mismo lock que usa cajas.web.js v5008.5).
  - Reutiliza _formatAEATDateTimeMadrid (formato identico a v5008.5) para
    preservar la integridad de la cadena ya existente.
  - Mantiene DUAL WRITE durante transicion: escribe campos AEAT
    (numSerieFactura, huella, ...) Y campos legacy (invoiceNumber,
    currentRecordHash, ...) con el MISMO valor. La cadena se lee desde
    legacy para no romper verifyFiscalHashChainIntegrity existente.
  - Delega la proyeccion contable en contabilidad.projectLedgerMovementToAccounting
    y la de stock en inventario.web.recordInventoryMovementSafe.
  - NO duplica verifyFiscalHashChainIntegrity (vive en cajas.web.js como
    webMethod Admin).

FIXES APLICADOS v5009:
  - FIX-EV-01: secuencia global reutiliza el lock de bookingCore. Sin race
    entre cajas.web.js legacy y eventLog.js.
  - FIX-EV-02: payload AEAT identico al de cajas.web.js (key=value&key=value)
    para preservar la cadena SHA-256 existente.
  - FIX-EV-03: escribe AMBOS juegos de campos (AEAT + legacy) con el mismo
    valor (dual write).
  - FIX-EV-04: proyeccion contable delega en contabilidad.js. Sin logica
    duplicada.
  - FIX-EV-05: proyeccion de stock delega en inventario.web.js via import
    dinamico (evita ciclo estatico).
  - FIX-EV-06: reconciliarProyecciones es idempotente y silenciosa.
  - FIX-EV-07: errores de proyeccion NUNCA propagan al caller del motor.
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

// ============================================================================
// HELPERS DE FECHA / AEAT (identicos a cajas.web.js v5008.5)
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

// [FIX-EV-02] Payload AEAT identico al de cajas.web.js v5008.5
// para preservar la cadena SHA-256 existente. Los campos se aceptan en
// nomenclatura AEAT o legacy indistintamente.
function _buildAEATPayload(mov, generatedAt) {
    const nifDest = _safeTrim(mov.nifDestinatario || mov.nifTercero);
    const nombreDest = _safeTrim(mov.nombreRazonDestinatario || mov.razonSocialTercero);
    const numSerie = _safeTrim(mov.numSerieFactura || mov.invoiceNumber);
    const fechaExp = _safeTrim(mov.fechaExpedicionFactura || mov.operationDate);
    const tipoFactura = _safeTrim(mov.tipoFactura || mov.claveRegistroFactura) || CLAVES_AEAT.F1;
    const cuotaTotal = Number(mov.cuotaTotal ?? mov.taxAmount ?? 0);
    const importeTotal = Number(mov.importeTotal ?? mov.totalAmount ?? 0);
    const huellaAnterior = _safeTrim(mov.huellaAnterior || mov.previousRecordHash);
    const nifEmisor = _safeTrim(mov.nifEmisor || mov.businessTaxId);
    const tipoRect = _safeTrim(mov.tipoRectificativa);
    const idFactAnt = _safeTrim(mov.idFacturaAnterior || mov.idFacturaRectificada);
    const motivoRect = _safeTrim(mov.motivoRectificacion);
    const estadoDevengo = _safeTrim(mov.estadoDevengoIVA || mov.estadoDevengoIva);
    const idAnticipo = _safeTrim(mov.idAnticipoVinculado);
    const importeRet = Number(mov.importeRetencionIRPF || 0);
    const baseRet = Number(mov.baseImponibleRetencion || 0);
    const rolFiscal = _safeTrim(mov.rolFiscal);
    const importeRE = Number(mov.cuotaRecargoEquivalencia ?? mov.importeRecargoEquivalencia ?? 0);
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
// [FIX-EV-01] SECUENCIA GLOBAL — lock compartido con cajas.web.js
// ============================================================================

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
// MAESTROS
// ============================================================================

async function _upsertDatosFiscales({ nifCif, razonSocial, tipoTercero, datosContacto }, traceId) {
    const nif = _safeTrim(nifCif).toUpperCase();
    if (!nif) return null;

    const existing = await wixData
        .query(COLLECTIONS.DATOS_FISCALES)
        .eq("nifCif", nif)
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

async function _getServicioCatalogo(catalogoId, traceId) {
    const id = _safeTrim(catalogoId);
    if (!_looksLikeGuid(id)) return null;
    try {
        return await wixData.get(COLLECTIONS.SERVICIOS_CATALOGO, id, { suppressAuth: true });
    } catch (_) {
        log.warn("Catalogo no encontrado", { traceId, catalogoId: id });
        return null;
    }
}

// ============================================================================
// PAYLOAD FISCAL (snapshot inmutable guardado en el doc)
// ============================================================================

function _buildPayloadFiscalSnapshot({
    tercero, catalogo, input, ts, huellaAnterior, huellaActual, fechaHoraHusoGenRegistro,
}) {
    return {
        idEmisorFactura: _safeTrim(input.nifEmisor || input.businessTaxId),
        nombreRazonEmisor: _safeTrim(input.nombreRazonEmisor),
        nifDestinatario: _safeTrim(tercero?.nifCif || input.nifDestinatario || input.nifTercero),
        nombreRazonDestinatario: _safeTrim(tercero?.razonSocial || input.nombreRazonDestinatario || input.razonSocialTercero),
        domicilioDestinatario: tercero?.datosContacto || input.domicilioDestinatario || null,
        emitidaPorTerceroODestinatario: _safeTrim(input.emitidaPorTerceroODestinatario) || "E",
        nombreRazonTercero: _safeTrim(input.nombreRazonTercero) || null,
        nifTerceroExpedidor: _safeTrim(input.nifTerceroExpedidor) || null,
        numSerieFactura: _safeTrim(input.numSerieFactura || input.invoiceNumber),
        fechaExpedicionFactura: _safeTrim(input.fechaExpedicionFactura || input.operationDate),
        fechaOperacion: _safeTrim(input.fechaOperacion) || null,
        tipoFactura: _safeTrim(input.tipoFactura || input.claveRegistroFactura) || "F1",
        tipoRectificativa: _safeTrim(input.tipoRectificativa) || null,
        descripcionOperacion: _safeTrim(input.descripcionOperacion || input.concept),
        importeTotal: Number(input.importeTotal ?? input.totalAmount ?? 0),
        baseImponibleOImporteNoSujeto: Number(input.baseImponibleOImporteNoSujeto ?? input.taxableAmount ?? 0),
        cuotaTotal: Number(input.cuotaTotal ?? input.taxAmount ?? 0),
        tipoImpositivo: Number(input.tipoImpositivo ?? input.taxRate ?? catalogo?.taxRate ?? 0),
        tipoRecargoEquivalencia: Number(input.tipoRecargoEquivalencia ?? 0),
        cuotaRecargoEquivalencia: Number(input.cuotaRecargoEquivalencia ?? input.importeRecargoEquivalencia ?? 0),
        importeRetencionIRPF: Number(input.importeRetencionIRPF ?? 0),
        tipoRetencionIRPF: Number(input.tipoRetencionIRPF ?? 0),
        baseImponibleRetencion: Number(input.baseImponibleRetencion ?? 0),
        claveRegimen: _safeTrim(input.claveRegimen || catalogo?.claveRegimenAEAT) || "01",
        calificacionOperacion: _safeTrim(input.calificacionOperacion || catalogo?.calificacionOperacionAEAT) || "S1",
        operacionExenta: _safeTrim(input.operacionExenta || catalogo?.operacionExentaAEAT) || null,
        inversionSujetoPasivo: input.inversionSujetoPasivo === true || catalogo?.inversionSujetoPasivo === true,
        causaNoSujeta: _safeTrim(input.causaNoSujeta) || null,
        regimenEspecialCriterioCaja: input.regimenEspecialCriterioCaja === true,
        exentaPorArticulo20: input.exentaPorArticulo20 === true,
        sistemaInformatico: { ...SISTEMA_INFORMATICO },
        idFacturaAnterior: _safeTrim(input.idFacturaAnterior) || null,
        numSerieFacturaAnterior: _safeTrim(input.numSerieFacturaAnterior) || null,
        fechaExpedicionFacturaAnterior: _safeTrim(input.fechaExpedicionFacturaAnterior) || null,
        huellaAnterior: huellaAnterior || null,
        huella: huellaActual,
        fechaHoraHusoGenRegistro,
        generationTimestamp: _buildGenerationTimestamp(ts),
        desgloseDetallado: Array.isArray(input.desglose) ? input.desglose : [],
    };
}

// ============================================================================
// MOTOR — registrarEventoEconomico
// ============================================================================

export async function registrarEventoEconomico(input) {
    const traceId = input.traceId || makeTraceId("evento");
    const ts = new Date();

    // 1. Resolver tercero
    const tercero = await _upsertDatosFiscales({
        nifCif: input.nifDestinatario || input.nifTercero || input.nifEmisor,
        razonSocial: input.nombreRazonDestinatario || input.razonSocialTercero || input.nombreRazonEmisor,
        tipoTercero: input.tipoTercero || TIPO_TERCERO.CLIENTE,
        datosContacto: input.datosContacto || input.domicilioDestinatario || null,
    }, traceId);

    // 2. Resolver catalogo
    const catalogo = await _getServicioCatalogo(input.catalogoId, traceId);

    // 3. Ultimo evento + secuencia
    const anterior = await _getUltimoEventoCaja();
    const seq = await _getNextSequenceInternal(traceId);

    const huellaAnterior = _safeTrim(anterior?.huella || anterior?.currentRecordHash) || GENESIS_HASH;
    const fechaHoraHusoGenRegistro = _formatAEATDateTimeMadrid(ts);

    // 4. Construir movimiento base (aun sin huella)
    const movBase = {
        sequenceNumber: seq.sequenceNumber,
        numSerieFactura: _safeTrim(input.numSerieFactura || input.invoiceNumber) || seq.invoiceNumber,
        invoiceNumber: _safeTrim(input.numSerieFactura || input.invoiceNumber) || seq.invoiceNumber,
        fechaExpedicionFactura: _safeTrim(input.fechaExpedicionFactura || input.operationDate) ||
            new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" }),
        operationDate: _safeTrim(input.fechaExpedicionFactura || input.operationDate) ||
            new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" }),
        fechaOperacion: _safeTrim(input.fechaOperacion) || null,
        fiscalPeriod: (_safeTrim(input.fechaExpedicionFactura || input.operationDate) ||
            new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" })).slice(0, 7),

        tipoMovimiento: _safeTrim(input.tipoMovimiento || input.movementType),
        movementType: _safeTrim(input.tipoMovimiento || input.movementType),
        tipoEvento: _safeTrim(input.tipoEvento),

        paymentMethod: _safeTrim(input.paymentMethod),
        channelType: _safeTrim(input.channelType) || "POS",

        importeTotal: Number(input.importeTotal ?? input.totalAmount ?? 0),
        totalAmount: Number(input.importeTotal ?? input.totalAmount ?? 0),
        baseImponibleOImporteNoSujeto: Number(input.baseImponibleOImporteNoSujeto ?? input.taxableAmount ?? 0),
        taxableAmount: Number(input.baseImponibleOImporteNoSujeto ?? input.taxableAmount ?? 0),
        cuotaTotal: Number(input.cuotaTotal ?? input.taxAmount ?? 0),
        taxAmount: Number(input.cuotaTotal ?? input.taxAmount ?? 0),
        tipoImpositivo: Number(input.tipoImpositivo ?? input.taxRate ?? IVA_RATES.GENERAL),
        taxRate: Number(input.tipoImpositivo ?? input.taxRate ?? IVA_RATES.GENERAL),
        tipoRecargoEquivalencia: Number(input.tipoRecargoEquivalencia ?? 0),
        cuotaRecargoEquivalencia: Number(input.cuotaRecargoEquivalencia ?? input.importeRecargoEquivalencia ?? 0),
        importeRecargoEquivalencia: Number(input.cuotaRecargoEquivalencia ?? input.importeRecargoEquivalencia ?? 0),
        importeRetencionIRPF: Number(input.importeRetencionIRPF ?? 0),
        tipoRetencionIRPF: Number(input.tipoRetencionIRPF ?? 0),
        baseImponibleRetencion: Number(input.baseImponibleRetencion ?? 0),
        rolFiscal: _safeTrim(input.rolFiscal) || ROL_FISCAL.EMISOR,

        descripcionOperacion: _cleanText(input.descripcionOperacion || input.concept || "", 500),
        concept: _cleanText(input.descripcionOperacion || input.concept || "", 500),

        tipoFactura: _safeTrim(input.tipoFactura || input.claveRegistroFactura) || CLAVES_AEAT.F1,
        claveRegistroFactura: _safeTrim(input.tipoFactura || input.claveRegistroFactura) || CLAVES_AEAT.F1,
        tipoRectificativa: _safeTrim(input.tipoRectificativa) || null,
        motivoRectificacion: _safeTrim(input.motivoRectificacion) || null,
        idFacturaAnterior: _safeTrim(input.idFacturaAnterior || input.idFacturaRectificada) || null,
        idFacturaRectificada: _safeTrim(input.idFacturaAnterior || input.idFacturaRectificada) || null,
        numSerieFacturaAnterior: _safeTrim(input.numSerieFacturaAnterior) || null,
        fechaExpedicionFacturaAnterior: _safeTrim(input.fechaExpedicionFacturaAnterior) || null,

        nifEmisor: _safeTrim(input.nifEmisor || input.businessTaxId),
        businessTaxId: _safeTrim(input.nifEmisor || input.businessTaxId),
        nombreRazonEmisor: _safeTrim(input.nombreRazonEmisor),
        nifDestinatario: _safeTrim(tercero?.nifCif || input.nifDestinatario || input.nifTercero),
        nifTercero: _safeTrim(tercero?.nifCif || input.nifDestinatario || input.nifTercero),
        nombreRazonDestinatario: _safeTrim(tercero?.razonSocial || input.nombreRazonDestinatario || input.razonSocialTercero),
        razonSocialTercero: _safeTrim(tercero?.razonSocial || input.nombreRazonDestinatario || input.razonSocialTercero),
        domicilioDestinatario: tercero?.datosContacto || input.domicilioDestinatario || null,
        esB2B: input.esB2B === true,

        emitidaPorTerceroODestinatario: _safeTrim(input.emitidaPorTerceroODestinatario) || "E",
        nombreRazonTercero: _safeTrim(input.nombreRazonTercero) || null,
        nifTerceroExpedidor: _safeTrim(input.nifTerceroExpedidor) || null,
        causaNoSujeta: _safeTrim(input.causaNoSujeta) || null,
        inversionSujetoPasivo: input.inversionSujetoPasivo === true || catalogo?.inversionSujetoPasivo === true,

        claveRegimen: _safeTrim(input.claveRegimen || catalogo?.claveRegimenAEAT) || "01",
        calificacionOperacion: _safeTrim(input.calificacionOperacion || catalogo?.calificacionOperacionAEAT) || "S1",
        operacionExenta: _safeTrim(input.operacionExenta || catalogo?.operacionExentaAEAT) || null,
        regimenEspecialCriterioCaja: input.regimenEspecialCriterioCaja === true,
        exentaPorArticulo20: input.exentaPorArticulo20 === true,

        idAnticipoVinculado: _safeTrim(input.idAnticipoVinculado) || null,
        estadoDevengoIVA: _safeTrim(input.estadoDevengoIVA) || ESTADO_DEVENGO_IVA.DEVENGADO,
        referenciaBancariaConciliacion: _safeTrim(input.referenciaBancariaConciliacion) || null,
        numeroSerieFacturaEmisor: _safeTrim(input.numeroSerieFacturaEmisor) || null,

        resourceId: _safeTrim(input.resourceId) || null,
        staffResourceId: _safeTrim(input.staffResourceId) || null,
        reservaIdVinculada: _safeTrim(input.reservaIdVinculada) || null,
        transactionId: _safeTrim(input.transactionId) || `TX_${seq.sequenceNumber}`,
        orderId: _safeTrim(input.orderId) || null,
        refundId: _safeTrim(input.refundId) || null,
        pairToken: _safeTrim(input.pairToken) || null,

        terceroId: tercero?._id || null,
        catalogoId: catalogo?._id || null,

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
        desgloseDetallado: payloadFiscal.desgloseDetallado,
        sistemaInformatico: payloadFiscal.sistemaInformatico,
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
            baseImponibleOImporteNoSujeto: Number(d.baseImponibleOImporteNoSujeto ?? d.base ?? 0),
            tipoImpositivo: Number(d.tipoImpositivo ?? d.tipo ?? 0),
            cuotaRepercutida: Number(d.cuotaRepercutida ?? d.cuota ?? 0),
            eventoOrigenId: cabecera._id,
            numeroLinea: i + 1,
            terceroId: tercero?._id || null,
            catalogoId: catalogo?._id || null,
            descripcionOperacion: _cleanText(d.descripcion || input.descripcionOperacion || input.concept || "", 500),
            unidades: Number(d.unidades || 1),
            magnitud: Number(d.magnitud || 1),
            importeNetoUnitario: Number(d.importeNetoUnitario ?? d.importeNeto ?? 0),
            codigoImpuesto: _safeTrim(d.codigoImpuesto || catalogo?.codigoImpuesto) || null,
            claveRegimen: _safeTrim(d.claveRegimen || payloadFiscal.claveRegimen),
            calificacionOperacion: _safeTrim(d.calificacionOperacion || payloadFiscal.calificacionOperacion),
            operacionExenta: _safeTrim(d.operacionExenta) || null,
            inversionSujetoPasivo: d.inversionSujetoPasivo === true || payloadFiscal.inversionSujetoPasivo,
            cuentaContable: _safeTrim(d.cuentaContable || catalogo?.cuentaContableIngreso) || null,
            tipoRecargoEquivalencia: Number(d.tipoRecargoEquivalencia ?? d.tipoRE ?? 0),
            cuotaRecargoEquivalencia: Number(d.cuotaRecargoEquivalencia ?? d.cuotaRE ?? 0),
            importeRetencionIRPF: Number(d.importeRetencionIRPF || 0),
            tipoRetencionIRPF: Number(d.tipoRetencionIRPF || 0),
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
            tipoEvento: cabecera.tipoEvento,
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
            numSerieFactura: doc.numSerieFactura,
            proyeccionEstado,
        },
        error: null,
    };
}

// ============================================================================
// PROYECCION SECUNDARIA — delega en modulos existentes
// ============================================================================

async function _proyectarSegunTipoEvento(cabecera, detalleIds, traceId) {
    switch (cabecera.tipoEvento) {
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
            log.warn("Tipo evento sin proyeccion", { traceId, tipoEvento: cabecera.tipoEvento });
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
            numSerieFactura: cabecera.numSerieFactura,
            fechaExpedicionFactura: cabecera.fechaExpedicionFactura,
            fechaOperacion: cabecera.fechaOperacion,
            fechaRecepcion,
            fechaRegistroContable: fechaRecepcion,
            terceroId: cabecera.terceroId,
            nifEmisor: cabecera.nifEmisor,
            nombreRazonEmisor: cabecera.nombreRazonEmisor,
            nifDestinatario: cabecera.nifDestinatario,
            nombreRazonDestinatario: cabecera.nombreRazonDestinatario,
            tipoFactura: cabecera.tipoFactura,
            descripcionOperacion: cabecera.descripcionOperacion,
            importeTotal: cabecera.importeTotal,
            baseImponibleTotal: cabecera.baseImponibleOImporteNoSujeto,
            cuotaIvaTotal: cabecera.cuotaTotal,
            cuotaRecargoEquivalencia: cabecera.cuotaRecargoEquivalencia,
            importeRetencionIRPF: cabecera.importeRetencionIRPF,
            tipoRetencionIRPF: cabecera.tipoRetencionIRPF,
            desgloseDetallado: cabecera.desgloseDetallado,
            claveRegimen: cabecera.claveRegimen,
            calificacionOperacion: cabecera.calificacionOperacion,
            operacionExenta: cabecera.operacionExenta,
            inversionSujetoPasivo: cabecera.inversionSujetoPasivo,
            deducible: true,
            porcentajeDeduccion: 100,
            cuotaDeducible: Number(cabecera.cuotaTotal || 0),
            estadoPago: "PENDIENTE",
            eventoOrigenId: cabecera._id,
            origenRecepcion: "API",
            estadoValidacion: "PENDIENTE",
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
            wixProductId: cabecera.payloadFiscal?.wixProductId || null,
            sku: cabecera.payloadFiscal?.sku || null,
            orderId: cabecera.orderId || null,
            refundId: cabecera.payloadFiscal?.refundId || null,
            eventoOrigenId: cabecera._id,
            catalogoId: cabecera.catalogoId,
            magnitud: cabecera.payloadFiscal?.magnitud || 1,
            terceroId: cabecera.terceroId,
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
            _id: `Z_${cabecera.fechaExpedicionFactura}`,
            operationDate: cabecera.fechaExpedicionFactura,
            saldosPorMetodo: cabecera.payloadFiscal?.saldosPorMetodo || {},
            eventoOrigenId: cabecera._id,
            desglosePorRegimen: cabecera.payloadFiscal?.desglosePorRegimen || [],
            desglosePorTipoOperacion: cabecera.payloadFiscal?.desglosePorTipoOperacion || [],
            desglosePorTipoImpositivo: cabecera.payloadFiscal?.desglosePorTipoImpositivo || [],
            resumenVerifactu: cabecera.payloadFiscal?.resumenVerifactu || {},
            estadoEnvioAeat: "PENDIENTE",
            traceId,
            _createdDate: new Date(),
        }, { suppressAuth: true });
    } catch (err) {
        const msg = String(err?.message || "");
        if (msg.includes("WDE0123") || msg.includes("Duplicated") || msg.includes("already exists")) {
            log.info("CierreZ ya existe (idempotente)", { traceId, fecha: cabecera.fechaExpedicionFactura });
            return;
        }
        throw err;
    }
}

// ============================================================================
// WEB METHODS DE CONSULTA
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
                .eq("eventoOrigenId", eventoId)
                .ascending("numeroLinea")
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
// RECONCILIACION (cron)
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
            .ne("proyeccionEstado", PROYECCION_ESTADO.OK)
            .descending("sequenceNumber")
            .limit(PROYECCION_BATCH_LIMIT)
            .find({ suppressAuth: true });

        for (const evento of pendientes.items || []) {
            try {
                await withTimeout(
                    _proyectarSegunTipoEvento(evento, evento.proyeccionDetalleIds || [], traceId),
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

        return { status: "SUCCESS", data: { procesados, fallidos, total: pendientes.items?.length || 0 } };
    } catch (err) {
        log.error("reconciliarProyecciones fallo global", { traceId, message: err?.message });
        return { status: "ERROR", data: { procesados, fallidos }, error: { code: "RECON_FAIL", message: err?.message } };
    }
}

export default {
    registrarEventoEconomico,
    getEventoPorId,
    reconciliarProyecciones,
    _getNextSequenceInternal,
};

// ============================================================================
// SECCION 4 - API DE COMPRAS (absorbe facturasRecibidas.web.js)
// ============================================================================

export const registrarFacturaRecibida = webMethod(
    Permissions.SiteMember,
    async (payload) => {
        const traceId = payload?.traceId || makeTraceId("fact-rec");
        try {
            // 1. Validacion minima
            const nifEmisor = _safeTrim(payload?.nifEmisor).toUpperCase();
            if (!nifEmisor) {
                return { status: "ERROR", data: null,
                    error: { code: "NIF_EMISOR_REQUERIDO", message: "nifEmisor obligatorio" } };
            }
            const numSerie = _safeTrim(payload?.numSerieFactura);
            if (!numSerie) {
                return { status: "ERROR", data: null,
                    error: { code: "NUM_SERIE_REQUERIDO", message: "numSerieFactura obligatorio" } };
            }
            const importeTotal = Number(payload?.importeTotal) || 0;
            if (importeTotal <= 0) {
                return { status: "ERROR", data: null,
                    error: { code: "IMPORTE_INVALIDO", message: "importeTotal > 0" } };
            }

            // 2. Idempotencia por numSerie+NIF
            const existing = await wixData
                .query(COLLECTIONS.FACTURAS_RECIBIDAS)
                .eq("numSerieFactura", numSerie)
                .eq("nifEmisor", nifEmisor)
                .limit(1)
                .find({ suppressAuth: true });
            if (existing?.items?.[0]) {
                return { status: "SUCCESS", data: existing.items[0], error: null, idempotent: true };
            }

            // 3. Delegar en el motor
            const eventResult = await registrarEventoEconomico({
                tipoEvento: TIPO_EVENTO.COMPRA_LINEA,
                tipoMovimiento: TIPO_MOVIMIENTO.PAGO_PROVEEDOR,
                paymentMethod: _safeTrim(payload?.medioPago) || FORMA_PAGO.EFECTIVO,
                importeTotal,
                baseImponibleOImporteNoSujeto: Number(payload?.baseImponibleTotal) || 0,
                cuotaTotal: Number(payload?.cuotaIvaTotal) || 0,
                tipoImpositivo: Number(payload?.tipoImpositivo) || 21,
                tipoRecargoEquivalencia: Number(payload?.tipoRecargoEquivalencia) || 0,
                cuotaRecargoEquivalencia: Number(payload?.cuotaRecargoEquivalencia) || 0,
                importeRetencionIRPF: Number(payload?.importeRetencionIRPF) || 0,
                tipoRetencionIRPF: Number(payload?.tipoRetencionIRPF) || 0,
                descripcionOperacion: _cleanText(payload?.descripcionOperacion || "", 500),
                numSerieFactura: numSerie,
                fechaExpedicionFactura: _safeTrim(payload?.fechaExpedicionFactura),
                fechaOperacion: _safeTrim(payload?.fechaOperacion) || null,
                tipoFactura: _safeTrim(payload?.tipoFactura) || CLAVES_AEAT.F1,
                nifEmisor: nifEmisor,
                nombreRazonEmisor: _safeTrim(payload?.nombreRazonEmisor),
                nifDestinatario: _safeTrim(payload?.nifDestinatario),
                nombreRazonDestinatario: _safeTrim(payload?.nombreRazonDestinatario),
                claveRegimen: _safeTrim(payload?.claveRegimen) || "01",
                calificacionOperacion: _safeTrim(payload?.calificacionOperacion) || "S1",
                operacionExenta: _safeTrim(payload?.operacionExenta) || null,
                inversionSujetoPasivo: payload?.inversionSujetoPasivo === true,
                desglose: Array.isArray(payload?.desgloseDetallado) ? payload.desgloseDetallado : [],
                traceId,
            });

            return eventResult;
        } catch (err) {
            log.error("registrarFacturaRecibida fallo", { traceId, message: err?.message });
            return { status: "ERROR", data: null,
                error: { code: "FACT_REC_FAIL", message: err?.message } };
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
            if (filters?.estadoPago) {
                q = q.eq("estadoPago", _safeTrim(filters.estadoPago).toUpperCase());
            }
            if (filters?.terceroId && _looksLikeGuid(filters.terceroId)) {
                q = q.eq("terceroId", filters.terceroId);
            }
            if (filters?.desde) {
                q = q.ge("fechaExpedicionFactura", filters.desde);
            }
            if (filters?.hasta) {
                q = q.le("fechaExpedicionFactura", filters.hasta);
            }
            const limit = Math.min(Number(filters?.limit) || 50, 200);
            const res = await q.descending("fechaExpedicionFactura").limit(limit)
                .find({ suppressAuth: true });
            return { status: "SUCCESS", data: { items: res.items || [], total: res.totalCount }, error: null };
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
            if (!["PENDIENTE", "PAGADO", "PARCIAL"].includes(estado)) {
                return { status: "ERROR", data: null, error: { code: "INVALID_ESTADO" } };
            }
            await wixData.update(COLLECTIONS.FACTURAS_RECIBIDAS, {
                _id: facturaId,
                estadoPago: estado,
                fechaPago: estado === "PAGADO" ? new Date() : factura.fechaPago,
                medioPago: meta?.medioPago || factura.medioPago,
                _updatedDate: new Date(),
            }, { suppressAuth: true });
            return { status: "SUCCESS", data: { facturaId, estadoPago: estado }, error: null };
        } catch (err) {
            log.error("actualizarEstadoPagoFactura fallo", { traceId, message: err?.message });
            return { status: "ERROR", data: null, error: { code: "UPDATE_FAILED" } };
        }
    }
);
