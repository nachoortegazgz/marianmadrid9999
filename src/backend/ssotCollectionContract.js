/*
=============================================================================
MODULE: backend/ssotCollectionContract.js
VERSION: v5010-CLEAN
RESPONSIBILITY: Canonical CMS collection contract for new modules.
SOURCE: BIBLIA TECNICA v5009-V20-FINAL-CONSOLIDATED-v4, blocks 3 and 4.
STANDARDS: G10 ASCII Strict, no legacy aliases in new code.
=============================================================================
*/

const ACTIVE_COLLECTION_NAMES = Object.freeze([
    "AlertasOperativas",
    "ProcessedWebhookEvents",
    "AvailabilityDaysCache",
    "BookingsServiceSyncQueue",
    "BookingTransactions",
    "CajaActual",
    "CitasF2",
    "CompensacionesPendientes",
    "ComplementosCatalogo",
    "DatosFiscales",
    "DualSlotCache",
    "HistoricoCierresZ",
    "InventarioStockVenta",
    "M365GraphSyncQueue",
    "MapaStaff",
    "MovimientosCaja",
    "MovimientosInventario",
    "ProveedoresLista",
    "RateLimitBlocks",
    "RegistrosHorariosStaff",
    "ServiciosCatalogo",
    "SlotLocks",
]);

const RETIRED_COLLECTION_NAMES = Object.freeze([
    "AsientosContables",
    "FacturasRecibidas",
    "ConfiguracionFiscal",
]);

const PRESERVED_COLLECTION_NAMES = Object.freeze([
    "LibroAsientosContablesDetalle",
]);

export const SSOT_RECORD_TYPES = Object.freeze({
    FISCAL_SYSTEM_CONFIG: "CONFIG_SISTEMA",
});

export const SSOT_COLLECTIONS = Object.freeze({
    ACTIVE: ACTIVE_COLLECTION_NAMES,
    RETIRED: RETIRED_COLLECTION_NAMES,
    PRESERVED: PRESERVED_COLLECTION_NAMES,
});

function assertUniqueCollectionNames(collectionNames, groupName) {
    const uniqueNames = new Set(collectionNames);
    if (uniqueNames.size !== collectionNames.length) {
        throw new Error(`SSOT_COLLECTION_DUPLICATE: ${groupName}`);
    }
}

assertUniqueCollectionNames(ACTIVE_COLLECTION_NAMES, "ACTIVE");
assertUniqueCollectionNames(RETIRED_COLLECTION_NAMES, "RETIRED");
assertUniqueCollectionNames(PRESERVED_COLLECTION_NAMES, "PRESERVED");

const ACTIVE_SET = new Set(ACTIVE_COLLECTION_NAMES);
const RETIRED_SET = new Set(RETIRED_COLLECTION_NAMES);
const PRESERVED_SET = new Set(PRESERVED_COLLECTION_NAMES);

for (const collectionName of RETIRED_COLLECTION_NAMES) {
    if (ACTIVE_SET.has(collectionName)) {
        throw new Error(`SSOT_COLLECTION_OVERLAP: ${collectionName}`);
    }
}

for (const collectionName of PRESERVED_COLLECTION_NAMES) {
    if (ACTIVE_SET.has(collectionName) || RETIRED_SET.has(collectionName)) {
        throw new Error(`SSOT_COLLECTION_OVERLAP: ${collectionName}`);
    }
}

export function isRetiredCollection(collectionName) {
    return RETIRED_SET.has(String(collectionName || "").trim());
}

export function isSsotCollection(collectionName) {
    return ACTIVE_SET.has(String(collectionName || "").trim());
}

export function isPreservedCollection(collectionName) {
    return PRESERVED_SET.has(String(collectionName || "").trim());
}

export function assertSsotCollection(collectionName) {
    const normalizedName = String(collectionName || "").trim();
    if (isRetiredCollection(normalizedName)) {
        throw new Error(`SSOT_RETIRED_COLLECTION: ${normalizedName}`);
    }
    if (isPreservedCollection(normalizedName)) {
        throw new Error(`SSOT_PRESERVED_COLLECTION: ${normalizedName}`);
    }
    if (!isSsotCollection(normalizedName)) {
        throw new Error(`SSOT_UNKNOWN_COLLECTION: ${normalizedName}`);
    }
    return normalizedName;
}

export function validateSsotCollectionContract() {
    return Object.freeze({
        valid: true,
        activeCount: ACTIVE_COLLECTION_NAMES.length,
        retiredCount: RETIRED_COLLECTION_NAMES.length,
        preservedCount: PRESERVED_COLLECTION_NAMES.length,
        duplicateNames: [],
        overlapNames: [],
    });
}
