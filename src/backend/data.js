/*
=============================================================================
MODULE: backend/data.js
VERSION: v5009-FISCAL
BASE: v5008.7 + SSOT v5009 + DOSSIER CAJA + DIRECTRICES V19
RESPONSIBILITY: Hooks de inmutabilidad y validacion para Wix Data.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5008.7 (heredados):
  - FIX-50: eliminados hooks EventosSistemaFacturacion (coleccion eliminada).
  - FIX-51: HistoricoCierresZ_beforeUpdate permite update quirurgico UNICAMENTE
            de campos de firma (recovery fiscal).
  - FIX-65: CajaActual_beforeUpdate avisa si se modifica sequenceCounters
            en CAJA_PRINCIPAL (los contadores viven en CAJA_SEQ desde FIX-48).
  - D-01: MovimientosCaja_beforeInsert valida NIF espanol o VAT ID UE.
  - D-02: MovimientosCaja_beforeInsert valida cuadre fiscal segun rolFiscal.
  - D-03: LibroAsientosContablesDetalle_beforeInsert valida cuenta PGC 6 digitos.
  - FIX-FISCAL-04: _isValidNifOrEuVat acepta prefijos VAT UE.

FIXES APLICADOS v5009-FISCAL:
  - D-04: MovimientosCaja_beforeInsert acepta alias AEAT (importeTotal,
          baseImponibleOImporteNoSujeto, cuotaTotal, cuotaRecargoEquivalencia,
          nifDestinatario) manteniendo legacy (totalAmount, taxableAmount,
          taxAmount, importeRecargoEquivalencia, nifTercero).
  - D-05: MovimientosCaja valida tipoEvento, terceroId, catalogoId y
          payloadFiscal cuando schemaVersion = LEDGER_V5_FISCAL.
  - D-06: MovimientosCaja valida F1 exige NIF + nombre + domicilio destinatario.
  - D-07: MovimientosCaja valida inversionSujetoPasivo implica cuotaTotal = 0.
  - D-08: MovimientosCaja valida AJUSTE exige idFacturaAnterior.
  - D-09: Nuevos hooks DatosFiscales_beforeInsert / _beforeUpdate.
  - D-10: Nuevos hooks FacturasRecibidas_beforeInsert.
  - D-11: LibroAsientosContablesDetalle amplia validacion con eventoOrigenId,
          terceroId, catalogoId (solo si schemaVersion = LEDGER_V5_FISCAL).
  - D-12: ServiciosCatalogo valida naturalezaItem y codigoImpuesto obligatorios.
  - D-13: ServiciosCatalogo infiere totalDuration si allowCombine y falta.
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
// HELPERS AEAT - EXTRACCION TOLERANTE DE CAMPOS
// =============================================================================

// [D-04] Resuelve base imponible aceptando alias AEAT y legacy.
function _readBaseImponible(item) {
    const v = item.baseImponibleOImporteNoSujeto ?? item.taxableAmount;
    return Number(v) || 0;
}

// [D-04] Resuelve cuota IVA aceptando alias AEAT y legacy.
function _readCuotaTotal(item) {
    const v = item.cuotaTotal ?? item.taxAmount;
    return Number(v) || 0;
}

// [D-04] Resuelve importe total aceptando alias AEAT y legacy.
function _readImporteTotal(item) {
    const v = item.importeTotal ?? item.totalAmount ?? item.amount;
    return Number(v) || 0;
}

// [D-04] Resuelve cuota RE aceptando alias AEAT y legacy.
function _readCuotaRecargoEquivalencia(item) {
    const v = item.cuotaRecargoEquivalencia ?? item.importeRecargoEquivalencia;
    return Number(v) || 0;
}

// [D-04] Resuelve NIF destinatario aceptando alias AEAT y legacy.
function _readNifDestinatario(item) {
    return _safeTrim(item.nifDestinatario || item.nifTercero);
}

// [D-04] Resuelve nombre destinatario aceptando alias AEAT y legacy.
function _readNombreDestinatario(item) {
    return _safeTrim(item.nombreRazonDestinatario || item.razonSocialTercero);
}

// [D-04] Resuelve tipo factura aceptando alias AEAT y legacy.
function _readTipoFactura(item) {
    return _safeTrim(item.tipoFactura || item.claveRegistroFactura).toUpperCase();
}

// [D-04] Resuelve base desgloseDetallado o desgloseImpuestos.
function _readDesgloseBaseYCuota(item) {
    let base = 0;
    let cuota = 0;

    const desglose =
        item.desgloseDetallado ||
        item.desgloseImpuestos ||
        item.lineItems;

    if (desglose) {
        try {
            const arr = typeof desglose === "string" ? JSON.parse(desglose) : desglose;
            if (Array.isArray(arr) && arr.length > 0) {
                base = arr.reduce(
                    (sum, d) => sum + Number(d.baseImponibleOImporteNoSujeto ?? d.base ?? 0),
                    0
                );
                cuota = arr.reduce(
                    (sum, d) => sum + Number(d.cuotaRepercutida ?? d.cuota ?? 0),
                    0
                );
            }
        } catch (e) {
            _schemaError("desgloseDetallado/desgloseImpuestos no es JSON valido");
        }
    }

    return { base, cuota };
}

// [D-06] Valida requisitos de factura completa F1.
function _validateF1Requirements(item) {
    if (_readTipoFactura(item) !== "F1") return;

    const pf = item.payloadFiscal || {};
    const nif = _readNifDestinatario(item) || _safeTrim(pf.nifDestinatario);
    const nombre = _readNombreDestinatario(item) || _safeTrim(pf.nombreRazonDestinatario);
    const domicilio = item.domicilioDestinatario || pf.domicilioDestinatario || {};

    if (!nif) {
        _schemaError("Factura F1 exige NIF destinatario");
    }
    if (!nombre) {
        _schemaError("Factura F1 exige nombreRazonDestinatario");
    }
    if (!domicilio || !_safeTrim(domicilio.cp)) {
        _schemaError("Factura F1 exige domicilioDestinatario con CP");
    }
}

// [D-07] Valida que ISP implica cuotaTotal = 0.
function _validateISP(item) {
    if (item.inversionSujetoPasivo !== true) return;

    const cuota = _readCuotaTotal(item);
    if (cuota > 0) {
        _schemaError("InversionSujetoPasivo implica cuotaTotal = 0");
    }
}

// [D-08] Valida que AJUSTE exige referencia anterior.
function _validateAjuste(item) {
    if (_safeTrim(item.tipoEvento).toUpperCase() !== "AJUSTE") return;

    if (!_safeTrim(item.idFacturaAnterior)) {
        _schemaError("tipoEvento=AJUSTE exige idFacturaAnterior");
    }
}

// [D-05] Valida requisitos de la capa AEAT cuando schemaVersion = LEDGER_V5_FISCAL.
function _validateFiscalPayload(item) {
    if (!_isV5Fiscal(item)) return;

    const tipoEvento = _safeTrim(item.tipoEvento).toUpperCase();
    if (!tipoEvento || !TIPOS_EVENTO_VALIDOS.has(tipoEvento)) {
        _schemaError("tipoEvento obligatorio y valido (VENTA_LINEA, COMPRA_LINEA, CIERRE_Z, AJUSTE, RECTIFICATIVA, MOV_STOCK)");
    }

    // CIERRE_Z no exige tercero ni catalogo
    if (tipoEvento !== "CIERRE_Z") {
        if (!_isGuid(item.terceroId)) {
            _schemaError("terceroId obligatorio (FK DatosFiscales)");
        }
        if (!item.payloadFiscal || typeof item.payloadFiscal !== "object") {
            _schemaError("payloadFiscal obligatorio (snapshot AEAT)");
        }
    }

    // Catalogo obligatorio en eventos de linea
    if (["VENTA_LINEA", "COMPRA_LINEA", "RECTIFICATIVA", "MOV_STOCK"].includes(tipoEvento)) {
        if (!_isGuid(item.catalogoId)) {
            _schemaError("catalogoId obligatorio (FK ServiciosCatalogo)");
        }
    }

    // Secuencia monotona
    if (!Number.isFinite(Number(item.sequenceNumber)) || Number(item.sequenceNumber) <= 0) {
        _schemaError("sequenceNumber obligatorio (> 0)");
    }

    // Huella obligatoria
    if (!_safeTrim(item.huella)) {
        _schemaError("huella obligatoria (cadena SHA-256)");
    }
}

// =============================================================================
// BLOQUE 1 - MOVIMIENTOS DE CAJA
// =============================================================================

// [D-01, D-02, D-04, D-05, D-06, D-07, D-08]
// Validacion fiscal en insert de MovimientosCaja.
export function MovimientosCaja_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    // [D-01] Validar NIF/VAT del tercero si viene.
    const nif = _readNifDestinatario(item);
    if (nif && !_isValidNifOrEuVat(nif)) {
        _schemaError("nifDestinatario/nifTercero no tiene formato valido (espanol o VAT UE)");
    }

    // [D-02] Validar cuadre fiscal segun rolFiscal.
    const { base, cuota } = _readDesgloseBaseYCuota(item);

    // Si no hay desglose, usar campos planos (legacy o AEAT)
    const baseFinal = base > 0 ? base : _readBaseImponible(item);
    const cuotaFinal = cuota > 0 ? cuota : _readCuotaTotal(item);

    const retencion = Number(item.importeRetencionIRPF) || 0;
    const recargo = _readCuotaRecargoEquivalencia(item);
    const total = _readImporteTotal(item);

    if (baseFinal > 0 || cuotaFinal > 0 || retencion > 0 || recargo > 0) {
        const rolFiscal = _safeTrim(item.rolFiscal).toUpperCase() || ROL_FISCAL.EMISOR;
        const factorRetencion = rolFiscal === ROL_FISCAL.RECEPTOR ? 1 : -1;

        const esperado = _roundItem(baseFinal + cuotaFinal + recargo + factorRetencion * retencion);
        const diff = Math.abs(esperado - total);
        if (diff > 0.02) {
            _schemaError(
                `Cuadre fiscal invalido (rol ${rolFiscal}): base ${baseFinal} + cuota ${cuotaFinal} + recargo ${recargo} ${factorRetencion > 0 ? "+" : "-"} retencion ${retencion} = ${esperado.toFixed(2)}, total ${total.toFixed(2)}`
            );
        }
    }

    // [D-06] F1 exige NIF + nombre + domicilio.
    _validateF1Requirements(item);

    // [D-07] ISP implica cuota 0.
    _validateISP(item);

    // [D-08] AJUSTE exige referencia anterior.
    _validateAjuste(item);

    // [D-05] Validaciones de la capa AEAT v5.
    _validateFiscalPayload(item);

    // Cuadre desgloseDetallado vs cabecera (solo si viene poblado)
    if (Array.isArray(item.desgloseDetallado) && item.desgloseDetallado.length > 0) {
        let sumBase = 0;
        let sumCuota = 0;
        for (const d of item.desgloseDetallado) {
            sumBase += Number(d.baseImponibleOImporteNoSujeto ?? d.base ?? 0);
            sumCuota += Number(d.cuotaRepercutida ?? d.cuota ?? 0);
        }
        if (Math.abs(_roundItem(sumBase) - baseFinal) > 0.02) {
            _schemaError(`desgloseDetallado.base (${sumBase}) no cuadra con cabecera (${baseFinal})`);
        }
        if (Math.abs(_roundItem(sumCuota) - cuotaFinal) > 0.02) {
            _schemaError(`desgloseDetallado.cuota (${sumCuota}) no cuadra con cabecera (${cuotaFinal})`);
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

    // [D-12] Validar naturalezaItem si viene.
    const naturaleza = _safeTrim(item.naturalezaItem).toUpperCase();
    if (naturaleza && !NATURALEZAS_ITEM_VALIDAS.has(naturaleza)) {
        _schemaError("naturalezaItem invalido");
    }

    // [D-12] Validar codigoImpuesto si viene.
    const codigoImpuesto = _safeTrim(item.codigoImpuesto).toUpperCase();
    if (codigoImpuesto && !CODIGOS_IMPUESTO_VALIDOS.has(codigoImpuesto)) {
        _schemaError("codigoImpuesto invalido");
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
    const resourceId = _safeTrim(item.resourceId);
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

    if (email) {
        const existingByEmail = await wixData
            .query(COLLECTIONS.MAPA_STAFF)
            .eq("email", email)
            .ne("_id", itemId)
            .limit(1)
            .find({ suppressAuth: true });

        if (existingByEmail?.items?.length > 0) {
            _schemaError("email duplicado en MapaStaff");
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
// [D-03] Validacion de cuenta PGC en beforeInsert.
// [D-11] Validacion ampliada con eventoOrigenId/terceroId/catalogoId en v5.
// =============================================================================

export function LibroAsientosContablesDetalle_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    // [D-03] Cuenta PGC obligatoria y de 6 digitos (solo si viene).
    const code = _safeTrim(item.cuentaContable || item.accountCode);
    if (code) {
        if (!/^\d{6}$/.test(code)) {
            _schemaError(`cuentaContable "${code}" no tiene formato PGC (6 digitos)`);
        }
    }

    // [D-11] Validaciones de la capa AEAT v5.
    if (_isV5Fiscal(item) || _safeTrim(item.eventoOrigenId)) {
        if (!_isGuid(item.eventoOrigenId)) {
            _schemaError("eventoOrigenId obligatorio (FK MovimientosCaja)");
        }
        if (!_isGuid(item.terceroId)) {
            _schemaError("terceroId obligatorio (FK DatosFiscales)");
        }
        if (!_isGuid(item.catalogoId)) {
            _schemaError("catalogoId obligatorio (FK ServiciosCatalogo)");
        }
        if (!Number.isFinite(Number(item.numeroLinea)) || Number(item.numeroLinea) < 1) {
            _schemaError("numeroLinea >= 1");
        }
        if (!Number.isFinite(Number(item.unidades)) || Number(item.unidades) <= 0) {
            _schemaError("unidades > 0");
        }
        if (!_safeTrim(item.descripcionOperacion)) {
            _schemaError("descripcionOperacion obligatoria en lineas v5");
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

    const nif = _safeTrim(item.nifCif);
    if (!nif || !_isValidNifOrEuVat(nif)) {
        _schemaError("nifCif obligatorio y valido (espanol o VAT UE)");
    }

    if (!_safeTrim(item.razonSocial)) {
        _schemaError("razonSocial obligatoria");
    }

    const tipo = _safeTrim(item.tipoTercero).toUpperCase();
    if (!tipo || !TIPOS_TERCERO_VALIDOS.has(tipo)) {
        _schemaError("tipoTercero invalido (CLIENTE, PROVEEDOR, STAFF, AAPP, MIXTO)");
    }

    // Si es STAFF, exige puentes a Bookings + Members
    if (tipo === "STAFF") {
        if (!_isGuid(item.resourceIdBookings)) {
            _schemaError("tipoTercero=STAFF exige resourceIdBookings GUID");
        }
        if (!_safeTrim(item.staffMemberId)) {
            _schemaError("tipoTercero=STAFF exige staffMemberId");
        }
    }

    return item;
}

export function DatosFiscales_beforeUpdate(item) {
    if (!item || typeof item !== "object") return item;

    const nif = _safeTrim(item.nifCif);
    if (nif && !_isValidNifOrEuVat(nif)) {
        _schemaError("nifCif invalido en update");
    }

    return item;
}

// =============================================================================
// BLOQUE 13 - FACTURAS RECIBIDAS [D-10]
// =============================================================================

export function FacturasRecibidas_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    const nifEmisor = _safeTrim(item.nifEmisor);
    if (!nifEmisor || !_isValidNifOrEuVat(nifEmisor)) {
        _schemaError("FacturasRecibidas requiere nifEmisor valido (espanol o VAT UE)");
    }

    if (!_safeTrim(item.nombreRazonEmisor)) {
        _schemaError("FacturasRecibidas requiere nombreRazonEmisor");
    }

    if (!_isGuid(item.terceroId)) {
        _schemaError("FacturasRecibidas requiere terceroId (FK DatosFiscales)");
    }

    if (!_isGuid(item.eventoOrigenId)) {
        _schemaError("FacturasRecibidas requiere eventoOrigenId (FK MovimientosCaja)");
    }

    const base = Number(item.baseImponibleTotal) || 0;
    const cuota = Number(item.cuotaIvaTotal) || 0;
    const re = Number(item.cuotaRecargoEquivalencia) || 0;
    const ret = Number(item.importeRetencionIRPF) || 0;
    const total = Number(item.importeTotal) || 0;

    if (base || cuota || re || ret || total) {
        const esperado = _roundItem(base + cuota + re - ret);
        if (Math.abs(esperado - total) > 0.02) {
            _schemaError(
                `Factura recibida descuadra: base ${base} + IVA ${cuota} + RE ${re} - ret ${ret} = ${esperado.toFixed(2)}, total ${total.toFixed(2)}`
            );
        }
    }

    // Cuadre desgloseDetallado si viene
    if (Array.isArray(item.desgloseDetallado) && item.desgloseDetallado.length > 0) {
        let sumBase = 0;
        let sumCuota = 0;
        for (const d of item.desgloseDetallado) {
            sumBase += Number(d.baseImponibleOImporteNoSujeto ?? d.base ?? 0);
            sumCuota += Number(d.cuotaRepercutida ?? d.cuota ?? 0);
        }
        if (Math.abs(_roundItem(sumBase) - base) > 0.02) {
            _schemaError("FacturasRecibidas desgloseDetallado.base no cuadra");
        }
        if (Math.abs(_roundItem(sumCuota) - cuota) > 0.02) {
            _schemaError("FacturasRecibidas desgloseDetallado.cuota no cuadra");
        }
    }

    return item;
}

export function FacturasRecibidas_beforeUpdate(item) {
    // No se bloquea el update (permite cambios de estado de pago, adjuntos, etc.)
    // Las validaciones fiscales de identidad no se repiten aqui.
    return item;
}
