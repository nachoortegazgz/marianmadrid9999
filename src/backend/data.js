/*
=============================================================================
MODULE: backend/data.js
VERSION: v5008.4-FINAL (hooks SSOT aligned)
BASE: BIBLIA v5002.5 + ESQUEMA CMS v5002.5 + DOSSIER CAJA
RESPONSIBILITY: Hooks de inmutabilidad y validacion para Wix Data.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5008.4:
  - FIX-50: eliminados hooks de EventosSistemaFacturacion (coleccion
            eliminada del SSOT en CLEAN-02 de cajas.web.js).
  - FIX-51: HistoricoCierresZ_beforeUpdate permite actualizacion quirurgica
            UNICAMENTE de campos de firma (closingSignature,
            closingSignatureStatus, verifiedAt, _updatedDate) para que el
            recovery fiscal pueda firmar un cierre persistido sin firma.
            Cualquier otro cambio sigue bloqueado con FISCAL_VIOLATION.
=============================================================================
*/

import wixData from "wix-data";

import { COLLECTIONS } from "backend/internalConfig";

// =============================================================================
// CONSTANTES
// =============================================================================

const GUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IMMUTABLE_ENTRY_STATUSES = new Set([
    "POSTED",
    "LOCKED",
]);

// FIX-51: campos permitidos en update quirurgico de un cierre Z persistido
// sin firma. El recovery fiscal los rellena tras firmar.
const ALLOWED_Z_UPDATE_FIELDS = new Set([
    "closingSignature",
    "closingSignatureStatus",
    "verifiedAt",
    "_updatedDate",
]);

// =============================================================================
// HELPERS
// =============================================================================

function _safeTrim(value) {
    if (value === null || value === undefined) {
        return "";
    }

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
    return IMMUTABLE_ENTRY_STATUSES.has(
        _safeTrim(status).toUpperCase()
    );
}

function _schemaError(message) {
    throw new Error(`SCHEMA_VIOLATION: ${message}`);
}

function _fiscalError(message) {
    throw new Error(`FISCAL_VIOLATION: ${message}`);
}

// =============================================================================
// BLOQUE 1 - MOVIMIENTOS DE CAJA
// =============================================================================

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
// BLOQUE 3 - [FIX-50] HOOKS OBSOLETOS ELIMINADOS
//
// EventosSistemaFacturacion fue eliminada del SSOT (CLEAN-02 en cajas.web.js).
// Los hooks no se ejecutaban porque la coleccion no existe, y contaminaban
// el archivo. Eliminados: EventosSistemaFacturacion_beforeUpdate / _beforeRemove.
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
// =============================================================================

export async function LineasAsientoContable_beforeUpdate(item) {
    return _validateAccountingLineParent(item);
}

export async function LineasAsientoContable_beforeRemove(item) {
    return _validateAccountingLineParent(item);
}

export async function LibroAsientosContablesDetalle_beforeUpdate(item) {
    return _validateAccountingLineParent(item);
}

export async function LibroAsientosContablesDetalle_beforeRemove(item) {
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
// Eliminar cuando se confirme que la coleccion se ha borrado.
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
