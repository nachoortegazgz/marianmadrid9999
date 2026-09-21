/*
=============================================================================
MODULE: backend/internalConfig.js
VERSION: v5009.2-FISCAL-V20.1-AUDIT
BASE: v5009-FISCAL-V20.1 + Correcciones auditoria CFG-01..CFG-20
RESPONSIBILITY: Single Source of Truth (SSOT) for backend configuration.
STANDARDS: G10 ASCII Strict.

CORRECTIONS APPLIED v5009.2 (AUDIT):
  CFG-01..07 [CRITICO]: eliminados TODOS los espacios trailing en
            literales de COLLECTIONS, MOVEMENT_TYPE, BOOKING_FIELDS,
            ACCOUNTING_ACCOUNT, AEAT_INVOICE_TYPE, CORRECTION_REASON,
            EU_VAT_PREFIXES, COMPUTER_SYSTEM.
  CFG-08 [CRITICO]: bloque de aliases deprecated reescrito con JSDoc
            terminado correctamente. El modulo vuelve a compilar.
  CFG-09 [ALTO]: COMPUTER_SYSTEM.producerTaxId/producerLegalName a null.
            Se resuelven en runtime con buildComputerSystem() desde
            ConfiguracionFiscal. Falla explicito si falta el NIF.
  CFG-10 [ALTO]: COLLECTIONS dividido en BUSINESS (SSOT CMS, 15) y
            OPERATIONAL (infraestructura, 15). Total 30 colecciones.
  CFG-11 [ALTO]: anadidos REGIME_KEY, ENTRY_STATUS, BALANCE_NATURE,
            RECONCILIATION_STATUS, SIF_EVENT_TYPE, JOURNEY_TYPE,
            ACCOUNT_NATURE.
  CFG-12 [ALTO]: anadidos CLOSING_TYPE, PACKAGE_STATUS, TAX_CODE,
            COMPENSATION_KIND, COMPENSATION_STATUS, QUEUE_STATUS,
            INVOICE_PAYMENT_STATUS, AEAT_PAYMENT_METHOD, RECEPTION_SOURCE,
            VALIDATION_STATUS, BOOKING_TYPE, CHANNEL_TYPE, RECORD_SOURCE,
            AEAT_SUBMISSION_STATUS, CLOSING_STATUS, CLOCK_RECORD_TYPE,
            CLOCK_REGISTERED_BY, AUDIT_LEVEL, OPERATION_CLASSIFICATION,
            EXEMPT_OPERATION, NON_SUBJECT_REASON, ISSUED_BY.
  CFG-13 [ALTO]: INTEGRITY centraliza LEDGER_SCHEMA_VERSION, GENESIS_HASH,
            ENTRY_SCHEMA_VERSION, INTEGRITY_ALGORITHM_VERSION,
            HASH_ALGORITHM, SIGNATURE_ALGORITHM.
  CFG-14 [ALTO]: FISCAL_LIMITS centraliza umbrales (NIF tercero 300,
            aprobador Z 500, epsilon 0.02, efectivo 1000 Ley 11/2021).
  CFG-15 [MEDIO]: STAFF.IDS marcado @deprecated. El SSOT real es MapaStaff.
  CFG-16 [MEDIO]: STAFF_ACCESS.MARIAN_RESOURCE_ID aliasea
            API.MARIAN_MANAGEMENT_RESOURCE_ID (una sola fuente).
  CFG-17 [MEDIO]: BOOKING_FIELDS ampliado a los 21 campos de CitasF2.
  CFG-18 [MEDIO]: REGIME_KEY fijado a 01..17 (AEAT oficial).
  CFG-19 [BAJO]: validateInternalConfig() comprueba LOCATION_ID y STAFF.
  CFG-20 [BAJO]: validateInternalConfig() detecta espacios en blancos,
            duplicados de valor y enums vacios.

HERENCIA v5009-FISCAL-V20.1:
  V20-01 constantes JS renombradas a ingles.
  V20-02 CITA_FIELDS -> BOOKING_FIELDS.
  V20-03 aliases deprecated al final.
  V20-04 COMPUTER_SYSTEM consolidado.
  V20-05 ACCOUNTING_ACCOUNT keys en ingles.
  v5008.6: FIX-24, FIX-40, FIX-41, I-01..I-03, FIX-FISCAL-02/04.
=============================================================================
*/

// =============================================================================
// BLOQUE 0 - HELPERS DE CONGELACION PROFUNDA
// =============================================================================

function _deepFreeze(target) {
    if (target === null || typeof target !== "object") return target;
    Object.freeze(target);
    for (const value of Object.values(target)) {
        if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
            _deepFreeze(value);
        }
    }
    return target;
}

// =============================================================================
// BLOQUE 1 - STAFF ACTIVO
// [CFG-15] DEPRECADO como fuente de verdad. El SSOT real es MapaStaff.
// =============================================================================

/**
 * @deprecated v5009.2 - Usar backend/staff.js::getAllActiveResourceIds().
 */
export const STAFF = _deepFreeze({
    IDS: Object.freeze([
        "e556070a-6d6a-402e-8422-11133033ea76",
        "07f7344f-e7e4-4c53-854b-47fd82ac8d40",
        "9b905bfd-1a09-485d-9273-a24a20dfe648",
    ]),
    RESOURCE_TO_DISPLAY: Object.freeze({
        "e556070a-6d6a-402e-8422-11133033ea76": "Marian Madrid",
        "07f7344f-e7e4-4c53-854b-47fd82ac8d40": "Andrea",
        "9b905bfd-1a09-485d-9273-a24a20dfe648": "Alba",
    }),
});

// =============================================================================
// BLOQUE 2 - COLECCIONES CMS CANONICAS
// [CFG-01] CERO espacios en blanco.
// [CFG-10] Dividido en BUSINESS (SSOT CMS V20.1, 15) y OPERATIONAL (15).
// =============================================================================

const _BUSINESS_COLLECTIONS = Object.freeze({
    DATOS_FISCALES: "DatosFiscales",
    MAPA_STAFF: "MapaStaff",
    SERVICIOS_CATALOGO: "ServiciosCatalogo",
    COMPLEMENTOS_CATALOGO: "ComplementosCatalogo",
    MOVIMIENTOS_CAJA: "MovimientosCaja",
    ASIENTOS_CONTABLES: "AsientosContables",
    LIBRO_ASIENTOS_CONTABLES_DETALLE: "LibroAsientosContablesDetalle",
    CITAS_F2: "CitasF2",
    FACTURAS_RECIBIDAS: "FacturasRecibidas",
    HISTORICO_CIERRES_Z: "HistoricoCierresZ",
    COMPENSACIONES_PENDIENTES: "CompensacionesPendientes",
    MOVIMIENTOS_INVENTARIO: "MovimientosInventario",
    REGISTROS_HORARIOS_STAFF: "RegistrosHorariosStaff",
    CONFIGURACION_FISCAL: "ConfiguracionFiscal",
    PROVEEDORES_LISTA: "ProveedoresLista",
});

const _OPERATIONAL_COLLECTIONS = Object.freeze({
    ALERTAS_OPERATIVAS: "AlertasOperativas",
    AVAILABILITY_DAYS_CACHE: "AvailabilityDaysCache",
    BOOKINGS_SERVICE_SYNC_QUEUE: "BookingsServiceSyncQueue",
    BOOKING_TRANSACTIONS: "BookingTransactions",
    CAJA_ACTUAL: "CajaActual",
    CATEGORIAS_SERVICIO: "CategoriasServicio",
    DUAL_SLOT_CACHE: "DualSlotCache",
    INVENTARIO_STOCK_VENTA: "InventarioStockVenta",
    M365_GRAPH_SYNC_QUEUE: "M365GraphSyncQueue",
    PLAN_CUENTAS_CONTABLES: "PlanCuentasContables",
    PROCESSED_WEBHOOK_EVENTS: "ProcessedWebhookEvents",
    RATE_LIMIT_BLOCKS: "RateLimitBlocks",
    SLOT_LOCKS: "SlotLocks",
    LIBRO_REGISTRO_FACTURAS_EXPEDIDAS: "LibroRegistroFacturasExpedidas",
    LIBRO_REGISTRO_FACTURAS_RECIBIDAS: "LibroRegistroFacturasRecibidas",
});

export const COLLECTIONS = _deepFreeze({
    ..._BUSINESS_COLLECTIONS,
    ..._OPERATIONAL_COLLECTIONS,
});

export const BUSINESS_COLLECTIONS = _BUSINESS_COLLECTIONS;
export const OPERATIONAL_COLLECTIONS = _OPERATIONAL_COLLECTIONS;

// =============================================================================
// BLOQUE 3 - WIX APP IDS
// =============================================================================

export const APP_IDS = _deepFreeze({
    BOOKINGS: "13d21c63-b5ec-5912-8397-c3a5ddb27a97",
    STORES: "215238eb-22a5-4c36-9e7b-e7c08025e04e",
    EVENTS: "140603ad-af8d-84fb-9004-ee174e35054d",
    FORMS_PAYMENTS: "14ce1214-b278-a7e4-1373-00cebd1bef7c",
    INVOICES: "13ee94c1-b635-8505-3391-97919052c16f",
    MEMBERS_AREA: "14cc59bc-f0b7-15b8-e1c7-89ce41d0e0c9",
    GIFT_CARDS: "d80111c5-a0f4-47a8-b63a-65b54d774a27",
});

// =============================================================================
// BLOQUE 4 - API KEYS Y RECURSOS WIX NATIVOS
// =============================================================================

export const API = _deepFreeze({
    STAFF_RESOURCE_TYPE_ID: "1cd44cf8-756f-41c3-bd90-3e2ffcaf1155",
    MARIAN_MANAGEMENT_RESOURCE_ID: "e556070a-6d6a-402e-8422-11133033ea76",
});

// =============================================================================
// BLOQUE 5 - SINGLETONS PROTEGIDOS
// =============================================================================

export const SINGLETONS = _deepFreeze({
    CAJA: "CAJA_PRINCIPAL",
    CAJA_SEQ: "CAJA_SEQ",
});

// =============================================================================
// BLOQUE 6 - CONFIGURACION GLOBAL DEL SDK
// =============================================================================

export const SDK_CONFIG = _deepFreeze({
    TZ: "Europe/Madrid",
    LOCALE: "es-ES",
    LOCATION_ID: "7a12abfd-bf30-4847-bcdf-00dc573d4802",
    LOCATION_TYPES: Object.freeze({
        TIME_SLOTS: "OWNER_BUSINESS",
        BOOKINGS_WRITER: "OWNER_BUSINESS",
    }),
    TIMEOUTS: Object.freeze({
        API_MS: 15000,
        BOOKING_CREATION_MS: 25000,
        DUAL_BOOKING_MS: 40000,
        CHECKOUT_MS: 20000,
        CMS_MS: 15000,
        WATCHDOG_MS: 30000,
        WEBHOOK_MS: 30000,
        FISCAL_SIGNER_MS: 10000,
    }),
    CACHE: Object.freeze({
        SERVICES_TTL_MS: 600000,
        SLOTS_CACHE_TTL_MS: 120000,
        DUAL_CACHE_TTL_MS: 900000,
        STAFF_TTL_MS: 300000,
        MAX_ENTRIES: 100,
        DAYS_CACHE_VERSION: 1,
        AVAILABILITY_CACHE_TTL_MS: 600000,
        SECRET_CACHE_TTL_MS: 300000,
    }),
    SECURITY: Object.freeze({
        SECRET_CACHE_TTL_MS: 300000,
        RATE_LIMIT_CACHE_CLEANUP_TTL_MS: 60000,
        RATE_LIMIT_CACHE_MAX_ENTRIES: 5000,
        PERSISTENT_BLOCK_THRESHOLD_MULTIPLIER: 3,
        PERSISTENT_BLOCK_DURATION_MS: 3600000,
        WEBHOOK_EVENT_TTL_HOURS: 72,
    }),
    RATE_LIMIT: Object.freeze({
        MAX_REQUESTS: 20,
        WINDOW_MS: 5000,
        BOOKING_MAX_REQUESTS: 5,
        BOOKING_WINDOW_MS: 10000,
        AVAILABILITY_WINDOW_MS: 5000,
        AVAILABILITY_REQUESTER_MAX_REQUESTS: 12,
        AVAILABILITY_GLOBAL_MAX_REQUESTS: 120,
    }),
    JOBS: Object.freeze({
        TIMEOUT_MS: 30000,
        AUDIT_RETENTION_DAYS: 90,
        DELETE_BATCH_SIZE: 100,
        DELETE_MAX_PAGES: 10,
        DUAL_CACHE_CLEANUP_LIMIT: 100,
        FISCAL_RECOVERY_BATCH_SIZE: 25,
        HEALTH_CHECK_QUERY_LIMIT: 1000,
        FISCAL_DAILY_MAX_PAGES: 50,
        BOOKINGS_SERVICE_SYNC_MAX_ATTEMPTS: 5,
        BOOKINGS_SERVICE_SYNC_BATCH_SIZE: 20,
        BOOKINGS_SERVICE_SYNC_BACKOFF_MS: 300000,
        M365_GRAPH_SYNC_BATCH_SIZE: 20,
        M365_GRAPH_SYNC_MAX_ATTEMPTS: 3,
        M365_GRAPH_SYNC_BACKOFF_MS: 300000,
        MAX_BACKOFF_MS: 3600000,
        LEDGER_PAGE_SIZE: 200,
        MAX_LEDGER_BATCH_PAGES: 50,
        CHUNK_PAGE_SIZE: 100,
        STAFF_QUERY_PAGE_SIZE: 100,
    }),
    EVENTS: Object.freeze({
        RETRY_ATTEMPTS: 3,
        RETRY_BASE_BACKOFF_MS: 1000,
    }),
    EXTERNAL_HTTP: Object.freeze({
        RATE_LIMIT_MAX_REQUESTS: 20,
        RATE_LIMIT_WINDOW_MS: 5000,
        HMAC_MAX_CLOCK_SKEW_SECONDS: 60,
        CORS_ALLOWED_ORIGINS: Object.freeze([
            "https://www.marianmadrid.es",
            "https://marianmadrid.es",
        ]),
    }),
    M365: Object.freeze({ ENABLED: false }),
    ACCOUNTING: Object.freeze({ ENABLED: false }),
    DOCUMENTS: Object.freeze({
        DEFAULT_MANAGER_EMAIL: "gestion@marianmadrid.es",
        MAX_EMAIL_ATTACHMENT_BYTES: 3145728,
        MAX_EMAIL_SEND_ATTEMPTS: 3,
    }),
});

// =============================================================================
// BLOQUE 7 - CONCURRENCIA, LOCKS Y TRANSACCIONES
// =============================================================================

export const CONCURRENCY = _deepFreeze({
    MUTEX_TTL_MS: 300000,
    HEARTBEAT_MS: 15000,
    TRANSACTION_POLL_BASE_MS: 250,
    TRANSACTION_MAX_WAIT_MS: 3000,
    LOCK_CLEANUP_GRACE_MS: 60000,
    MAX_COMPENSATION_RETRIES: 3,
    LEDGER_MUTEX_TTL_MS: 45000,
    LOCK_RELEASE_MIN_REMAINING_MS: 15000,
    DEFAULT_DURATION_MIN: 30,
});

// =============================================================================
// BLOQUE 8 - ENUMS DE NEGOCIO
// [CFG-02] CERO espacios en blanco en TODOS los valores.
// =============================================================================

export const TIMECLOCK_TYPE = _deepFreeze({
    ENTRADA: "ENTRADA",
    SALIDA: "SALIDA",
    PAUSA_INICIO: "PAUSA_INICIO",
    PAUSA_FIN: "PAUSA_FIN",
    AJUSTE: "AJUSTE",
});

export const MOVEMENT_TYPE = _deepFreeze({
    VENTA_EFECTIVO: "VENTA_EFECTIVO",
    VENTA_TARJETA: "VENTA_TARJETA",
    VENTA_BIZUM: "VENTA_BIZUM",
    VENTA_ONLINE: "VENTA_ONLINE",
    VENTA_PRODUCTO: "VENTA_PRODUCTO",
    VENTA_PRODUCTO_ONLINE: "VENTA_PRODUCTO_ONLINE",
    VENTA_TARJETA_REGALO: "VENTA_TARJETA_REGALO",
    CANJE_TARJETA_REGALO: "CANJE_TARJETA_REGALO",
    REEMBOLSO: "REEMBOLSO",
    DEVOLUCION_SERVICIO: "DEVOLUCION_SERVICIO",
    DEVOLUCION_PRODUCTO: "DEVOLUCION_PRODUCTO",
    AJUSTE: "AJUSTE",
    PROPINA: "PROPINA",
    APORTE: "APORTE",
    RETIRO: "RETIRO",
    GASTO: "GASTO",
    PAGO_PROVEEDOR: "PAGO_PROVEEDOR",
    ANTICIPO: "ANTICIPO",
    FONDO_INICIAL: "FONDO_INICIAL",
    SERVICIO_PROFESIONAL: "SERVICIO_PROFESIONAL",
});

export const NON_TAXABLE_MOVEMENT_TYPES = Object.freeze([
    MOVEMENT_TYPE.PROPINA,
    MOVEMENT_TYPE.AJUSTE,
    MOVEMENT_TYPE.APORTE,
    MOVEMENT_TYPE.RETIRO,
    MOVEMENT_TYPE.FONDO_INICIAL,
]);

export const NEGATIVE_SIGN_MOVEMENT_TYPES = Object.freeze([
    MOVEMENT_TYPE.REEMBOLSO,
    MOVEMENT_TYPE.DEVOLUCION_SERVICIO,
    MOVEMENT_TYPE.DEVOLUCION_PRODUCTO,
]);

export const PAYMENT_METHOD = _deepFreeze({
    EFECTIVO: "EFECTIVO",
    TARJETA: "TARJETA",
    BIZUM: "BIZUM",
    ONLINE: "ONLINE",
    TARJETA_REGALO: "TARJETA_REGALO",
});

export const AEAT_PAYMENT_METHOD = _deepFreeze({
    EFECTIVO: "01",
    TARJETA: "02",
    TRANSFERENCIA: "03",
    DOMICILIACION: "04",
    OTRO: "05",
});

export const IVA_RATES = _deepFreeze({
    GENERAL: 0.21,
    REDUCIDO: 0.1,
    SUPERREDUCIDO: 0.04,
    EXENTO: 0,
});

export const CASH_REGISTER_STATUS = _deepFreeze({
    OPEN: "ABIERTA",
    CLOSED: "CERRADA",
});

export const BOOKING_STATUS = _deepFreeze({
    CONFIRMED: "CONFIRMED",
    PENDING_PAYMENT: "PENDING_PAYMENT",
    CANCELLED: "CANCELLED",
    CANCELED: "CANCELLED",
    REFUNDED: "REFUNDED",
    DECLINED: "DECLINED",
});

export const INACTIVE_BOOKING_STATUSES = Object.freeze([
    BOOKING_STATUS.CANCELLED,
    BOOKING_STATUS.DECLINED,
    BOOKING_STATUS.REFUNDED,
]);

export const PAYMENT_STATUS = _deepFreeze({
    UNPAID: "UNPAID",
    NOT_PAID: "NOT_PAID",
    PENDING_PAYMENT: "PENDING_PAYMENT",
    PENDING_LEDGER: "PENDING_LEDGER",
    PAID: "PAID",
    REFUNDED: "REFUNDED",
    PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
});

export const COLLABORATOR_ROLES = _deepFreeze({
    ADMIN: "ADMIN",
    GESTION: "GESTION",
    ESTILISTA: "ESTILISTA",
});

export const BOOKING_TYPE = _deepFreeze({
    SIMPLE: "SIMPLE",
    DUAL_F1: "DUAL_F1",
    DUAL_F2: "DUAL_F2",
});

export const CHANNEL_TYPE = _deepFreeze({
    POS: "POS",
    ONLINE: "ONLINE",
    CAJA_LOCAL: "CAJA_LOCAL",
    TELEFONO: "TELEFONO",
});

export const RECORD_SOURCE = _deepFreeze({
    INTERNAL: "INTERNAL",
    POS: "POS",
    WIX_ECOM: "WIX_ECOM",
    WIX_BOOKINGS: "WIX_BOOKINGS",
    CRON: "CRON",
    MANUAL: "MANUAL",
    CRON_FISCAL_RECOVERY: "CRON_FISCAL_RECOVERY",
    WIX_ECOM_PAYMENT_CONFIRM: "WIX_ECOM_PAYMENT_CONFIRM",
    WIX_ECOM_PAYMENT_WEBHOOK: "WIX_ECOM_PAYMENT_WEBHOOK",
    WIX_ECOM_REFUND_WEBHOOK: "WIX_ECOM_REFUND_WEBHOOK",
    WIX_BOOKINGS_CANCEL_WEBHOOK: "WIX_BOOKINGS_CANCEL_WEBHOOK",
});

// =============================================================================
// BLOQUE 9 - CATALOGO Y BUSQUEDA DE SLOTS
// =============================================================================

export const CATALOG_CONFIG = _deepFreeze({
    STATES: Object.freeze({
        ACTIVO: "ACTIVO",
        INACTIVO: "INACTIVO",
        BORRADOR: "BORRADOR",
    }),
    CURRENCY: "EUR",
    MAX_TITLE_LENGTH: 160,
    MAX_SUMMARY_LENGTH: 120,
    MAX_DESCRIPTION_LENGTH: 6000,
    MAX_DURATION_MINUTES: 1440,
    MAX_ADDONS_PER_SERVICE: 5,
});

export const SLOT_SEARCH = _deepFreeze({
    DIAS_LIMITE: 14,
    TOLERANCE_MINUTES: 10,
    MAX_DUAL_GAP_MINUTES: 120,
});

export const BOOKINGS_ADDON_CONFIG = _deepFreeze({
    MAX_PER_BOOKING: 5,
    ACTIVE_NATIVE_IDS: Object.freeze([]),
});

// =============================================================================
// BLOQUE 10 - JWT Y SEGURIDAD
// =============================================================================

export const JWT = _deepFreeze({
    ALGORITHM: "HS256",
    EXPIRATION_MS: 1800000,
});

// =============================================================================
// BLOQUE 11 - CAMPOS DE CITAS_F2
// [CFG-05] CERO espacios. [CFG-17] Ampliado a los 21 campos de SSOT CMS 8.
// =============================================================================

export const BOOKING_FIELDS = _deepFreeze({
    ID: "_id",
    BOOKING_ID: "bookingId",
    PAIR_TOKEN: "pairToken",
    REVISION: "revision",
    SERVICE_ID: "serviceId",
    SCHEDULE_ID: "scheduleId",
    RESOURCE_ID: "resourceId",
    STAFF_RESOURCE_ID: "staffResourceId",
    START_DATE: "startDate",
    END_DATE: "endDate",
    DATE_YMD: "dateYmd",
    BOOKING_TYPE: "bookingType",
    STATUS: "status",
    PAYMENT_STATUS: "paymentStatus",
    META: "meta",
    CONTACT_DETAILS: "contactDetails",
    THIRD_PARTY_ID: "thirdPartyId",
    CATALOG_ID: "catalogId",
    SOURCE_EVENT_ID: "sourceEventId",
    FISCAL_DATA: "fiscalData",
    CASH_MOVEMENT_ID: "cashMovementId",
    INVOICING_DATE: "invoicingDate",
    TRACE_ID: "traceId",
});

// =============================================================================
// BLOQUE 12 - ACCESO Y ROLES
// [CFG-16] MARIAN_RESOURCE_ID aliasea API.MARIAN_MANAGEMENT_RESOURCE_ID.
// =============================================================================

export const STAFF_ACCESS = _deepFreeze({
    ALLOWED_ROLES: Object.freeze([
        COLLABORATOR_ROLES.ADMIN,
        COLLABORATOR_ROLES.GESTION,
        COLLABORATOR_ROLES.ESTILISTA,
    ]),
    MARIAN_RESOURCE_ID: API.MARIAN_MANAGEMENT_RESOURCE_ID,
    CAJERO_ROLES: Object.freeze([
        COLLABORATOR_ROLES.ADMIN,
        COLLABORATOR_ROLES.GESTION,
    ]),
    ADMIN_ROLES: Object.freeze([COLLABORATOR_ROLES.ADMIN]),
});

// =============================================================================
// BLOQUE 13 - DINERO Y TEXTO POR DEFECTO
// =============================================================================

export const CURRENCY_CONFIG = _deepFreeze({
    DISPLAY_CURRENCY: "EUR",
    DECIMALS: 2,
    LOCALE: "es-ES",
});

export const STAFF_DEFAULT_NAME = "Profesional";

// =============================================================================
// BLOQUE 14 - VALIDACION DE ADDONS NATIVOS
// =============================================================================

const GUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PATTERNS = _deepFreeze({
    GUID: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    PGC_ACCOUNT_CODE: "^\\d{6}$",
    DATE_YMD: "^\\d{4}-\\d{2}-\\d{2}$",
    FISCAL_PERIOD: "^\\d{4}-\\d{2}$",
    HEX_64: "^[0-9a-f]{64}$",
    INVOICE_NUMBER: "^FAC-\\d{4}-\\d{5}$",
});

export function isValidGuid(value) {
    return typeof value === "string" && GUID_PATTERN.test(value.trim());
}

export function validateActiveNativeAddonIds() {
    const ids = BOOKINGS_ADDON_CONFIG.ACTIVE_NATIVE_IDS;
    const invalidIds = [];
    for (const id of ids) {
        if (!isValidGuid(id)) invalidIds.push(String(id));
    }
    return {
        valid: invalidIds.length === 0,
        invalidIds: invalidIds,
        count: ids.length,
        isEmpty: ids.length === 0,
    };
}

// =============================================================================
// BLOQUE 15 - CUENTAS PGC (RD 1514/2007)
// [CFG-03] CERO espacios. data.js valida /^\d{6}$/.
// =============================================================================

export const ACCOUNTING_ACCOUNT = _deepFreeze({
    CASH: "570000",
    BANKS: "572000",
    SERVICE_REVENUE: "705000",
    VAT_OUTPUT: "477000",
    VAT_INPUT: "472000",
    SALES_RETURNS: "708000",
    SUPPLIERS: "400000",
    PURCHASES_EXPENSES: "600000",
    SUSPENSE: "555000",
    TAX_IRPF_WITHHOLDING_PAYABLE: "475100",
    TAX_IRPF_WITHHOLDING_RECEIVABLE: "473000",
    TAX_EQUIVALENCE_SURCHARGE: "475800",
    CUSTOMER_ADVANCES: "438000",
    INVENTORY: "300000",
    VAT_PENDING_SETTLEMENT: "475000",
    CUSTOMERS: "430000",
});

export const ACCOUNTING_ACCOUNT_NAME = _deepFreeze({
    CASH: "Caja",
    BANKS: "Bancos",
    SERVICE_REVENUE: "Prestaciones de servicios",
    VAT_OUTPUT: "Hacienda Publica IVA repercutido",
    VAT_INPUT: "Hacienda Publica IVA soportado",
    SALES_RETURNS: "Devoluciones de ventas",
    SUPPLIERS: "Proveedores",
    PURCHASES_EXPENSES: "Compras y gastos",
    SUSPENSE: "Partidas pendientes de aplicacion",
    TAX_IRPF_WITHHOLDING_PAYABLE: "H.P. Retenciones IRPF a ingresar",
    TAX_IRPF_WITHHOLDING_RECEIVABLE: "H.P. Retenciones IRPF a favor",
    TAX_EQUIVALENCE_SURCHARGE: "H.P. Recargo de equivalencia",
    CUSTOMER_ADVANCES: "Anticipos de clientes",
    INVENTORY: "Existencias mercaderias",
    VAT_PENDING_SETTLEMENT: "H.P. IVA pendiente de liquidacion",
    CUSTOMERS: "Clientes",
});

export const ENTRY_STATUS = _deepFreeze({
    CONFIRMADO: "CONFIRMADO",
    POSTED: "POSTED",
    LOCKED: "LOCKED",
});

export const IMMUTABLE_ENTRY_STATUSES = Object.freeze([
    ENTRY_STATUS.POSTED,
    ENTRY_STATUS.LOCKED,
]);

export const ACCOUNT_NATURE = _deepFreeze({
    ACTIVO: "ACTIVO",
    PASIVO: "PASIVO",
    INGRESO: "INGRESO",
    GASTO: "GASTO",
});

export const BALANCE_NATURE = _deepFreeze({
    DEUDOR: "DEUDOR",
    ACREEDOR: "ACREEDOR",
});

// =============================================================================
// BLOQUE 16 - TIPOS DE FACTURA AEAT (RD 1619/2012 art. 4)
// [CFG-06] CERO espacios.
// =============================================================================

export const AEAT_INVOICE_TYPE = _deepFreeze({
    F1: "F1",
    F2: "F2",
    F3: "F3",
    R1: "R1",
    R2: "R2",
    R3: "R3",
    R4: "R4",
    R5: "R5",
});

export const CORRECTION_TYPE = _deepFreeze({
    POR_DIFERENCIAS: "S",
    POR_FACTURA_RECTIFICATIVA: "I",
});

// =============================================================================
// BLOQUE 17 - MOTIVOS DE RECTIFICACION (Anexo IV codigo 25)
// [CFG-06] CERO espacios.
// =============================================================================

export const CORRECTION_REASON = _deepFreeze({
    NUMERO_SERIE: "01",
    SERIE: "02",
    BASE_IMPONIBLE: "03",
    CUOTA: "04",
    FECHA: "05",
    IDENTIFICACION: "06",
    DESCUENTO: "07",
    DESTINATARIO: "08",
    OTRAS: "09",
});

// =============================================================================
// BLOQUE 18 - TIPOS DE RETENCION IRPF
// =============================================================================

export const IRPF_WITHHOLDING_RATE = _deepFreeze({
    PROFESIONALES_GENERAL: 0.15,
    PROFESIONALES_PRIMEROS_3_ANOS: 0.07,
    MODULOS: 0.01,
    NINGUNA: 0,
});

// =============================================================================
// BLOQUE 19 - ESTADOS DE DEVENGO IVA
// =============================================================================

export const VAT_ACCRUAL_STATUS = _deepFreeze({
    DEVENGADO: "DEVENGADO",
    ANTICIPADO: "ANTICIPADO",
    APLICACION_ANTICIPO: "APLICACION_ANTICIPO",
});

// =============================================================================
// BLOQUE 20 - ROL FISCAL
// =============================================================================

export const FISCAL_ROLE = _deepFreeze({
    EMISOR: "EMISOR",
    RECEPTOR: "RECEPTOR",
});

export function resolveWithholdingAccount(fiscalRole) {
    const role = String(fiscalRole === null || fiscalRole === undefined
        ? FISCAL_ROLE.EMISOR
        : fiscalRole).trim().toUpperCase();
    return role === FISCAL_ROLE.RECEPTOR
        ? {
            code: ACCOUNTING_ACCOUNT.TAX_IRPF_WITHHOLDING_RECEIVABLE,
            name: ACCOUNTING_ACCOUNT_NAME.TAX_IRPF_WITHHOLDING_RECEIVABLE,
        }
        : {
            code: ACCOUNTING_ACCOUNT.TAX_IRPF_WITHHOLDING_PAYABLE,
            name: ACCOUNTING_ACCOUNT_NAME.TAX_IRPF_WITHHOLDING_PAYABLE,
        };
}

// =============================================================================
// BLOQUE 21 - PREFIJOS VAT UE
// [CFG-04] CERO espacios.
// =============================================================================

export const EU_VAT_PREFIXES = Object.freeze([
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES",
    "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT",
    "NL", "PL", "PT", "RO", "SE", "SI", "SK", "XI",
]);

// =============================================================================
// BLOQUE 22 - TIPOS DE EVENTO
// =============================================================================

export const EVENT_TYPE = _deepFreeze({
    VENTA_LINEA: "VENTA_LINEA",
    COMPRA_LINEA: "COMPRA_LINEA",
    CIERRE_Z: "CIERRE_Z",
    AJUSTE: "AJUSTE",
    RECTIFICATIVA: "RECTIFICATIVA",
    MOV_STOCK: "MOV_STOCK",
});

export const EVENT_TYPES_REQUIRING_CATALOG = Object.freeze([
    EVENT_TYPE.VENTA_LINEA,
    EVENT_TYPE.COMPRA_LINEA,
    EVENT_TYPE.RECTIFICATIVA,
    EVENT_TYPE.MOV_STOCK,
]);

export const SIF_EVENT_TYPE = _deepFreeze({
    INICIO_OPERACIONES: "INICIO_OPERACIONES",
    ALTA_FACTURA: "ALTA_FACTURA",
    ANULACION_FACTURA: "ANULACION_FACTURA",
    CIERRE_OPERACIONES: "CIERRE_OPERACIONES",
});

// =============================================================================
// BLOQUE 23 - NATURALEZA DE ITEM
// =============================================================================

export const ITEM_NATURE = _deepFreeze({
    SERVICIO_PROPIO: "SERVICIO_PROPIO",
    PRODUCTO_VENTA: "PRODUCTO_VENTA",
    PRODUCTO_USO: "PRODUCTO_USO",
    GASTO_FIJO: "GASTO_FIJO",
});

// =============================================================================
// BLOQUE 24 - TIPO DE TERCERO
// =============================================================================

export const THIRD_PARTY_TYPE = _deepFreeze({
    CLIENTE: "CLIENTE",
    PROVEEDOR: "PROVEEDOR",
    STAFF: "STAFF",
    AAPP: "AAPP",
    MIXTO: "MIXTO",
});

// =============================================================================
// BLOQUE 25 - ESTADO DE PROYECCION
// =============================================================================

export const PROJECTION_STATUS = _deepFreeze({
    PENDIENTE: "PENDIENTE",
    OK: "OK",
    ERROR: "ERROR",
});

// =============================================================================
// BLOQUE 26 - SISTEMA INFORMATICO
// [CFG-07] CERO espacios.
// [CFG-09] producerTaxId y producerLegalName a null.
// =============================================================================

export const COMPUTER_SYSTEM = _deepFreeze({
    computerSystemName: "Marian Madrid Velo",
    computerSystemId: "MM-VELO-001",
    version: "v5009.2",
    installationNumber: "1",
    possibleUseOnlyVerifactu: "S",
    possibleUseMultiOT: "N",
    multipleOTIndicator: "N",
    producerTaxId: null,
    producerLegalName: null,
});

export function buildComputerSystem(fiscalConfig) {
    const cfg = fiscalConfig && typeof fiscalConfig === "object" ? fiscalConfig : {};
    const producerTaxId = String(
        cfg.producerTaxId || cfg.businessTaxId || cfg.nifProductor || ""
    ).trim().toUpperCase();
    if (!producerTaxId) {
        throw new Error(
            "COMPUTER_SYSTEM_PRODUCER_TAX_ID_MISSING: " +
            "ConfiguracionFiscal.producerTaxId es obligatorio"
        );
    }
    const producerLegalName = String(
        cfg.producerLegalName || cfg.nombreRazonProductor || ""
    ).trim();
    if (!producerLegalName) {
        throw new Error(
            "COMPUTER_SYSTEM_PRODUCER_LEGAL_NAME_MISSING: " +
            "ConfiguracionFiscal.producerLegalName es obligatorio"
        );
    }
    return Object.freeze({
        computerSystemName: _clean(cfg.computerSystem?.computerSystemName || COMPUTER_SYSTEM.computerSystemName, 100),
        computerSystemId: _clean(cfg.computerSystemId || COMPUTER_SYSTEM.computerSystemId, 60),
        version: _clean(cfg.version || COMPUTER_SYSTEM.version, 40),
        installationNumber: _clean(String(cfg.installationNumber || COMPUTER_SYSTEM.installationNumber), 20),
        possibleUseOnlyVerifactu: _yesNo(cfg.possibleUseOnlyVerifactu, COMPUTER_SYSTEM.possibleUseOnlyVerifactu),
        possibleUseMultiOT: _yesNo(cfg.possibleUseMultiOT, COMPUTER_SYSTEM.possibleUseMultiOT),
        multipleOTIndicator: _yesNo(cfg.multipleOTIndicator, COMPUTER_SYSTEM.multipleOTIndicator),
        producerTaxId: producerTaxId,
        producerLegalName: producerLegalName,
    });
}

function _clean(value, maxLength) {
    const raw = String(value === null || value === undefined ? "" : value).trim();
    return raw.slice(0, Math.max(1, Number(maxLength) || 100));
}

function _yesNo(value, fallback) {
    const raw = String(value === null || value === undefined ? "" : value).trim().toUpperCase();
    return raw === "S" || raw === "N" ? raw : fallback;
}

// =============================================================================
// BLOQUE 27 - ENUMS AEAT ADICIONALES
// [CFG-11] [CFG-12] [CFG-18]
// =============================================================================

export const REGIME_KEY = _deepFreeze({
    OPERACION_REGIMEN_GENERAL: "01",
    EXPORTACION: "02",
    REGIMEN_ESPECIAL_BIENES_USADOS: "03",
    REGIMEN_ESPECIAL_ORO: "04",
    REGIMEN_ESPECIAL_AGENCIA_VIAJES: "05",
    REGIMEN_ESPECIAL_GRUPO_ENTIDADES: "06",
    REGIMEN_ESPECIAL_CRITERIO_CAJA: "07",
    OPERACIONES_SUJETAS_IPSI_IGIC: "08",
    FACTURACION_PRESTACION_SERVICIOS_AGENCIA_VIAJES: "09",
    COBRANZA_POR_CUENTA_DE_TERCEROS: "10",
    ARRENDAMIENTO_LOCAL_NEGOCIO: "11",
    ARRENDAMIENTO_LOCAL_NEGOCIO_SUJETO_RETENCION: "12",
    ARRENDAMIENTO_LOCAL_NEGOCIO_NO_SUJETO_RETENCION: "13",
    FACTURA_CON_IVA_PENDIENTE_DE_DEVENGO: "14",
    FACTURA_CON_IVA_PENDIENTE_DE_DEVENGO_CERTIFICACION_OBRA: "15",
    REGIMEN_OPERADOR_ESTABLECIDO_SEDE_PERMANENTE: "16",
    REGIMEN_SIMPLIFICADO: "17",
});

export const OPERATION_CLASSIFICATION = _deepFreeze({
    SUJETA_NO_EXENTA: "S1",
    SUJETA_EXENTA: "S2",
    NO_SUJETA_ARTICULO_7_14: "N1",
    NO_SUJETA_OTROS: "N2",
});

export const EXEMPT_OPERATION = _deepFreeze({
    E1: "E1",
    E2: "E2",
    E3: "E3",
    E4: "E4",
    E5: "E5",
    E6: "E6",
});

export const NON_SUBJECT_REASON = _deepFreeze({
    N1: "N1",
    N2: "N2",
});

export const ISSUED_BY = _deepFreeze({
    EMISOR: "E",
    DESTINATARIO: "D",
    TERCERO: "T",
});

export const AEAT_SUBMISSION_STATUS = _deepFreeze({
    PENDIENTE: "PENDIENTE",
    ENVIADO: "ENVIADO",
    ACEPTADO: "ACEPTADO",
    RECHAZADO: "RECHAZADO",
    ANULADO: "ANULADO",
});

export const RECONCILIATION_STATUS = _deepFreeze({
    PENDIENTE: "PENDIENTE",
    CONCILIADO: "CONCILIADO",
});

export const TAX_CODE = _deepFreeze({
    IVA_21: "IVA_21",
    IVA_10: "IVA_10",
    IVA_4: "IVA_4",
    IVA_0: "IVA_0",
    IRPF_15: "IRPF_15",
    IRPF_19: "IRPF_19",
    EXENTO: "EXENTO",
});

// =============================================================================
// BLOQUE 28 - LIMITES Y UMBRALES FISCALES
// [CFG-14] Centralizados.
// =============================================================================

export const FISCAL_LIMITS = _deepFreeze({
    CASH_PAYMENT_MAX_EUR: 1000,
    NIF_REQUIRED_THRESHOLD_EUR: 300,
    Z_CLOSING_APPROVER_THRESHOLD_EUR: 500,
    MONEY_EPSILON: 0.02,
    ACCOUNTING_EPSILON: 0.005,
    MAX_TAX_ID_LENGTH: 20,
    MAX_LEGAL_NAME_LENGTH: 200,
    MAX_BANK_REFERENCE_LENGTH: 60,
    MAX_ADVANCE_ID_LENGTH: 120,
    MAX_PREVIOUS_INVOICE_ID_LENGTH: 120,
    MAX_CORRECTION_REASON_LENGTH: 4,
    MAX_OPERATION_DESCRIPTION_LENGTH: 500,
});

// =============================================================================
// BLOQUE 29 - INTEGRIDAD Y VERSIONADO DE ESQUEMAS
// [CFG-13] Centralizado.
// =============================================================================

export const INTEGRITY = _deepFreeze({
    LEDGER_SCHEMA_VERSION: "LEDGER_V5_FISCAL",
    ENTRY_SCHEMA_VERSION: "ASIENTO_V3_FISCAL",
    HASH_ALGORITHM: "SHA-256",
    SIGNATURE_ALGORITHM: "RSASSA-PKCS1-v1_5-SHA-256",
    INTEGRITY_ALGORITHM_VERSION: "HMAC_SHA256_V1",
    GENESIS_HASH: "0000000000000000000000000000000000000000000000000000000000000000",
    INVOICE_NUMBER_PREFIX: "FAC",
    INVOICE_NUMBER_PADDING: 5,
    RECEPTION_NUMBER_PREFIX: "FR",
});

export function buildInvoiceNumber(year, yearSequence) {
    const y = Number(year) || new Date().getFullYear();
    const seq = Math.max(0, Number(yearSequence) || 0);
    const pad = INTEGRITY.INVOICE_NUMBER_PADDING;
    return INTEGRITY.INVOICE_NUMBER_PREFIX + "-" + String(y) + "-" + String(seq).padStart(pad, "0");
}

// =============================================================================
// BLOQUE 30 - COLAS, COMPENSACIONES Y CIERRES
// [CFG-12] Centralizado.
// =============================================================================

export const QUEUE_STATUS = _deepFreeze({
    PENDING: "PENDING",
    PROCESSING: "PROCESSING",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    RETRY: "RETRY",
});

export const COMPENSATION_KIND = _deepFreeze({
    FISCAL_LEDGER: "FISCAL_LEDGER",
    BOOKING_ROLLBACK: "BOOKING_ROLLBACK",
    PAYMENT_RECOVERY: "PAYMENT_RECOVERY",
    CANCEL_BOOKING: "CANCEL_BOOKING",
    RESYNC_LEDGER_ACCOUNTING: "RESYNC_LEDGER_ACCOUNTING",
    RESYNC_CAJA_BALANCE: "RESYNC_CAJA_BALANCE",
});

export const COMPENSATION_STATUS = _deepFreeze({
    PENDING: "PENDING",
    PENDING_RECOVERY: "PENDING_RECOVERY",
    PROCESSING: "PROCESSING",
    FAILED: "FAILED",
    COMPLETED: "COMPLETED",
    RETRYING: "RETRYING",
});

export const COMPENSATION_RETRIABLE_STATUSES = Object.freeze([
    COMPENSATION_STATUS.PENDING,
    COMPENSATION_STATUS.RETRYING,
    COMPENSATION_STATUS.PENDING_RECOVERY,
]);

export const COMPENSATION_PHASE = _deepFreeze({
    WAIT_FOR_SIGNER: "WAIT_FOR_SIGNER",
    WAIT_FOR_SIGNER_Z_CLOSING: "WAIT_FOR_SIGNER_Z_CLOSING",
    WAIT_FOR_ACCOUNTING_RESYNC: "WAIT_FOR_ACCOUNTING_RESYNC",
    WAIT_FOR_CAJA_RESYNC: "WAIT_FOR_CAJA_RESYNC",
    WAIT_FOR_ORIGINAL_ORDER_LEDGER: "WAIT_FOR_ORIGINAL_ORDER_LEDGER",
    UNKNOWN: "UNKNOWN",
});

export const CLOSING_TYPE = _deepFreeze({
    ANUAL: "ANUAL",
    MENSUAL: "MENSUAL",
    EXTRAORDINARIO: "EXTRAORDINARIO",
    PAQUETE_GESTORIA: "PAQUETE_GESTORIA",
    DIARIO_Z: "DIARIO_Z",
});

export const PACKAGE_STATUS = _deepFreeze({
    PREPARED: "PREPARED",
    SENT: "SENT",
});

export const CLOSING_STATUS = _deepFreeze({
    ABIERTO: "ABIERTO",
    CERRADO: "CERRADO",
});

export const SIGNATURE_STATUS = _deepFreeze({
    SIGNED: "SIGNED",
    PENDING_SIGNATURE: "PENDING_SIGNATURE",
    FAILED: "FAILED",
});

export const INVOICE_PAYMENT_STATUS = _deepFreeze({
    PENDIENTE: "PENDIENTE",
    PAGADO: "PAGADO",
    PARCIAL: "PARCIAL",
});

export const INVOICE_PAYMENT_STATUSES = Object.freeze([
    INVOICE_PAYMENT_STATUS.PENDIENTE,
    INVOICE_PAYMENT_STATUS.PAGADO,
    INVOICE_PAYMENT_STATUS.PARCIAL,
]);

export const RECEPTION_SOURCE = _deepFreeze({
    MANUAL: "MANUAL",
    EMAIL: "EMAIL",
    API: "API",
    OCR: "OCR",
});

export const VALIDATION_STATUS = _deepFreeze({
    PENDIENTE: "PENDIENTE",
    VALIDADA: "VALIDADA",
    RECHAZADA: "RECHAZADA",
});

// =============================================================================
// BLOQUE 31 - REGISTRO HORARIO
// =============================================================================

export const CLOCK_RECORD_TYPE = _deepFreeze({
    REGULAR: "REGULAR",
    AJUSTE: "AJUSTE",
});

export const CLOCK_REGISTERED_BY = _deepFreeze({
    SELF: "SELF",
    ADMIN: "ADMIN",
});

export const JOURNEY_TYPE = _deepFreeze({
    ORDINARIA: "ORDINARIA",
    EXTRAORDINARIA: "EXTRAORDINARIA",
});

// =============================================================================
// BLOQUE 32 - AUDITORIA OPERATIVA
// =============================================================================

export const AUDIT_LEVEL = _deepFreeze({
    INFO: "INFO",
    WARNING: "WARNING",
    ERROR: "ERROR",
    CRITICAL: "CRITICAL",
});

export const AUDIT_LEVELS = Object.freeze([
    AUDIT_LEVEL.INFO,
    AUDIT_LEVEL.WARNING,
    AUDIT_LEVEL.ERROR,
    AUDIT_LEVEL.CRITICAL,
]);

export const ALERT_STATUS = _deepFreeze({
    OPEN: "OPEN",
    ACKNOWLEDGED: "ACKNOWLEDGED",
    CLOSED: "CLOSED",
});

// =============================================================================
// BLOQUE 33 - CONJUNTOS DE VALIDACION
// =============================================================================

export const VALIDATION_SETS = _deepFreeze({
    THIRD_PARTY_TYPES: Object.freeze(Object.values(THIRD_PARTY_TYPE)),
    ITEM_NATURES: Object.freeze(Object.values(ITEM_NATURE)),
    TAX_CODES: Object.freeze(Object.values(TAX_CODE)),
    EVENT_TYPES: Object.freeze(Object.values(EVENT_TYPE)),
    FISCAL_ROLES: Object.freeze(Object.values(FISCAL_ROLE)),
    MOVEMENT_TYPES: Object.freeze(Object.values(MOVEMENT_TYPE)),
    PAYMENT_METHODS: Object.freeze(Object.values(PAYMENT_METHOD)),
    INVOICE_TYPES: Object.freeze(Object.values(AEAT_INVOICE_TYPE)),
    CHANNEL_TYPES: Object.freeze(Object.values(CHANNEL_TYPE)),
    CLOSING_TYPES: Object.freeze(Object.values(CLOSING_TYPE)),
    CLOCK_EVENT_TYPES: Object.freeze(Object.values(TIMECLOCK_TYPE)),
    COLLABORATOR_ROLES: Object.freeze(Object.values(COLLABORATOR_ROLES)),
    REGIME_KEYS: Object.freeze(Object.values(REGIME_KEY)),
    OPERATION_CLASSIFICATIONS: Object.freeze(Object.values(OPERATION_CLASSIFICATION)),
    EXEMPT_OPERATIONS: Object.freeze(Object.values(EXEMPT_OPERATION)),
    NON_SUBJECT_REASONS: Object.freeze(Object.values(NON_SUBJECT_REASON)),
    ISSUED_BY: Object.freeze(Object.values(ISSUED_BY)),
    EU_VAT_PREFIXES: EU_VAT_PREFIXES,
});

// =============================================================================
// BLOQUE 34 - ALIASES DEPRECATED
// [CFG-08] JSDoc correctamente terminado.
// =============================================================================

/** @deprecated Usar TIMECLOCK_TYPE. */
export const TIPO_FICHAJE = TIMECLOCK_TYPE;

/** @deprecated Usar MOVEMENT_TYPE. */
export const TIPO_MOVIMIENTO = MOVEMENT_TYPE;

/** @deprecated Usar PAYMENT_METHOD. */
export const FORMA_PAGO = PAYMENT_METHOD;

/** @deprecated Usar CASH_REGISTER_STATUS. */
export const CAJA_STATUS = CASH_REGISTER_STATUS;

/** @deprecated Usar BOOKING_STATUS. */
export const ESTADO_CITA = BOOKING_STATUS;

/** @deprecated Usar PAYMENT_STATUS. */
export const ESTADO_PAGO = PAYMENT_STATUS;

/** @deprecated Usar COLLABORATOR_ROLES. */
export const COLLAB_ROLES = COLLABORATOR_ROLES;

/** @deprecated Usar CATALOG_CONFIG. */
export const SERVICE_CATALOG = CATALOG_CONFIG;

/** @deprecated Usar BOOKING_FIELDS. */
export const CITA_FIELDS = BOOKING_FIELDS;

/** @deprecated Usar CURRENCY_CONFIG. */
export const MONEY = CURRENCY_CONFIG;

/** @deprecated Usar ACCOUNTING_ACCOUNT. */
export const CUENTAS_PGC = ACCOUNTING_ACCOUNT;

/** @deprecated Usar AEAT_INVOICE_TYPE. */
export const CLAVES_AEAT = AEAT_INVOICE_TYPE;

/** @deprecated Usar CORRECTION_REASON. */
export const MOTIVOS_RECTIFICACION = CORRECTION_REASON;

/** @deprecated Usar IRPF_WITHHOLDING_RATE. */
export const TIPOS_RETENCION_IRPF = IRPF_WITHHOLDING_RATE;

/** @deprecated Usar VAT_ACCRUAL_STATUS. */
export const ESTADO_DEVENGO_IVA = VAT_ACCRUAL_STATUS;

/** @deprecated Usar FISCAL_ROLE. */
export const ROL_FISCAL = FISCAL_ROLE;

/** @deprecated Usar EVENT_TYPE. */
export const TIPO_EVENTO = EVENT_TYPE;

/** @deprecated Usar ITEM_NATURE. */
export const NATURALEZA_ITEM = ITEM_NATURE;

/** @deprecated Usar THIRD_PARTY_TYPE. */
export const TIPO_TERCERO = THIRD_PARTY_TYPE;

/** @deprecated Usar PROJECTION_STATUS. */
export const PROYECCION_ESTADO = PROJECTION_STATUS;

/** @deprecated Usar COMPUTER_SYSTEM + buildComputerSystem(). */
export const SISTEMA_INFORMATICO = COMPUTER_SYSTEM;

/** @deprecated Usar STAFF_ACCESS.MARIAN_RESOURCE_ID o API.MARIAN_MANAGEMENT_RESOURCE_ID. */
export const MARIAN_RESOURCE_ID = API.MARIAN_MANAGEMENT_RESOURCE_ID;

// =============================================================================
// BLOQUE 35 - AUTOVERIFICACION DEL SSOT
// [CFG-20]
// =============================================================================

const _WHITESPACE_PATTERN = /(^[\s\uFEFF\xA0]+)|([\s\uFEFF\xA0]+$)/;

function _scanWhitespace(groupName, group, out) {
    if (!group || typeof group !== "object") return;
    for (const [key, value] of Object.entries(group)) {
        if (typeof value === "string") {
            if (_WHITESPACE_PATTERN.test(value)) {
                out.push(groupName + "." + key + " = [" + value + "]");
            }
        } else if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === "string" && _WHITESPACE_PATTERN.test(item)) {
                    out.push(groupName + "." + key + "[] = [" + item + "]");
                }
            }
        } else if (value && typeof value === "object") {
            _scanWhitespace(groupName + "." + key, value, out);
        }
    }
}

function _scanDuplicates(groupName, group, out) {
    if (!group || typeof group !== "object") return;
    const seen = new Map();
    for (const [key, value] of Object.entries(group)) {
        if (typeof value !== "string") continue;
        if (seen.has(value) && seen.get(value) !== key) {
            out.push(groupName + ": " + seen.get(value) + " y " + key + " = [" + value + "]");
        } else {
            seen.set(value, key);
        }
    }
}

export function validateInternalConfig() {
    const whitespaceIssues = [];
    const duplicateIssues = [];
    const emptyGroups = [];

    const groups = {
        COLLECTIONS: COLLECTIONS,
        APP_IDS: APP_IDS,
        API: API,
        SINGLETONS: SINGLETONS,
        TIMECLOCK_TYPE: TIMECLOCK_TYPE,
        MOVEMENT_TYPE: MOVEMENT_TYPE,
        PAYMENT_METHOD: PAYMENT_METHOD,
        AEAT_PAYMENT_METHOD: AEAT_PAYMENT_METHOD,
        CASH_REGISTER_STATUS: CASH_REGISTER_STATUS,
        BOOKING_TYPE: BOOKING_TYPE,
        CHANNEL_TYPE: CHANNEL_TYPE,
        RECORD_SOURCE: RECORD_SOURCE,
        BOOKING_FIELDS: BOOKING_FIELDS,
        STAFF_ACCESS: STAFF_ACCESS,
        ACCOUNTING_ACCOUNT: ACCOUNTING_ACCOUNT,
        AEAT_INVOICE_TYPE: AEAT_INVOICE_TYPE,
        CORRECTION_TYPE: CORRECTION_TYPE,
        CORRECTION_REASON: CORRECTION_REASON,
        VAT_ACCRUAL_STATUS: VAT_ACCRUAL_STATUS,
        FISCAL_ROLE: FISCAL_ROLE,
        EVENT_TYPE: EVENT_TYPE,
        SIF_EVENT_TYPE: SIF_EVENT_TYPE,
        ITEM_NATURE: ITEM_NATURE,
        THIRD_PARTY_TYPE: THIRD_PARTY_TYPE,
        PROJECTION_STATUS: PROJECTION_STATUS,
        COMPUTER_SYSTEM: COMPUTER_SYSTEM,
        REGIME_KEY: REGIME_KEY,
        OPERATION_CLASSIFICATION: OPERATION_CLASSIFICATION,
        EXEMPT_OPERATION: EXEMPT_OPERATION,
        NON_SUBJECT_REASON: NON_SUBJECT_REASON,
        ISSUED_BY: ISSUED_BY,
        AEAT_SUBMISSION_STATUS: AEAT_SUBMISSION_STATUS,
        RECONCILIATION_STATUS: RECONCILIATION_STATUS,
        TAX_CODE: TAX_CODE,
        ENTRY_STATUS: ENTRY_STATUS,
        ACCOUNT_NATURE: ACCOUNT_NATURE,
        BALANCE_NATURE: BALANCE_NATURE,
        QUEUE_STATUS: QUEUE_STATUS,
        COMPENSATION_KIND: COMPENSATION_KIND,
        COMPENSATION_STATUS: COMPENSATION_STATUS,
        COMPENSATION_PHASE: COMPENSATION_PHASE,
        CLOSING_TYPE: CLOSING_TYPE,
        CLOSING_STATUS: CLOSING_STATUS,
        PACKAGE_STATUS: PACKAGE_STATUS,
        SIGNATURE_STATUS: SIGNATURE_STATUS,
        INVOICE_PAYMENT_STATUS: INVOICE_PAYMENT_STATUS,
        RECEPTION_SOURCE: RECEPTION_SOURCE,
        VALIDATION_STATUS: VALIDATION_STATUS,
        CLOCK_RECORD_TYPE: CLOCK_RECORD_TYPE,
        CLOCK_REGISTERED_BY: CLOCK_REGISTERED_BY,
        JOURNEY_TYPE: JOURNEY_TYPE,
        AUDIT_LEVEL: AUDIT_LEVEL,
        ALERT_STATUS: ALERT_STATUS,
        INTEGRITY: INTEGRITY,
    };

    for (const [name, group] of Object.entries(groups)) {
        _scanWhitespace(name, group, whitespaceIssues);
        if (name !== "BOOKING_STATUS" && name !== "STAFF_ACCESS") {
            _scanDuplicates(name, group, duplicateIssues);
        }
        if (group && typeof group === "object" && Object.keys(group).length === 0) {
            emptyGroups.push(name);
        }
    }

    const prefixSeen = new Set();
    for (const prefix of EU_VAT_PREFIXES) {
        if (prefixSeen.has(prefix)) duplicateIssues.push("EU_VAT_PREFIXES: " + prefix);
        prefixSeen.add(prefix);
    }

    return {
        valid: whitespaceIssues.length === 0 && duplicateIssues.length === 0 && emptyGroups.length === 0,
        whitespaceIssues: whitespaceIssues,
        duplicateIssues: duplicateIssues,
        emptyGroups: emptyGroups,
    };
}

export function validateRuntimeContext(context) {
    const issues = [];
    const ctx = context && typeof context === "object" ? context : {};

    if (!isValidGuid(SDK_CONFIG.LOCATION_ID)) {
        issues.push("SDK_CONFIG.LOCATION_ID no es un GUID valido");
    } else if (ctx.locationExists === false) {
        issues.push("SDK_CONFIG.LOCATION_ID no existe en Wix Business Manager");
    }

    if (!isValidGuid(API.STAFF_RESOURCE_TYPE_ID)) {
        issues.push("API.STAFF_RESOURCE_TYPE_ID no es un GUID valido");
    }
    if (!isValidGuid(API.MARIAN_MANAGEMENT_RESOURCE_ID)) {
        issues.push("API.MARIAN_MANAGEMENT_RESOURCE_ID no es un GUID valido");
    }

    const activeIds = Array.isArray(ctx.staffResourceIds) ? ctx.staffResourceIds : null;
    if (activeIds) {
        const activeSet = new Set(activeIds);
        for (const id of STAFF.IDS) {
            if (!activeSet.has(id)) {
                issues.push("STAFF.IDS contiene resourceId inactivo o inexistente en MapaStaff: " + id);
            }
        }
    }

    const existing = Array.isArray(ctx.existingCollectionIds) ? ctx.existingCollectionIds : null;
    if (existing) {
        const existingSet = new Set(existing);
        for (const [name, id] of Object.entries(COLLECTIONS)) {
            if (!existingSet.has(id)) {
                issues.push("COLLECTIONS." + name + " [" + id + "] no existe en el CMS del sitio");
            }
        }
    }

    return { valid: issues.length === 0, issues: issues };
}

export default {
    STAFF,
    COLLECTIONS,
    BUSINESS_COLLECTIONS,
    OPERATIONAL_COLLECTIONS,
    APP_IDS,
    API,
    SINGLETONS,
    SDK_CONFIG,
    CONCURRENCY,
    TIMECLOCK_TYPE,
    MOVEMENT_TYPE,
    NON_TAXABLE_MOVEMENT_TYPES,
    NEGATIVE_SIGN_MOVEMENT_TYPES,
    PAYMENT_METHOD,
    AEAT_PAYMENT_METHOD,
    IVA_RATES,
    CASH_REGISTER_STATUS,
    BOOKING_STATUS,
    INACTIVE_BOOKING_STATUSES,
    PAYMENT_STATUS,
    BOOKING_TYPE,
    COLLABORATOR_ROLES,
    CHANNEL_TYPE,
    RECORD_SOURCE,
    CATALOG_CONFIG,
    SLOT_SEARCH,
    BOOKINGS_ADDON_CONFIG,
    JWT,
    BOOKING_FIELDS,
    STAFF_ACCESS,
    CURRENCY_CONFIG,
    STAFF_DEFAULT_NAME,
    PATTERNS,
    ACCOUNTING_ACCOUNT,
    ACCOUNTING_ACCOUNT_NAME,
    ENTRY_STATUS,
    IMMUTABLE_ENTRY_STATUSES,
    ACCOUNT_NATURE,
    BALANCE_NATURE,
    AEAT_INVOICE_TYPE,
    CORRECTION_TYPE,
    CORRECTION_REASON,
    IRPF_WITHHOLDING_RATE,
    VAT_ACCRUAL_STATUS,
    FISCAL_ROLE,
    EU_VAT_PREFIXES,
    EVENT_TYPE,
    EVENT_TYPES_REQUIRING_CATALOG,
    SIF_EVENT_TYPE,
    ITEM_NATURE,
    THIRD_PARTY_TYPE,
    PROJECTION_STATUS,
    COMPUTER_SYSTEM,
    REGIME_KEY,
    OPERATION_CLASSIFICATION,
    EXEMPT_OPERATION,
    NON_SUBJECT_REASON,
    ISSUED_BY,
    AEAT_SUBMISSION_STATUS,
    RECONCILIATION_STATUS,
    TAX_CODE,
    FISCAL_LIMITS,
    INTEGRITY,
    QUEUE_STATUS,
    COMPENSATION_KIND,
    COMPENSATION_STATUS,
    COMPENSATION_RETRIABLE_STATUSES,
    COMPENSATION_PHASE,
    CLOSING_TYPE,
    CLOSING_STATUS,
    PACKAGE_STATUS,
    SIGNATURE_STATUS,
    INVOICE_PAYMENT_STATUS,
    INVOICE_PAYMENT_STATUSES,
    RECEPTION_SOURCE,
    VALIDATION_STATUS,
    CLOCK_RECORD_TYPE,
    CLOCK_REGISTERED_BY,
    JOURNEY_TYPE,
    AUDIT_LEVEL,
    AUDIT_LEVELS,
    ALERT_STATUS,
    VALIDATION_SETS,
};
