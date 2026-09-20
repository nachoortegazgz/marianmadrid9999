/*
=============================================================================
MODULE: backend/data.js
VERSION: v5008.7-FISCAL
BASE: BIBLIA v5002.5 + ESQUEMA CMS v5002.5 + DOSSIER CAJA
RESPONSIBILITY: Hooks de inmutabilidad y validacion para Wix Data.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5008.7:
  - FIX-50: eliminados hooks EventosSistemaFacturacion (coleccion eliminada).
  - FIX-51: HistoricoCierresZ_beforeUpdate permite update quirurgico UNICAMENTE
            de campos de firma (recovery fiscal).
  - FIX-65: CajaActual_beforeUpdate avisa si se modifica sequenceCounters
            en CAJA_PRINCIPAL (los contadores viven en CAJA_SEQ desde FIX-48).
  - D-01: MovimientosCaja_beforeInsert valida NIF espanol o VAT ID UE.
  - D-02: MovimientosCaja_beforeInsert valida cuadre fiscal segun rolFiscal.
  - D-03: LibroAsientosContablesDetalle_beforeInsert valida cuenta PGC 6 digitos.
  - FIX-FISCAL-04: _isValidNifOrEuVat acepta prefijos VAT UE.
=============================================================================
*/

import wixData from "wix-data";

import {
    COLLECTIONS,
    EU_VAT_PREFIXES,
    ROL_FISCAL,
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
// BLOQUE 1 - MOVIMIENTOS DE CAJA
// =============================================================================

// [D-01, D-02] Validacion fiscal en insert de MovimientosCaja.
export function MovimientosCaja_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    // [D-01] Validar NIF/VAT del tercero si viene.
    const nif = _safeTrim(item.nifTercero);
    if (nif && !_isValidNifOrEuVat(nif)) {
        _schemaError("nifTercero no tiene formato valido (espanol o VAT UE)");
    }

    // [D-02] Validar cuadre fiscal segun rolFiscal.
    const base = Number(item.taxableAmount) || 0;
    const cuota = Number(item.taxAmount) || 0;
    const retencion = Number(item.importeRetencionIRPF) || 0;
    const recargo = Number(item.importeRecargoEquivalencia) || 0;
    const total = Number(item.totalAmount) || 0;

    if (base > 0 || cuota > 0 || retencion > 0 || recargo > 0) {
        const rolFiscal = _safeTrim(item.rolFiscal).toUpperCase() || ROL_FISCAL.EMISOR;
        const factorRetencion = rolFiscal === ROL_FISCAL.RECEPTOR ? 1 : -1;

        const esperado = _roundItem(base + cuota + recargo + factorRetencion * retencion);
        const diff = Math.abs(esperado - total);
        if (diff > 0.02) {
            _schemaError(
                `Cuadre fiscal invalido (rol ${rolFiscal}): base ${base} + cuota ${cuota} + recargo ${recargo} ${factorRetencion > 0 ? "+" : "-"} retencion ${retencion} = ${esperado.toFixed(2)}, total ${total.toFixed(2)}`
            );
        }
    }

    return item;
}

export function MovimientosCaja_beforeUpdate() {
    _fiscalError(
        "Modificacion de MovimientosCaja prohibida por normativa fiscal"
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
    const serviceId = _safeTrim(
        item.serviceId || item._id
    );

    const linkedPhases = _safeTrim(
        item.linkedPhases
    );

    const allowCombine =
        item.allowCombine === true;

    if (item.serviceId && !_isGuid(item.serviceId)) {
        _schemaError(
            "serviceId debe ser un GUID valido"
        );
    }

    if (allowCombine && !linkedPhases) {
        _schemaError(
            "Servicio dual requiere linkedPhases"
        );
    }

    if (linkedPhases && !_isGuid(linkedPhases)) {
        _schemaError(
            "linkedPhases debe ser un GUID valido"
        );
    }

    const phase1Duration =
        Number(item.phase1Duration) || 0;

    const exposureDuration =
        Number(item.exposureDuration) || 0;

    const phase2Duration =
        Number(item.phase2Duration) || 0;

    const totalDuration =
        Number(item.totalDuration) || 0;

    if (
        !_isFiniteNonNegative(phase1Duration) ||
        !_isFiniteNonNegative(exposureDuration) ||
        !_isFiniteNonNegative(phase2Duration) ||
        !_isFiniteNonNegative(totalDuration)
    ) {
        _schemaError(
            "Las duraciones deben ser numeros no negativos"
        );
    }

    if (
        allowCombine &&
        totalDuration > 0
    ) {
        const expectedDuration =
            phase1Duration +
            exposureDuration +
            phase2Duration;

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
            _schemaError(
                "resourceId debe ser un GUID valido"
            );
        }

        const existingByResource = await wixData
            .query(COLLECTIONS.MAPA_STAFF)
            .eq("resourceId", resourceId)
            .ne("_id", itemId)
            .limit(1)
            .find({ suppressAuth: true });

        if (existingByResource?.items?.length > 0) {
            _schemaError(
                "resourceId duplicado en MapaStaff"
            );
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
            _schemaError(
                "staffMemberId duplicado en MapaStaff"
            );
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
            _schemaError(
                "email duplicado en MapaStaff"
            );
        }
    }

    return item;
}

// =============================================================================
// BLOQUE 8 - ASIENTOS CONTABLES
// =============================================================================

export function AsientosContables_beforeUpdate(item) {
    if (_isImmutableStatus(item?.entryStatus)) {
        _fiscalError(
            "No se puede modificar un asiento POSTED o LOCKED"
        );
    }

    return item;
}

export function AsientosContables_beforeRemove(item) {
    if (_isImmutableStatus(item?.entryStatus)) {
        _fiscalError(
            "No se puede eliminar un asiento POSTED o LOCKED"
        );
    }

    return item;
}

// =============================================================================
// BLOQUE 9 - LINEAS DE ASIENTO
// [D-03] Validacion de cuenta PGC en beforeInsert.
// =============================================================================

export function LibroAsientosContablesDetalle_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    const code = _safeTrim(item.accountCode);
    if (!code) {
        _schemaError("accountCode es obligatorio en lineas de asiento");
    }

    if (!/^\d{6}$/.test(code)) {
        _schemaError(`accountCode "${code}" no tiene formato PGC (6 digitos)`);
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
    const journalEntryId = _safeTrim(
        item.journalEntryId
    );

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
        _fiscalError(
            "No se puede modificar un cierre de inventario firmado"
        );
    }

    return item;
}

export function InventarioStockVentaCierre_beforeRemove(item) {
    if (_safeTrim(item?.closingHash)) {
        _fiscalError(
            "No se puede eliminar un cierre de inventario firmado"
        );
    }

    return item;
}
