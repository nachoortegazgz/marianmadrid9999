/*
=============================================================================
MODULE: backend/data.js
VERSION: v5009-FISCAL-V20
BASE: SSOT CMS v5009-FISCAL-V20 + Matriz de Cambio v5009 → v5009-V20
RESPONSIBILITY: Hooks de inmutabilidad y validacion para Wix Data.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5009-FISCAL-V20:
  - V20-01: Migracion completa de IDs nativas old→new segun Matriz de Cambio.
  - V20-02: Eliminados helpers de traduccion legacy (lectura directa V20).
  - V20-03: Validaciones fiscales usan exclusivamente campos V20.
  - V20-04: Compatibilidad de lectura para datos historicos mantenida.
=============================================================================
*/

import wixData from "wix-data";

import {
    COLLECTIONS,
    EU_VAT_PREFIXES,
    ROL_FISCAL,
    TIPO_EVENTO,
    TIPO_TERCERO,
    NATURALEZA_ITEM,
} from "backend/internalConfig";

import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// CONSTANTES
// =============================================================================

const GUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IMMUTABLE_ENTRY_STATUSES = new Set([
    "POSTED",
    "LOCKED",
]);

const ALLOWED_Z_UPDATE_FIELDS = new Set([
    "closingSignature",
    "closingSignatureStatus",
    "verifiedAt",
    "_updatedDate",
]);

const NIF_LETRAS_DNI = "TRWAGMYFPDXBNJZSQVHLCKE";

const LEDGER_SCHEMA_VERSION_AEAT = "LEDGER_V5_FISCAL";

const TIPOS_TERCERO_VALIDOS = new Set([
    "CLIENTE", "PROVEEDOR", "STAFF", "AAPP", "MIXTO",
]);

const NATURALEZAS_ITEM_VALIDAS = new Set([
    "SERVICIO_PROPIO", "PRODUCTO_VENTA", "PRODUCTO_USO", "GASTO_FIJO",
]);

const CODIGOS_IMPUESTO_VALIDOS = new Set([
    "IVA_21", "IVA_10", "IVA_4", "IVA_0",
    "IRPF_15", "IRPF_19", "EXENTO",
]);

const TIPOS_EVENTO_VALIDOS = new Set([
    "VENTA_LINEA", "COMPRA_LINEA", "CIERRE_Z",
    "AJUSTE", "RECTIFICATIVA", "MOV_STOCK",
]);

// =============================================================================
// HELPERS
// =============================================================================

function _safeTrim(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

function _isGuid(value) {
    return GUID_PATTERN.test(_safeTrim(value));
}

function _isFiniteNonNegative(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0;
}

function _isImmutableStatus(status) {
    return IMMUTABLE_ENTRY_STATUSES.has(_safeTrim(status).toUpperCase());
}

function _schemaError(message) {
    throw new Error(`SCHEMA_VIOLATION: ${message}`);
}

function _fiscalError(message) {
    throw new Error(`FISCAL_VIOLATION: ${message}`);
}

function _roundItem(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

function _isV5Fiscal(item) {
    return _safeTrim(item?.schemaVersion) === LEDGER_SCHEMA_VERSION_AEAT;
}

// =============================================================================
// VALIDACION NIF ESPANOL Y VAT UE
// =============================================================================

function _isValidNifEspanol(nif) {
    const clean = _safeTrim(nif).toUpperCase().replace(/[-\s]/g, "");
    if (!clean || clean.length < 8) return false;

    // DNI: 8 digitos + letra
    if (/^\d{8}[A-Z]$/.test(clean)) {
        const numero = Number(clean.slice(0, 8));
        const letraEsperada = NIF_LETRAS_DNI[numero % 23];
        return clean.charAt(8) === letraEsperada;
    }

    // NIE: X/Y/Z + 7 digitos + letra
    if (/^[XYZ]\d{7}[A-Z]$/.test(clean)) {
        const prefijo = { X: "0", Y: "1", Z: "2" }[clean.charAt(0)];
        const numero = Number(prefijo + clean.slice(1, 8));
        const letraEsperada = NIF_LETRAS_DNI[numero % 23];
        return clean.charAt(8) === letraEsperada;
    }

    // CIF: letra + 7 digitos + digito/letra control
    if (/^[ABCDEFGHJKLMNPQRSUVW]\d{7}[0-9A-J]$/.test(clean)) {
        return true;
    }

    return false;
}

// [FIX-FISCAL-04] Acepta NIF espanol o VAT ID europeo.
function _isValidNifOrEuVat(nif) {
    const clean = _safeTrim(nif).toUpperCase().replace(/[-\s]/g, "");
    if (!clean) return false;

    if (_isValidNifEspanol(clean)) return true;

    if (clean.length >= 8 && clean.length <= 14) {
        const prefix = clean.slice(0, 2);
        if (EU_VAT_PREFIXES.includes(prefix)) {
            const body = clean.slice(2);
            if (/^[A-Z0-9]{5,12}$/.test(body)) return true;
        }
    }

    return false;
}

// =============================================================================
// HELPERS - LECTURA DIRECTA V20 (SIN TRADUCCION LEGACY)
// =============================================================================

// [V20-02] Lectura directa de campos V20. Legacy solo para compatibilidad historica.
function _readBaseImponible(item) {
    const v = item.taxableBaseOrNonSubjectAmount ?? item.taxableBaseOrNonSubjectAmount;
    return Number(v) || 0;
}

// [V20-02] Lectura directa de campos V20.
function _readTaxAmount(item) {
    const v = item.taxAmount ?? item.taxAmount;
    return Number(v) || 0;
}

// [V20-02] Lectura directa de campos V20.
function _readTotalAmount(item) {
    const v = item.totalAmount ?? item.totalAmount ?? item.amount;
    return Number(v) || 0;
}

// [V20-02] Lectura directa de campos V20.
function _readSurchargeAmount(item) {
    const v = item.surchargeAmount ?? item.surchargeAmount;
    return Number(v) || 0;
}

// [V20-02] Lectura directa de campos V20.
function _readRecipientTaxId(item) {
    return _safeTrim(item.recipientTaxId || item.recipientTaxId);
}

// [V20-02] Lectura directa de campos V20.
function _readRecipientLegalName(item) {
    return _safeTrim(item.recipientLegalName || item.recipientLegalName);
}

// [V20-02] Lectura directa de campos V20.
function _readInvoiceType(item) {
    return _safeTrim(item.invoiceType || item.invoiceType).toUpperCase();
}

// [V20-03] Resuelve base desgloseDetallado o desgloseImpuestos con prioridad V20.
function _readDesgloseBaseYCuota(item) {
    let base = 0;
    let cuota = 0;

    const desglose =
        item.detailedBreakdown ||
        item.detailedBreakdown ||
        item.desgloseImpuestos ||
        item.lineItems;

    if (desglose) {
        try {
            const arr = typeof desglose === "string" ? JSON.parse(desglose) : desglose;
            if (Array.isArray(arr) && arr.length > 0) {
                base = arr.reduce(
                    (sum, d) => sum + Number(d.taxableBaseOrNonSubjectAmount ?? d.taxableBaseOrNonSubjectAmount ?? d.base ?? 0),
                    0
                );
                cuota = arr.reduce(
                    (sum, d) => sum + Number(d.chargedTaxAmount ?? d.chargedTaxAmount ?? d.cuota ?? 0),
                    0
                );
            }
        } catch (e) {
            _schemaError("detailedBreakdown/desgloseDetallado/desgloseImpuestos no es JSON valido");
        }
    }

    return { base, cuota };
}

// [V20-03] Valida requisitos de factura completa F1 con campos V20.
function _validateF1Requirements(item) {
    if (_readInvoiceType(item) !== "F1") return;

    const pf = item.fiscalPayload || item.fiscalPayload || {};
    const nif = _readRecipientTaxId(item) || _safeTrim(pf.recipientTaxId || pf.recipientTaxId);
    const nombre = _readRecipientLegalName(item) || _safeTrim(pf.recipientLegalName || pf.recipientLegalName);
    const domicilio = item.recipientAddress || item.recipientAddress || pf.recipientAddress || pf.recipientAddress || {};

    if (!nif) {
        _schemaError("Factura F1 exige recipientTaxId/nifDestinatario");
    }
    if (!nombre) {
        _schemaError("Factura F1 exige recipientLegalName/nombreRazonDestinatario");
    }
    if (!domicilio || !_safeTrim(domicilio.cp)) {
        _schemaError("Factura F1 exige recipientAddress/domicilioDestinatario con CP");
    }
}

// [V20-03] Valida que ISP implica taxAmount = 0 con campos V20.
function _validateISP(item) {
    if (item.reverseCharge !== true && item.reverseCharge !== true) return;

    const cuota = _readTaxAmount(item);
    if (cuota > 0) {
        _schemaError("reverseCharge/inversionSujetoPasivo implica taxAmount/cuotaTotal = 0");
    }
}

// [V20-03] Valida que AJUSTE exige referencia anterior con campos V20.
function _validateAjuste(item) {
    if (_safeTrim(item.eventType || item.eventType).toUpperCase() !== "AJUSTE") return;

    if (!_safeTrim(item.previousInvoiceId || item.previousInvoiceId)) {
        _schemaError("eventType=AJUSTE exige previousInvoiceId/idFacturaAnterior");
    }
}

// [V20-03] Valida requisitos de la capa AEAT con campos V20.
function _validateFiscalPayload(item) {
    if (!_isV5Fiscal(item)) return;

    const tipoEvento = _safeTrim(item.eventType || item.eventType).toUpperCase();
    if (!tipoEvento || !TIPOS_EVENTO_VALIDOS.has(tipoEvento)) {
        _schemaError("eventType/tipoEvento obligatorio y valido (VENTA_LINEA, COMPRA_LINEA, CIERRE_Z, AJUSTE, RECTIFICATIVA, MOV_STOCK)");
    }

    // CIERRE_Z no exige tercero ni catalogo
    if (tipoEvento !== "CIERRE_Z") {
        if (!_isGuid(item.thirdPartyId)) {
            _schemaError("thirdPartyId obligatorio (FK DatosFiscales)");
        }
        const fiscalPayload = item.fiscalPayload || item.fiscalPayload;
        if (!fiscalPayload || typeof fiscalPayload !== "object") {
            _schemaError("fiscalPayload/payloadFiscal obligatorio (snapshot AEAT)");
        }
    }

    // Catalogo obligatorio en eventos de linea
    if (["VENTA_LINEA", "COMPRA_LINEA", "RECTIFICATIVA", "MOV_STOCK"].includes(tipoEvento)) {
        if (!_isGuid(item.catalogId)) {
            _schemaError("catalogId obligatorio (FK ServiciosCatalogo)");
        }
    }

    // Secuencia monotona
    if (!Number.isFinite(Number(item.sequenceNumber)) || Number(item.sequenceNumber) <= 0) {
        _schemaError("sequenceNumber obligatorio (> 0)");
    }

    // Huella obligatoria (V20: recordHash es el campo canonico)
    if (!_safeTrim(item.recordHash || item.recordHash)) {
        _schemaError("recordHash/huella obligatorio (cadena SHA-256)");
    }
}

// =============================================================================
// BLOQUE 1 - MOVIMIENTOS DE CAJA
// =============================================================================

// [V20-03] Validacion fiscal en insert de MovimientosCaja con campos V20.
export function MovimientosCaja_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    // [V20-03] Validar NIF/VAT del tercero si viene (prioridad V20).
    const nif = _readRecipientTaxId(item);
    if (nif && !_isValidNifOrEuVat(nif)) {
        _schemaError("recipientTaxId/nifDestinatario no tiene formato valido (espanol o VAT UE)");
    }

    // [V20-03] Validar cuadre fiscal segun rolFiscal con campos V20.
    const { base, cuota } = _readDesgloseBaseYCuota(item);

    // Si no hay desglose, usar campos planos (prioridad V20)
    const baseFinal = base > 0 ? base : _readBaseImponible(item);
    const cuotaFinal = cuota > 0 ? cuota : _readTaxAmount(item);

    const retencion = Number(item.irpfWithholdingAmount || item.irpfWithholdingAmount) || 0;
    const recargo = _readSurchargeAmount(item);
    const total = _readTotalAmount(item);

    if (baseFinal > 0 || cuotaFinal > 0 || retencion > 0 || recargo > 0) {
        const rolFiscal = _safeTrim(item.fiscalRole || item.rolFiscal).toUpperCase() || ROL_FISCAL.EMISOR;
        const factorRetencion = rolFiscal === ROL_FISCAL.RECEPTOR ? 1 : -1;

        const esperado = _roundItem(baseFinal + cuotaFinal + recargo + factorRetencion * retencion);
        const diff = Math.abs(esperado - total);
        if (diff > 0.02) {
            _schemaError(
                `Cuadre fiscal invalido (rol ${rolFiscal}): base ${baseFinal} + cuota ${cuotaFinal} + recargo ${recargo} ${factorRetencion > 0 ? "+" : "-"} retencion ${retencion} = ${esperado.toFixed(2)}, total ${total.toFixed(2)}`
            );
        }
    }

    // [V20-03] F1 exige recipientTaxId + recipientLegalName + recipientAddress.
    _validateF1Requirements(item);

    // [V20-03] reverseCharge implica taxAmount 0.
    _validateISP(item);

    // [V20-03] AJUSTE exige previousInvoiceId.
    _validateAjuste(item);

    // [V20-03] Validaciones de la capa AEAT v5 con campos V20.
    _validateFiscalPayload(item);

    // Cuadre detailedBreakdown/desgloseDetallado vs cabecera (solo si viene poblado)
    const breakdown = item.detailedBreakdown || item.detailedBreakdown;
    if (Array.isArray(breakdown) && breakdown.length > 0) {
        let sumBase = 0;
        let sumCuota = 0;
        for (const d of breakdown) {
            sumBase += Number(d.taxableBaseOrNonSubjectAmount ?? d.taxableBaseOrNonSubjectAmount ?? d.base ?? 0);
            sumCuota += Number(d.chargedTaxAmount ?? d.chargedTaxAmount ?? d.cuota ?? 0);
        }
        if (Math.abs(_roundItem(sumBase) - baseFinal) > 0.02) {
            _schemaError(`detailedBreakdown/desgloseDetallado.base (${sumBase}) no cuadra con cabecera (${baseFinal})`);
        }
        if (Math.abs(_roundItem(sumCuota) - cuotaFinal) > 0.02) {
            _schemaError(`detailedBreakdown/desgloseDetallado.cuota (${sumCuota}) no cuadra con cabecera (${cuotaFinal})`);
        }
    }

    return item;
}

export function MovimientosCaja_beforeUpdate() {
    _fiscalError(
        "Modificacion de MovimientosCaja prohibida por normativa fiscal (append-only). Use tipoEvento=AJUSTE."
    );
}

export function MovimientosCaja_beforeRemove() {
    _fiscalError(
        "Borrado de MovimientosCaja prohibido por normativa fiscal"
    );
}

// =============================================================================
// BLOQUE 2 - CIERRES Z
// [FIX-51] Update quirurgico permitido solo para campos de firma.
// =============================================================================

export function HistoricoCierresZ_beforeUpdate(item, context) {
    const previous = context?.original || {};
    const changes = Object.keys(item || {}).filter((key) => {
        const before = previous[key];
        const after = item[key];
        return String(before) !== String(after);
    });

    const onlySignatureFields = changes.every((key) =>
        ALLOWED_Z_UPDATE_FIELDS.has(key)
    );

    if (!onlySignatureFields) {
        _fiscalError(
            "Modificacion de HistoricoCierresZ prohibida. Solo se permite actualizar closingSignature/closingSignatureStatus desde recovery."
        );
    }

    return item;
}

export function HistoricoCierresZ_beforeRemove() {
    _fiscalError(
        "Borrado de HistoricoCierresZ prohibido por normativa fiscal"
    );
}

// =============================================================================
// BLOQUE 3 - EVENTOS DEL SISTEMA DE FACTURACION
// [FIX-50] Hooks eliminados. Coleccion EventosSistemaFacturacion fue
// retirada del SSOT en CLEAN-02 de cajas.web.js.
// =============================================================================

// =============================================================================
// BLOQUE 4 - REGISTROS HORARIOS
// =============================================================================

export function RegistrosHorariosStaff_beforeUpdate() {
    _fiscalError(
        "Modificacion de RegistrosHorariosStaff prohibida"
    );
}

export function RegistrosHorariosStaff_beforeRemove() {
    _fiscalError(
        "Borrado de RegistrosHorariosStaff prohibido"
    );
}

// =============================================================================
// BLOQUE 5 - CAJA ACTUAL
// =============================================================================

// [FIX-65] Detectar modificaciones anomalas de sequenceCounters en
// CAJA_PRINCIPAL. Tras FIX-48, los contadores viven en CAJA_SEQ.
export function CajaActual_beforeUpdate(item, context) {
    const previous = context?.original || {};

    const prevSeq = previous?.sequenceCounters;
    const nextSeq = item?.sequenceCounters;

    const changed =
        JSON.stringify(prevSeq || {}) !== JSON.stringify(nextSeq || {});

    if (changed && item?._id !== "CAJA_SEQ") {
        log.warn("CajaActual_beforeUpdate: sequenceCounters modified on non-CAJA_SEQ document", {
            _id: item?._id,
            prev: prevSeq,
            next: nextSeq,
        });
    }

    return item;
}

export function CajaActual_beforeRemove() {
    throw new Error(
        "SINGLETON_PROTECTED: No se puede eliminar el estado de caja"
    );
}

// =============================================================================
// BLOQUE 6 - SERVICIOS CATALOGO
// =============================================================================

export function ServiciosCatalogo_beforeInsert(item) {
    return _validateServiciosCatalogoSchema(item);
}

export function ServiciosCatalogo_beforeUpdate(item) {
    return _validateServiciosCatalogoSchema(item);
}

function _validateServiciosCatalogoSchema(item = {}) {
    const serviceId = _safeTrim(item.serviceId || item._id);

    const linkedPhases = _safeTrim(item.linkedPhases);

    const allowCombine = item.allowCombine === true;

    if (item.serviceId && !_isGuid(item.serviceId)) {
        _schemaError("serviceId debe ser un GUID valido");
    }

    if (allowCombine && !linkedPhases) {
        _schemaError("Servicio dual requiere linkedPhases");
    }

    if (linkedPhases && !_isGuid(linkedPhases)) {
        _schemaError("linkedPhases debe ser un GUID valido");
    }

    if (linkedPhases && linkedPhases === serviceId) {
        _schemaError("linkedPhases no puede referenciar al propio servicio");
    }

    // [V20-03] Validar naturalezaItem si viene (prioridad V20: itemNature).
    const naturaleza = _safeTrim(item.itemNature || item.itemNature).toUpperCase();
    if (naturaleza && !NATURALEZAS_ITEM_VALIDAS.has(naturaleza)) {
        _schemaError("itemNature/naturalezaItem invalido");
    }

    // [V20-03] Validar codigoImpuesto si viene (prioridad V20: taxCode).
    const codigoImpuesto = _safeTrim(item.taxCode || item.taxCode).toUpperCase();
    if (codigoImpuesto && !CODIGOS_IMPUESTO_VALIDOS.has(codigoImpuesto)) {
        _schemaError("taxCode/codigoImpuesto invalido");
    }

    const phase1Duration = Number(item.phase1Duration) || 0;
    const exposureDuration = Number(item.exposureDuration) || 0;
    const phase2Duration = Number(item.phase2Duration) || 0;
    const totalDuration = Number(item.totalDuration) || 0;

    if (
        !_isFiniteNonNegative(phase1Duration) ||
        !_isFiniteNonNegative(exposureDuration) ||
        !_isFiniteNonNegative(phase2Duration) ||
        !_isFiniteNonNegative(totalDuration)
    ) {
        _schemaError("Las duraciones deben ser numeros no negativos");
    }

    // [D-13] Inferir totalDuration si allowCombine y falta.
    if (allowCombine && totalDuration === 0) {
        const inferred = phase1Duration + exposureDuration + phase2Duration;
        if (inferred > 0) {
            item.totalDuration = inferred;
        }
    }

    if (allowCombine && totalDuration > 0) {
        const expectedDuration =
            phase1Duration + exposureDuration + phase2Duration;

        if (
            expectedDuration > 0 &&
            Math.abs(totalDuration - expectedDuration) > 1
        ) {
            _schemaError(
                `totalDuration (${totalDuration}) no coincide con la suma de fases (${expectedDuration})`
            );
        }
    }

    return item;
}

// =============================================================================
// BLOQUE 7 - MAPA STAFF
// =============================================================================

export async function MapaStaff_beforeInsert(item) {
    return _validateMapaStaffUniqueness(item);
}

export async function MapaStaff_beforeUpdate(item) {
    return _validateMapaStaffUniqueness(item);
}

async function _validateMapaStaffUniqueness(item = {}) {
    const itemId = _safeTrim(item._id);
    // [V20-03] resourceId es campo canonico en V20 (sin cambio de nombre)
    const resourceId = _safeTrim(item.resourceId);
    // [V20-03] staffMemberId es campo canonico en V20 (sin cambio de nombre)
    const staffMemberId = _safeTrim(item.staffMemberId);
    const email = _safeTrim(item.email).toLowerCase();

    if (resourceId) {
        if (!_isGuid(resourceId)) {
            _schemaError("resourceId debe ser un GUID valido");
        }

        const existingByResource = await wixData
            .query(COLLECTIONS.MAPA_STAFF)
            .eq("resourceId", resourceId)
            .ne("_id", itemId)
            .limit(1)
            .find({ suppressAuth: true });

        if (existingByResource?.items?.length > 0) {
            _schemaError("resourceId duplicado en MapaStaff");
        }
    }

    if (staffMemberId) {
        const existingByMember = await wixData
            .query(COLLECTIONS.MAPA_STAFF)
            .eq("staffMemberId", staffMemberId)
            .ne("_id", itemId)
            .limit(1)
            .find({ suppressAuth: true });

        if (existingByMember?.items?.length > 0) {
            _schemaError("staffMemberId duplicado en MapaStaff");
        }
    }

    return item;
}

// =============================================================================
// BLOQUE 8 - ASIENTOS CONTABLES
// =============================================================================

export function AsientosContables_beforeUpdate(item) {
    if (_isImmutableStatus(item?.entryStatus)) {
        _fiscalError("No se puede modificar un asiento POSTED o LOCKED");
    }

    return item;
}

export function AsientosContables_beforeRemove(item) {
    if (_isImmutableStatus(item?.entryStatus)) {
        _fiscalError("No se puede eliminar un asiento POSTED o LOCKED");
    }

    return item;
}

// =============================================================================
// BLOQUE 9 - LINEAS DE ASIENTO
// [V20-03] Validacion de cuenta PGC en beforeInsert.
// [V20-03] Validacion ampliada con sourceEventId/thirdPartyId/catalogId en v5.
// =============================================================================

export function LibroAsientosContablesDetalle_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    // [V20-03] Cuenta PGC obligatoria y de 6 digitos (prioridad V20: accountCode).
    const code = _safeTrim(item.accountCode || item.accountCode);
    if (code) {
        if (!/^\d{6}$/.test(code)) {
            _schemaError(`accountCode/cuentaContable "${code}" no tiene formato PGC (6 digitos)`);
        }
    }

    // [V20-03] Validaciones de la capa AEAT v5 con campos V20.
    if (_isV5Fiscal(item) || _safeTrim(item.sourceEventId)) {
        if (!_isGuid(item.sourceEventId)) {
            _schemaError("sourceEventId obligatorio (FK MovimientosCaja)");
        }
        if (!_isGuid(item.thirdPartyId)) {
            _schemaError("thirdPartyId obligatorio (FK DatosFiscales)");
        }
        if (!_isGuid(item.catalogId || item.catalogId)) {
            _schemaError("catalogId obligatorio (FK ServiciosCatalogo)");
        }
        if (!Number.isFinite(Number(item.lineNumber)) || Number(item.lineNumber) < 1) {
            _schemaError("lineNumber/numeroLinea >= 1");
        }
        if (!Number.isFinite(Number(item.units)) || Number(item.units) <= 0) {
            _schemaError("units/unidades > 0");
        }
        if (!_safeTrim(item.operationDescription)) {
            _schemaError("operationDescription/descripcionOperacion obligatoria en lineas v5");
        }
    }

    return item;
}

export async function LibroAsientosContablesDetalle_beforeUpdate(item) {
    return _validateAccountingLineParent(item);
}

export async function LibroAsientosContablesDetalle_beforeRemove(item) {
    return _validateAccountingLineParent(item);
}

export async function LineasAsientoContable_beforeUpdate(item) {
    return _validateAccountingLineParent(item);
}

export async function LineasAsientoContable_beforeRemove(item) {
    return _validateAccountingLineParent(item);
}

async function _validateAccountingLineParent(item = {}) {
    const journalEntryId = _safeTrim(item.journalEntryId);

    if (!journalEntryId) {
        return item;
    }

    const parentEntry = await wixData
        .get(
            COLLECTIONS.ASIENTOS_CONTABLES,
            journalEntryId, { suppressAuth: true }
        )
        .catch(() => null);

    if (
        parentEntry &&
        _isImmutableStatus(parentEntry.entryStatus)
    ) {
        _fiscalError(
            "No se puede modificar o eliminar una linea de asiento POSTED o LOCKED"
        );
    }

    return item;
}

// =============================================================================
// BLOQUE 10 - SECUENCIA DE TICKETS
// =============================================================================

// DEPRECATED: SecuenciaTickets ya no esta en SSOT COLLECTIONS.
// No-op para evitar crash si la coleccion residual existe en CMS.
export async function SecuenciaTickets_beforeUpdate(item) {
    return item;
}

// =============================================================================
// BLOQUE 11 - CIERRES DE INVENTARIO
// =============================================================================

export function InventarioStockVentaCierre_beforeUpdate(item) {
    if (_safeTrim(item?.closingHash)) {
        _fiscalError("No se puede modificar un cierre de inventario firmado");
    }

    return item;
}

export function InventarioStockVentaCierre_beforeRemove(item) {
    if (_safeTrim(item?.closingHash)) {
        _fiscalError("No se puede eliminar un cierre de inventario firmado");
    }

    return item;
}

// =============================================================================
// BLOQUE 12 - DATOS FISCALES [D-09]
// =============================================================================

export function DatosFiscales_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    // [V20-03] NIF obligatorio y valido (prioridad V20: taxId).
    const nif = _safeTrim(item.taxId || item.taxId);
    if (!nif || !_isValidNifOrEuVat(nif)) {
        _schemaError("taxId/nifCif obligatorio y valido (espanol o VAT UE)");
    }

    // [V20-03] razonSocial obligatoria (prioridad V20: legalName).
    if (!_safeTrim(item.legalName || item.legalName)) {
        _schemaError("legalName/razonSocial obligatoria");
    }

    // [V20-03] tipoTercero obligatorio (prioridad V20: thirdPartyType).
    const tipo = _safeTrim(item.thirdPartyType || item.thirdPartyType).toUpperCase();
    if (!tipo || !TIPOS_TERCERO_VALIDOS.has(tipo)) {
        _schemaError("thirdPartyType/tipoTercero invalido (CLIENTE, PROVEEDOR, STAFF, AAPP, MIXTO)");
    }

    // Si es STAFF, exige puentes a Bookings + Members (prioridad V20)
    if (tipo === "STAFF") {
        if (!_isGuid(item.bookingsResourceId || item.bookingsResourceId)) {
            _schemaError("thirdPartyType=STAFF exige bookingsResourceId/resourceIdBookings GUID");
        }
        if (!_safeTrim(item.staffMemberId)) {
            _schemaError("thirdPartyType=STAFF exige staffMemberId");
        }
    }

    return item;
}

export function DatosFiscales_beforeUpdate(item) {
    if (!item || typeof item !== "object") return item;

    // [V20-03] Validar taxId en update si viene.
    const nif = _safeTrim(item.taxId || item.taxId);
    if (nif && !_isValidNifOrEuVat(nif)) {
        _schemaError("taxId/nifCif invalido en update");
    }

    return item;
}

// =============================================================================
// BLOQUE 13 - FACTURAS RECIBIDAS [D-10]
// =============================================================================

export function FacturasRecibidas_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    // [V20-03] nifEmisor obligatorio y valido (prioridad V20: issuerTaxId).
    const nifEmisor = _safeTrim(item.issuerTaxId || item.issuerTaxId);
    if (!nifEmisor || !_isValidNifOrEuVat(nifEmisor)) {
        _schemaError("FacturasRecibidas requiere issuerTaxId/nifEmisor valido (espanol o VAT UE)");
    }

    // [V20-03] nombreRazonEmisor obligatorio (prioridad V20: issuerLegalName).
    if (!_safeTrim(item.issuerLegalName || item.issuerLegalName)) {
        _schemaError("FacturasRecibidas requiere issuerLegalName/nombreRazonEmisor");
    }

    // [V20-03] terceroId obligatorio (prioridad V20: thirdPartyId).
    if (!_isGuid(item.thirdPartyId)) {
        _schemaError("FacturasRecibidas requiere thirdPartyId (FK DatosFiscales)");
    }

    // [V20-03] eventoOrigenId obligatorio (prioridad V20: sourceEventId).
    if (!_isGuid(item.sourceEventId)) {
        _schemaError("FacturasRecibidas requiere sourceEventId (FK MovimientosCaja)");
    }

    // [V20-03] Calculo de cuadre fiscal con prioridad V20.
    const base = Number(item.totalTaxableBase || item.totalTaxableBase) || 0;
    const cuota = Number(item.totalVatAmount || item.totalVatAmount) || 0;
    const re = Number(item.surchargeAmount || item.surchargeAmount) || 0;
    const ret = Number(item.irpfWithholdingAmount || item.irpfWithholdingAmount) || 0;
    const total = Number(item.totalAmount || item.totalAmount) || 0;

    if (base || cuota || re || ret || total) {
        const esperado = _roundItem(base + cuota + re - ret);
        if (Math.abs(esperado - total) > 0.02) {
            _schemaError(
                `Factura recibida descuadra: base ${base} + IVA ${cuota} + RE ${re} - ret ${ret} = ${esperado.toFixed(2)}, total ${total.toFixed(2)}`
            );
        }
    }

    // Cuadre detailedBreakdown/desgloseDetallado si viene (prioridad V20)
    const breakdown = item.detailedBreakdown || item.detailedBreakdown;
    if (Array.isArray(breakdown) && breakdown.length > 0) {
        let sumBase = 0;
        let sumCuota = 0;
        for (const d of breakdown) {
            sumBase += Number(d.taxableBaseOrNonSubjectAmount || d.taxableBaseOrNonSubjectAmount || d.base || 0);
            sumCuota += Number(d.chargedTaxAmount || d.chargedTaxAmount || d.cuota || 0);
        }
        if (Math.abs(_roundItem(sumBase) - base) > 0.02) {
            _schemaError("FacturasRecibidas detailedBreakdown/desgloseDetallado.base no cuadra");
        }
        if (Math.abs(_roundItem(sumCuota) - cuota) > 0.02) {
            _schemaError("FacturasRecibidas detailedBreakdown/desgloseDetallado.cuota no cuadra");
        }
    }

    return item;
}

export function FacturasRecibidas_beforeUpdate(item) {
    // No se bloquea el update (permite cambios de estado de pago, adjuntos, etc.)
    // Las validaciones fiscales de identidad no se repiten aqui.
    return item;
}
