/*
=============================================================================
MODULE: backend/eventLog.js
VERSION: v5009.0-FISCAL
BASE: SSOT CMS v5009 + DOSSIER CAJA + DIRECTRICES V19
RESPONSIBILITY: Motor unico de escritura fiscal AEAT. Registra eventos
                atomicos (cabecera MovimientosCaja + detalle
                LibroAsientosContablesDetalle) con encadenamiento SHA-256,
                y proyecta a colecciones secundarias (AsientosContables,
                FacturasRecibidas, MovimientosInventario, HistoricoCierresZ).
STANDARDS: G10 ASCII Strict.

INVARIANTES:
  - Toda escritura fiscal pasa por registrarEventoEconomico.
  - Cabecera obtiene huella ANTES de insertar detalle.
  - Detalle hereda eventoOrigenId y lineHash encadenado.
  - sequenceNumber monotono sin huecos (unico escritor: CAJA_SEQ).
  - MovimientosCaja es append-only (hooks bloquean update/remove).
  - Falla en proyeccion secundaria deja proyeccionEstado=PENDIENTE.

CONSOLIDACIONES v5009:
  - verifyFiscalHashChainIntegrity (cajas.web.js) es alias de
    verificarCadenaHash. Una sola implementacion aqui.
  - Proyeccion contable delega en contabilidad.js (import dinamico).
  - Proyeccion stock delega en inventario.web.js (import dinamico).
  - Sin ciclos: cajas.web.js importa eventLog, nunca al reves.
=============================================================================
*/

import wixData from "wix-data";
import { webMethod, Permissions } from "wix-web-module";

import {
    COLLECTIONS,
    SINGLETONS,
    SISTEMA_INFORMATICO,
    ESTADO_ENVIO_AEAT,
    PROYECCION_ESTADO,
    TIPO_EVENTO,
} from "backend/internalConfig";

import {
    makeTraceId,
    _safeTrim,
    _looksLikeGuid,
} from "public/mmUtils";

import { logger } from "backend/logger";

const log = logger;

const CAJA_SEQ_ID = "CAJA_SEQ";
const SHA256_HEX_LEN = 64;
const MADRID_TZ = "Europe/Madrid";

// ============================================================================
// BLOQUE 1 - UTILIDADES CRIPTOGRAFICAS
// ============================================================================

async function _sha256Hex(input) {
    const bytes = new TextEncoder().encode(String(input));
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function _isValidHuella(huella) {
    return typeof huella === "string" && huella.length === SHA256_HEX_LEN;
}

// ============================================================================
// BLOQUE 2 - FECHA Y HORA MADRID
// ============================================================================

function _getMadridOffsetHours(date) {
    const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
    const madridDate = new Date(date.toLocaleString("en-US", { timeZone: MADRID_TZ }));
    return Math.round((madridDate.getTime() - utcDate.getTime()) / 3600000);
}

function _formatMadridIso(date) {
    const offsetHours = _getMadridOffsetHours(date);
    const local = new Date(date.getTime() + offsetHours * 3600000);
    const y = local.getUTCFullYear();
    const m = String(local.getUTCMonth() + 1).padStart(2, "0");
    const d = String(local.getUTCDate()).padStart(2, "0");
    const h = String(local.getUTCHours()).padStart(2, "0");
    const mi = String(local.getUTCMinutes()).padStart(2, "0");
    const s = String(local.getUTCSeconds()).padStart(2, "0");
    const sign = offsetHours >= 0 ? "+" : "-";
    const absOffset = String(Math.abs(offsetHours)).padStart(2, "0");
    return `${y}-${m}-${d}T${h}:${mi}:${s}${sign}${absOffset}:00`;
}

function _buildGenerationTimestamp(date) {
    const offsetHours = _getMadridOffsetHours(date);
    const local = new Date(date.getTime() + offsetHours * 3600000);
    return {
        year: local.getUTCFullYear(),
        month: local.getUTCMonth() + 1,
        day: local.getUTCDate(),
        hour: local.getUTCHours(),
        minute: local.getUTCMinutes(),
        second: local.getUTCSeconds(),
    };
}

// ============================================================================
// BLOQUE 3 - SECUENCIA GLOBAL (unico escritor: este modulo)
// ============================================================================

async function _getNextSequence() {
    const current = await wixData
        .get(COLLECTIONS.CAJA_ACTUAL, CAJA_SEQ_ID, { suppressAuth: true })
        .catch(() => null);
    const next = Number(current?.sequenceNumber || 0) + 1;
    await wixData.save(COLLECTIONS.CAJA_ACTUAL, {
        _id: CAJA_SEQ_ID,
        sequenceNumber: next,
        updatedAt: new Date(),
    }, { suppressAuth: true });
    return next;
}

async function _getUltimoEventoCaja() {
    const result = await wixData
        .query(COLLECTIONS.MOVIMIENTOS_CAJA)
        .descending("sequenceNumber")
        .limit(1)
        .find({ suppressAuth: true });
    return result?.items?.[0] || null;
}

// ============================================================================
// BLOQUE 4 - UPSERT DE MAESTROS
// ============================================================================

async function upsertDatosFiscales({ nifCif, razonSocial, tipoTercero, datosContacto }, traceId) {
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
        tipoTercero: _safeTrim(tipoTercero) || "CLIENTE",
        datosContacto: datosContacto || null,
        activo: true,
        traceIdAlta: traceId,
    }, { suppressAuth: true });
}

async function getServicioCatalogo(catalogoId, traceId) {
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
// BLOQUE 5 - PAYLOAD FISCAL AEAT
// ============================================================================

function buildPayloadFiscal({ tercero, catalogo, input, ts, huellaAnterior, huellaActual }) {
    const fechaHoraHusoGenRegistro = _formatMadridIso(ts);
    return {
        idEmisorFactura: _safeTrim(input.nifEmisor),
        nombreRazonEmisor: _safeTrim(input.nombreRazonEmisor),
        nifDestinatario: _safeTrim(tercero?.nifCif || input.nifDestinatario),
        nombreRazonDestinatario: _safeTrim(tercero?.razonSocial || input.nombreRazonDestinatario),
        domicilioDestinatario: tercero?.datosContacto || input.domicilioDestinatario || null,
        emitidaPorTerceroODestinatario: _safeTrim(input.emitidaPorTerceroODestinatario) || "E",
        nombreRazonTercero: _safeTrim(input.nombreRazonTercero) || null,
        nifTerceroExpedidor: _safeTrim(input.nifTerceroExpedidor) || null,
        numSerieFactura: _safeTrim(input.numSerieFactura),
        fechaExpedicionFactura: _safeTrim(input.fechaExpedicionFactura),
        fechaOperacion: _safeTrim(input.fechaOperacion) || null,
        tipoFactura: _safeTrim(input.tipoFactura) || "F1",
        descripcionOperacion: _safeTrim(input.descripcionOperacion),
        importeTotal: Number(input.importeTotal || 0),
        baseImponibleOImporteNoSujeto: Number(input.baseImponibleOImporteNoSujeto || 0),
        cuotaTotal: Number(input.cuotaTotal || 0),
        tipoImpositivo: Number(input.tipoImpositivo || catalogo?.taxRate || 0),
        tipoRecargoEquivalencia: Number(input.tipoRecargoEquivalencia || 0),
        cuotaRecargoEquivalencia: Number(input.cuotaRecargoEquivalencia || 0),
        importeRetencionIRPF: Number(input.importeRetencionIRPF || 0),
        tipoRetencionIRPF: Number(input.tipoRetencionIRPF || 0),
        claveRegimen: _safeTrim(input.claveRegimen || catalogo?.claveRegimenAEAT) || "01",
        calificacionOperacion: _safeTrim(input.calificacionOperacion || catalogo?.calificacionOperacionAEAT) || "S1",
        operacionExenta: _safeTrim(input.operacionExenta || catalogo?.operacionExentaAEAT) || null,
        inversionSujetoPasivo: input.inversionSujetoPasivo === true || catalogo?.inversionSujetoPasivo === true,
        causaNoSujeta: _safeTrim(input.causaNoSujeta) || null,
        sistemaInformatico: { ...SISTEMA_INFORMATICO },
        idFacturaAnterior: input.idFacturaAnterior || null,
        numSerieFacturaAnterior: input.numSerieFacturaAnterior || null,
        fechaExpedicionFacturaAnterior: input.fechaExpedicionFacturaAnterior || null,
        huellaAnterior: huellaAnterior || null,
        huella: huellaActual,
        fechaHoraHusoGenRegistro,
        generationTimestamp: _buildGenerationTimestamp(ts),
        desgloseDetallado: Array.isArray(input.desglose) ? input.desglose : [],
    };
}

// ============================================================================
// BLOQUE 6 - REGISTRO ATOMICO DEL EVENTO
// ============================================================================

export async function registrarEventoEconomico(input) {
    if (!input || typeof input !== "object") {
        return { status: "ERROR", data: null, error: { code: "INVALID_INPUT" } };
    }

    const traceId = input.traceId || makeTraceId("evento");
    const ts = new Date();

    const tercero = await upsertDatosFiscales({
        nifCif: input.nifDestinatario || input.nifEmisor,
        razonSocial: input.nombreRazonDestinatario || input.nombreRazonEmisor,
        tipoTercero: input.tipoTercero || "CLIENTE",
        datosContacto: input.datosContacto || input.domicilioDestinatario || null,
    }, traceId);

    const catalogo = await getServicioCatalogo(input.catalogoId, traceId);

    const anterior = await _getUltimoEventoCaja();
    const sequenceNumber = await _getNextSequence();

    const fechaHoraHusoGenRegistro = _formatMadridIso(ts);
    const huellaActual = await _sha256Hex(
        (anterior?.huella || "") +
        JSON.stringify(input) +
        fechaHoraHusoGenRegistro
    );

    const payloadFiscal = buildPayloadFiscal({
        tercero,
        catalogo,
        input,
        ts,
        huellaAnterior: anterior?.huella || null,
        huellaActual,
    });

    const cabecera = await wixData.insert(COLLECTIONS.MOVIMIENTOS_CAJA, {
        // Legacy v5008.3
        amount: Number(input.importeTotal || 0),
        paymentMethod: _safeTrim(input.paymentMethod),
        tipoMovimiento: _safeTrim(input.tipoMovimiento),
        concept: _safeTrim(input.descripcionOperacion),
        resourceId: _safeTrim(input.resourceId),
        reservaIdVinculada: _safeTrim(input.reservaIdVinculada),
        transactionId: _safeTrim(input.transactionId),
        orderId: _safeTrim(input.orderId),
        schemaVersion: "LEDGER_V5_FISCAL",
        hash: huellaActual,
        prevHash: anterior?.huella || null,
        registeredAt: ts,

        // AEAT
        importeTotal: Number(input.importeTotal || 0),
        descripcionOperacion: _safeTrim(input.descripcionOperacion),
        staffResourceId: _safeTrim(input.staffResourceId),
        channelType: _safeTrim(input.channelType) || "POS",
        huella: huellaActual,
        huellaAnterior: anterior?.huella || null,
        fechaHoraHusoGenRegistro,
        generationTimestamp: payloadFiscal.generationTimestamp,
        numSerieFactura: _safeTrim(input.numSerieFactura),
        fechaExpedicionFactura: input.fechaExpedicionFactura || ts,
        fechaOperacion: input.fechaOperacion || null,
        tipoFactura: _safeTrim(input.tipoFactura) || "F1",
        tipoRectificativa: _safeTrim(input.tipoRectificativa) || null,
        importeRectificacion: input.importeRectificacion || null,
        baseImponibleOImporteNoSujeto: Number(input.baseImponibleOImporteNoSujeto || 0),
        cuotaTotal: Number(input.cuotaTotal || 0),
        tipoImpositivo: Number(input.tipoImpositivo || 0),
        tipoRecargoEquivalencia: Number(input.tipoRecargoEquivalencia || 0),
        cuotaRecargoEquivalencia: Number(input.cuotaRecargoEquivalencia || 0),
        importeRetencionIRPF: Number(input.importeRetencionIRPF || 0),
        tipoRetencionIRPF: Number(input.tipoRetencionIRPF || 0),
        baseImponibleRetencion: Number(input.baseImponibleRetencion || 0),
        nifEmisor: _safeTrim(input.nifEmisor),
        nombreRazonEmisor: _safeTrim(input.nombreRazonEmisor),
        nifDestinatario: _safeTrim(tercero?.nifCif || input.nifDestinatario),
        nombreRazonDestinatario: _safeTrim(tercero?.razonSocial || input.nombreRazonDestinatario),
        domicilioDestinatario: tercero?.datosContacto || input.domicilioDestinatario || null,
        emitidaPorTerceroODestinatario: payloadFiscal.emitidaPorTerceroODestinatario,
        nombreRazonTercero: payloadFiscal.nombreRazonTercero,
        nifTerceroExpedidor: payloadFiscal.nifTerceroExpedidor,
        causaNoSujeta: payloadFiscal.causaNoSujeta,
        inversionSujetoPasivo: payloadFiscal.inversionSujetoPasivo,
        claveRegimen: payloadFiscal.claveRegimen,
        calificacionOperacion: payloadFiscal.calificacionOperacion,
        operacionExenta: payloadFiscal.operacionExenta,
        regimenEspecialCriterioCaja: input.regimenEspecialCriterioCaja === true,
        exentaPorArticulo20: input.exentaPorArticulo20 === true,
        desgloseDetallado: payloadFiscal.desgloseDetallado,
        sistemaInformatico: payloadFiscal.sistemaInformatico,
        idFacturaAnterior: anterior?.numSerieFactura || null,
        numSerieFacturaAnterior: anterior?.numSerieFactura || null,
        fechaExpedicionFacturaAnterior: anterior?.fechaExpedicionFactura || null,
        estadoEnvioAeat: ESTADO_ENVIO_AEAT.PENDIENTE,

        // Event sourcing
        tipoEvento: _safeTrim(input.tipoEvento) || TIPO_EVENTO.VENTA_LINEA,
        terceroId: tercero?._id || null,
        catalogoId: catalogo?._id || null,
        pairToken: _safeTrim(input.pairToken) || null,
        payloadFiscal,
        sequenceNumber,
        proyeccionEstado: PROYECCION_ESTADO.PENDIENTE,
        proyeccionDetalleIds: [],
        traceId,
    }, { suppressAuth: true });

    // Detalle: N lineas
    const detalleIds = [];
    const desglose = Array.isArray(input.desglose) ? input.desglose : [];
    for (let i = 0; i < desglose.length; i += 1) {
        const d = desglose[i];
        const lineHash = await _sha256Hex(huellaActual + JSON.stringify(d));
        const det = await wixData.insert(COLLECTIONS.LIBRO_ASIENTOS_CONTABLES_DETALLE, {
            lineHash,
            baseImponibleOImporteNoSujeto: Number(d.base || 0),
            tipoImpositivo: Number(d.tipo || 0),
            cuotaRepercutida: Number(d.cuota || 0),
            eventoOrigenId: cabecera._id,
            numeroLinea: i + 1,
            terceroId: tercero?._id || null,
            catalogoId: catalogo?._id || null,
            descripcionOperacion: _safeTrim(d.descripcion || input.descripcionOperacion),
            unidades: Number(d.unidades || 1),
            magnitud: Number(d.magnitud || 1),
            importeNetoUnitario: Number(d.importeNeto || 0),
            codigoImpuesto: _safeTrim(d.codigoImpuesto || catalogo?.codigoImpuesto),
            claveRegimen: _safeTrim(d.claveRegimen || payloadFiscal.claveRegimen),
            calificacionOperacion: _safeTrim(d.calificacionOperacion || payloadFiscal.calificacionOperacion),
            operacionExenta: _safeTrim(d.operacionExenta) || null,
            inversionSujetoPasivo: d.inversionSujetoPasivo === true || payloadFiscal.inversionSujetoPasivo,
            cuentaContable: _safeTrim(d.cuentaContable || catalogo?.cuentaContableIngreso),
            tipoRecargoEquivalencia: Number(d.tipoRE || 0),
            cuotaRecargoEquivalencia: Number(d.cuotaRE || 0),
            importeRetencionIRPF: Number(d.importeRetencionIRPF || 0),
            tipoRetencionIRPF: Number(d.tipoRetencionIRPF || 0),
        }, { suppressAuth: true });
        detalleIds.push(det._id);
    }

    // Proyeccion secundaria
    let proyeccionEstado = PROYECCION_ESTADO.OK;
    try {
        await proyectarSegunTipoEvento(cabecera, detalleIds, traceId);
    } catch (err) {
        proyeccionEstado = PROYECCION_ESTADO.ERROR;
        log.error("Proyeccion secundaria fallo", {
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
            sequenceNumber,
        },
        error: null,
    };
}

// ============================================================================
// BLOQUE 7 - PROYECCION SECUNDARIA (imports dinamicos para evitar ciclos)
// ============================================================================

async function proyectarSegunTipoEvento(cabecera, detalleIds, traceId) {
    switch (cabecera.tipoEvento) {
        case TIPO_EVENTO.VENTA_LINEA:
        case TIPO_EVENTO.RECTIFICATIVA:
        case TIPO_EVENTO.AJUSTE:
            await _proyectarAsientoContable(cabecera, detalleIds, traceId);
            break;
        case TIPO_EVENTO.COMPRA_LINEA:
            await _proyectarFacturaRecibida(cabecera, detalleIds, traceId);
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

async function _proyectarAsientoContable(cabecera, detalleIds, traceId) {
    const entryId = `ASIENTO_${cabecera._id}`;
    const fiscalPeriod = String(cabecera.fechaExpedicionFactura || "").slice(0, 7);
    try {
        await wixData.insert(COLLECTIONS.ASIENTOS_CONTABLES, {
            sequenceNumber: cabecera.sequenceNumber,
            operationDate: cabecera.fechaExpedicionFactura,
            fiscalPeriod,
            entryStatus: "POSTED",
            journalEntryId: entryId,
            previousHash: cabecera.huellaAnterior,
            hashOrigen: cabecera.huella,
            invoiceNumber: cabecera.numSerieFactura,
            totalDocumentAmount: cabecera.importeTotal,
            eventoOrigenId: cabecera._id,
            terceroId: cabecera.terceroId,
            payloadFiscalSnapshot: cabecera.payloadFiscal,
            desgloseDetallado: cabecera.desgloseDetallado,
            claveRegimen: cabecera.claveRegimen,
            calificacionOperacion: cabecera.calificacionOperacion,
            operacionExenta: cabecera.operacionExenta,
            inversionSujetoPasivo: cabecera.inversionSujetoPasivo,
            sistemaInformatico: cabecera.sistemaInformatico,
            huella: cabecera.huella,
            huellaAnterior: cabecera.huellaAnterior,
            idFacturaAnterior: cabecera.idFacturaAnterior,
            numSerieFacturaAnterior: cabecera.numSerieFacturaAnterior,
            fechaExpedicionFacturaAnterior: cabecera.fechaExpedicionFacturaAnterior,
        }, { suppressAuth: true });
    } catch (err) {
        if (err?.code === "WD_ITEM_ALREADY_EXISTS" || /duplicate/i.test(err?.message || "")) {
            log.debug("Asiento ya existe", { eventoId: cabecera._id });
            return;
        }
        throw err;
    }
}

async function _proyectarFacturaRecibida(cabecera, detalleIds, traceId) {
    const numeroRecepcion = `FR-${cabecera.sequenceNumber}`;
    const fechaRecepcion = new Date();
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
            cuotaDeducible: cabecera.cuotaTotal,
            estadoPago: "PENDIENTE",
            eventoOrigenId: cabecera._id,
            origenRecepcion: "API",
            estadoValidacion: "PENDIENTE",
            traceId,
        }, { suppressAuth: true });
    } catch (err) {
        if (err?.code === "WD_ITEM_ALREADY_EXISTS" || /duplicate/i.test(err?.message || "")) {
            log.debug("Factura recibida ya existe", { eventoId: cabecera._id });
            return;
        }
        throw err;
    }
}

async function _proyectarMovimientoInventario(cabecera, traceId) {
    // Delegado a inventario.web.js via import dinamico para evitar ciclo.
    const { recordInventoryMovementSafe } = await import("backend/inventario.web");
    if (typeof recordInventoryMovementSafe !== "function") {
        log.warn("recordInventoryMovementSafe no disponible; proyeccion stock omitida", {
            traceId,
            eventoId: cabecera._id,
        });
        return;
    }
    await recordInventoryMovementSafe({
        eventoOrigenId: cabecera._id,
        catalogoId: cabecera.catalogoId,
        terceroId: cabecera.terceroId,
        orderId: cabecera.orderId || null,
        refundId: cabecera.payloadFiscal?.refundId || null,
        wixProductId: cabecera.payloadFiscal?.wixProductId || null,
        sku: cabecera.payloadFiscal?.sku || null,
        magnitud: Number(cabecera.payloadFiscal?.magnitud || 1),
        traceId,
    });
}

async function _proyectarCierreZ(cabecera, traceId) {
    const entryId = `Z_${cabecera.fechaExpedicionFactura}`;
    try {
        await wixData.insert(COLLECTIONS.HISTORICO_CIERRES_Z, {
            operationDate: cabecera.fechaExpedicionFactura,
            saldosPorMetodo: cabecera.payloadFiscal?.saldosPorMetodo || {},
            eventoOrigenId: cabecera._id,
            desglosePorRegimen: cabecera.payloadFiscal?.desglosePorRegimen || [],
            desglosePorTipoOperacion: cabecera.payloadFiscal?.desglosePorTipoOperacion || [],
            desglosePorTipoImpositivo: cabecera.payloadFiscal?.desglosePorTipoImpositivo || [],
            resumenVerifactu: cabecera.payloadFiscal?.resumenVerifactu || {},
            estadoEnvioAeat: ESTADO_ENVIO_AEAT.PENDIENTE,
        }, { suppressAuth: true });
    } catch (err) {
        if (err?.code === "WD_ITEM_ALREADY_EXISTS" || /duplicate/i.test(err?.message || "")) {
            log.debug("Cierre Z ya existe", { eventoId: cabecera._id });
            return;
        }
        throw err;
    }
}

// ============================================================================
// BLOQUE 8 - CONSULTA Y AUDITORIA
// ============================================================================

export const getEventoPorId = webMethod(
    Permissions.Admin,
    async (eventoId) => {
        const traceId = makeTraceId("get-evento");
        try {
            if (!_looksLikeGuid(eventoId)) {
                return { status: "ERROR", data: null, error: { code: "INVALID_ID" } };
            }
            const evento = await wixData.get(COLLECTIONS.MOVIMIENTOS_CAJA, eventoId, { suppressAuth: true });
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

export const verificarCadenaHash = webMethod(
    Permissions.Admin,
    async (desdeSecuencia, hastaSecuencia) => {
        const traceId = makeTraceId("verify-chain");
        try {
            const result = await wixData
                .query(COLLECTIONS.MOVIMIENTOS_CAJA)
                .ge("sequenceNumber", Number(desdeSecuencia) || 1)
                .le("sequenceNumber", Number(hastaSecuencia) || 999999999)
                .ascending("sequenceNumber")
                .limit(1000)
                .find({ suppressAuth: true });

            let cadenaValida = true;
            const errores = [];
            let prevHuella = null;

            for (const item of result.items || []) {
                if (prevHuella && item.huellaAnterior !== prevHuella) {
                    cadenaValida = false;
                    errores.push({
                        sequenceNumber: item.sequenceNumber,
                        esperado: prevHuella,
                        encontrado: item.huellaAnterior,
                    });
                }
                prevHuella = item.huella;
            }

            return {
                status: "SUCCESS",
                data: {
                    totalRegistros: (result.items || []).length,
                    cadenaValida,
                    errores,
                    primeraHuella: result.items?.[0]?.huella || null,
                    ultimaHuella: result.items?.[result.items.length - 1]?.huella || null,
                },
                error: null,
            };
        } catch (error) {
            log.error("verificarCadenaHash fallo", { traceId, message: error?.message });
            return { status: "ERROR", data: null, error: { code: "VERIFY_FAILED" } };
        }
    }
);

// ============================================================================
// BLOQUE 9 - RECONCILIACION (invocado por cron)
// ============================================================================

export async function reconciliarProyecciones() {
    const traceId = makeTraceId("reconcile");
    const pendientes = await wixData
        .query(COLLECTIONS.MOVIMIENTOS_CAJA)
        .eq("proyeccionEstado", PROYECCION_ESTADO.PENDIENTE)
        .limit(50)
        .find({ suppressAuth: true });

    let procesados = 0;
    let fallidos = 0;

    for (const evento of pendientes.items || []) {
        try {
            await proyectarSegunTipoEvento(evento, evento.proyeccionDetalleIds || [], traceId);
            procesados += 1;
        } catch (err) {
            fallidos += 1;
            log.error("Reconciliacion fallo", {
                traceId,
                eventoId: evento._id,
                message: err?.message,
            });
        }
    }

    return {
        status: "SUCCESS",
        data: { procesados, fallidos, total: (pendientes.items || []).length },
    };
}
