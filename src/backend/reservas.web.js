/**
 * =============================================================================
 * FILE: backend/reservas.web.js
 * VERSION: refactor-reservas-v8 (IDs tecnicos nativos del CSV ServiciosCatalogo
 *          + shape dual espanol/ingles para compatibilidad total con
 *          bookingSaga.js y citasManager.js)
 * RESPONSIBILITY: Availability engine, dual slots with gap, same-staff pairing,
 * workload-balanced staff allocation, cache management, and public service
 * methods.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 *
 * CORRECTIONS APPLIED v8:
 *   [IDS-01] _mapServiceImport2ToUX lee IDs TECNICOS NATIVOS del CSV
 *            ServiciosCatalogo (title, price, allowCombine, linkedPhases,
 *            phase1Duration, exposureDuration, phase2Duration, totalDuration,
 *            buffer, hidden, mainMedia, location, tagLine, description,
 *            availableStaff, addOnOptions, serviceType, sku, categoryId,
 *            categoryName, locationId, pricingModel, depositAmount,
 *            depositType, currency, taxIncluded, taxRate, onlinePayment,
 *            inPersonPayment, internalNotes).
 *   [IDS-02] Retirados los nombres traducidos huerfanos (tituloServicio,
 *            precio, permitirCombinar, linkFases, tiempoFase1,
 *            tiempoExposicion, tiempoFase2, duracionTotal, oculto,
 *            imagenPrincipal, localizacion, resumenCorto, descripcionLarga,
 *            staffDisponible, addons, recomendacionProductoRef,
 *            recomendacionProductoRef2) como claves de LECTURA del CMS.
 *   [IDS-03] Shape de retorno expone alias en ESPANOL y en INGLES para
 *            garantizar compatibilidad total:
 *            - bookingSaga.js lee serviceConfig.allowCombine,
 *              serviceConfig.linkedPhases, serviceConfig.phase1Duration,
 *              serviceConfig.phase2Duration, serviceConfig.exposureDuration.
 *            - citasManager.js y funciones internas leen service.linkFases,
 *              service.permitirCombinar, service.tiempoFase1,
 *              service.tiempoExposicion, service.tiempoFase2.
 * =============================================================================
 */
import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import { availabilityTimeSlots } from "@wix/bookings";
import {
    COLLECTIONS,
    SDK_CONFIG,
    SLOT_SEARCH,
    API,
    STAFF_DEFAULT_NAME,
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
    _normalizeLocalIsoStr,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
    _executeWithRetry,
    _hashKey,
    _generateUUID,
    withTimeout,
} from "public/mmUtils";

// [FIX] Logger canonico (evita dependencia circular con bookingCore.js)
import { logger } from "backend/logger";

// [FIX] Resolucion real del nombre del profesional
import { getStaffDisplayName } from "backend/staff";

const log = logger;

function _readImport2Field(item, field) {
    if (!item || typeof item !== "object") return null;
    return item[field] ?? item.data?.[field] ?? item.fields?.[field] ?? null;
}

function _readOptionalImport2ResourceIds(value) {
    const source = Array.isArray(value) ? value : [];
    return Array.from(new Set(source.map((item) => {
        if (typeof item === "string") return _safeTrim(item);
        return _safeTrim(item?._id || item?.id || item?.resourceId);
    }).filter((id) => _looksLikeGuid(id))));
}

function _parseImport2Addons(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function _normalizeImport2Addon(addon) {
    if (!addon || typeof addon !== "object") return null;
    return {
        ...addon,
        id: _safeTrim(addon.id || addon._id || addon.addonId),
        nombre: _safeTrim(addon.nombre || addon.name || addon.title),
        precio: Number(addon.precio ?? addon.price ?? 0) || 0,
    };
}

const SERVICIOS_COL = COLLECTIONS.SERVICIOS_CATALOGO;
const DUAL_CACHE_COL = COLLECTIONS.DUAL_SLOT_CACHE;
const DAYS_CACHE_COL = COLLECTIONS.AVAILABILITY_DAYS_CACHE;
const CITAS_COL = COLLECTIONS.CITAS_F2;

const WATCHDOG_TIMEOUT_MS = SDK_CONFIG.TIMEOUTS.WATCHDOG_MS;
const SERVICE_CACHE_TTL_MS = SDK_CONFIG.CACHE.SERVICES_TTL_MS;
const SLOTS_CACHE_TTL_MS = SDK_CONFIG.CACHE.SLOTS_CACHE_TTL_MS;
const DUAL_CACHE_TTL_MS = SDK_CONFIG.CACHE.DUAL_CACHE_TTL_MS;
const DIAS_LIMITE = SLOT_SEARCH.DIAS_LIMITE;
const MAX_DUAL_GAP_MINUTES = Math.max(0, Number(SLOT_SEARCH.MAX_DUAL_GAP_MINUTES) || 120);
const CACHE_MAX_SIZE = SDK_CONFIG.CACHE.MAX_ENTRIES;
const DAYS_CACHE_VERSION = SDK_CONFIG.CACHE.DAYS_CACHE_VERSION;
const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;

const LOCATION_TS = Object.freeze({
    id: SDK_CONFIG.LOCATION_ID,
    locationType: SDK_CONFIG.LOCATION_TYPES.TIME_SLOTS,
});

const availabilityCache = new Map();
const inflightRequests = new Map();
const serviceCatalogRAM = new Map();

function _cacheSetBounded(map, key, value, maxSize) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    if (map.size <= maxSize) return;
    const firstKey = map.keys().next().value;
    if (firstKey) map.delete(firstKey);
}

function _toPublicError(err, fallbackCode = "INTERNAL_ERROR", fallbackMessage = "Internal Error") {
    return { code: String(err?.code || fallbackCode), message: String(err?.message || fallbackMessage) };
}

function _normalizeSlotShape(slot) {
    if (!slot || typeof slot !== "object") return null;
    if (slot.slot && typeof slot.slot === "object") return { ...slot.slot, ...slot };
    return slot;
}

function _attachServiceId(slot, forcedServiceId, traceId, ctx) {
    const s = _normalizeSlotShape(slot);
    if (!s) return null;
    const serviceId = _safeTrim(forcedServiceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
        log.error("_attachServiceId: invalid serviceId", { traceId, ctx, serviceId });
        return null;
    }
    return {
        ...s,
        serviceId,
        ...(s.slot && typeof s.slot === "object" ? { slot: { ...s.slot, serviceId } } : {}),
    };
}

function _isValidMadridYmd(value) {
    const ymd = _safeTrim(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function _addDaysYMD(ymd, days) {
    if (!_isValidMadridYmd(ymd)) return "";
    const parts = String(ymd).split("-").map(Number);
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
    return dt.toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG.TZ });
}

function _filterDaysByLimit(daysArray) {
    if (!Array.isArray(daysArray) || daysArray.length === 0) return [];
    const now = new Date();
    const todayStr = now.toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG.TZ });
    const tomorrowStr = _addDaysYMD(todayStr, 1);
    const maxDateStr = _addDaysYMD(todayStr, DIAS_LIMITE);
    if (!tomorrowStr || !maxDateStr) return [];
    return daysArray.filter((date) => date >= tomorrowStr && date <= maxDateStr);
}

function _normalizeResourceIds(resourceId, traceId) {
    if (!resourceId) return [];
    const normalized = _safeTrim(resourceId);
    if (!normalized || ["all", "any"].includes(normalized.toLowerCase())) return [];
    if (_looksLikeGuid(normalized)) return [normalized];
    log.warn("_normalizeResourceIds: non-guid identifier not supported; treating as ANY", { resourceId: normalized, traceId });
    return [];
}

// [FIX] Lectura robusta de resource.id | resource._id | resource.resourceId
function _getResourceIdsFromSlot(slot) {
    const s = _normalizeSlotShape(slot);
    if (!s || typeof s !== "object") return [];
    let groups = [];
    if (Array.isArray(s.availableResources)) groups = s.availableResources;
    else if (s.slot && typeof s.slot === "object" && Array.isArray(s.slot.availableResources)) groups = s.slot.availableResources;
    else if (s.resource?.id || s.resource?._id) {
        const id = s.resource.id || s.resource._id;
        return _looksLikeGuid(String(id)) ? [String(id)] : [];
    } else if (s.resource?.resourceId) {
        const id = s.resource.resourceId;
        return _looksLikeGuid(String(id)) ? [String(id)] : [];
    } else if (s.resourceId) return _looksLikeGuid(String(s.resourceId)) ? [String(s.resourceId)] : [];

    const staffGroup = groups.find((g) => String(g.resourceTypeId) === String(STAFF_RESOURCE_TYPE_ID));
    if (!staffGroup) return [];
    return Array.from(new Set(
        (staffGroup.resources || [])
        .map((resource) => _safeTrim(
            resource?.id ||
            resource?._id ||
            resource?.resourceId
        ))
        .filter((resourceId) => _looksLikeGuid(resourceId))
    ));
}

function _minutesBetweenUtcDates(a, b) {
    if (!(a instanceof Date) || !(b instanceof Date)) return 0;
    const ms = b.getTime() - a.getTime();
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.round(ms / 60000);
}

function _isValidSlotRange(startLocal, endLocal) {
    const startUtc = getUtcDateFromMadridLocal(_normalizeLocalIsoStr(startLocal));
    const endUtc = getUtcDateFromMadridLocal(_normalizeLocalIsoStr(endLocal));
    return Boolean(startUtc && endUtc && endUtc.getTime() > startUtc.getTime());
}

// [FIX] Delegacion no recursiva. Fuente unica: _resolveAddonContextInternal.
function _resolveAddonContextInternal(service, requestedAddonIds) {
    const requested = Array.isArray(requestedAddonIds) ?
        requestedAddonIds.map((id) => _safeTrim(id)).filter(Boolean) :
        [];

    const addons = Array.isArray(service?.metadata?.addons) ?
        service.metadata.addons :
        [];

    const selected = requested.length > 0 ?
        addons.filter((addon) => requested.includes(String(addon.id))) :
        [];

    return {
        nativeAddonIds: selected
            .map((addon) => _safeTrim(addon.nativeId || addon.id))
            .filter(_looksLikeGuid),
        addons: selected,
    };
}

function _resolveAddonContext(service, requestedAddonIds) {
    return _resolveAddonContextInternal(service, requestedAddonIds);
}

async function _getServiceBySlugOrIdInternal(slugOrId, externalTraceId = null) {
    const traceId = externalTraceId || makeTraceId("service");
    const raw = _safeTrim(slugOrId);
    const isGuid = _looksLikeGuid(raw);
    const clean = isGuid ? raw : _safeTrim(raw) ? String(raw).split("?")[0].split("#")[0].replace(/^\//, "").replace(/\/$/, "") : "";
    const cached = serviceCatalogRAM.get(clean);
    if (cached && Date.now() - cached.timestamp < SERVICE_CACHE_TTL_MS) {
        return { status: "SUCCESS", data: cached.data, error: null };
    }

    try {
        let result;
        if (isGuid) {
            result = await withTimeout(wixData.query(SERVICIOS_COL).limit(1).eq("serviceId", clean).find({ suppressAuth: true }), WATCHDOG_TIMEOUT_MS, "getServiceBySlugOrId:serviceId");
        } else {
            result = await withTimeout(wixData.query(SERVICIOS_COL).limit(1).eq("slugUrl", clean).find({ suppressAuth: true }), WATCHDOG_TIMEOUT_MS, "getServiceBySlugOrId:slugUrl");
            if ((!result?.items?.[0]) && _looksLikeGuid(clean)) {
                result = await withTimeout(wixData.query(SERVICIOS_COL).limit(1).eq("serviceId", clean).find({ suppressAuth: true }), WATCHDOG_TIMEOUT_MS, "getServiceBySlugOrId:guidFallback");
            }
        }

        const service = result?.items?.[0] || null;
        if (!service) {
            log.error("Service not found in Import2", { key: clean, traceId });
            return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: `Servicio "${slugOrId}" no encontrado.` } };
        }

        const mapped = await _mapServiceImport2ToUX(service, traceId);
        _cacheSetBounded(serviceCatalogRAM, clean, { data: mapped, timestamp: Date.now() }, CACHE_MAX_SIZE);
        if (mapped.serviceId) _cacheSetBounded(serviceCatalogRAM, mapped.serviceId, { data: mapped, timestamp: Date.now() }, CACHE_MAX_SIZE);
        if (mapped.slugUrl) _cacheSetBounded(serviceCatalogRAM, mapped.slugUrl, { data: mapped, timestamp: Date.now() }, CACHE_MAX_SIZE);
        return { status: "SUCCESS", data: mapped, error: null };
    } catch (e) {
        log.error("Error in getServiceBySlugOrId", { error: e?.message, traceId });
        return { status: "ERROR", data: null, error: { code: "DATABASE_ERROR", message: e?.message || "Error al consultar la base de datos." } };
    }
}

async function _resolveServiceIdInternal(serviceIdReq) {
    const raw = _safeTrim(serviceIdReq);
    if (!raw) return null;
    if (_looksLikeGuid(raw)) return raw;
    const normalized = _safeSlugOrId(raw);
    if (!normalized) return null;
    const res = await _getServiceBySlugOrIdInternal(normalized);
    if (res?.status === "SUCCESS" && res?.data?.serviceId) {
        const sid = _safeTrim(res.data.serviceId);
        if (sid && _looksLikeGuid(sid)) return sid;
    }
    return null;
}

// [FIX] Resolucion real del nombre del profesional desde backend/staff
async function _getStaffDisplayNamePublic(resourceId) {
    const id = _safeTrim(resourceId);
    if (!id || !_looksLikeGuid(id)) return STAFF_DEFAULT_NAME;

    try {
        const name = await getStaffDisplayName(id);
        return _safeTrim(name) || STAFF_DEFAULT_NAME;
    } catch (_) {
        return STAFF_DEFAULT_NAME;
    }
}

// =============================================================================
// [IDS-01] MAPEO DE SERVICIO CON IDs TECNICOS NATIVOS
//
// CSV ServiciosCatalogo define los IDs tecnicos nativos (ingles):
//   serviceId, title, slugUrl, serviceType, totalDuration, phase1Duration,
//   exposureDuration, phase2Duration, buffer, linkedPhases, allowCombine,
//   price, currency, pricingModel, depositAmount, depositType, onlinePayment,
//   inPersonPayment, taxIncluded, taxRate, sku, categoryId, categoryName,
//   locationId, location, availableStaff, addOnOptions, tagLine, description,
//   mainMedia, hidden, internalNotes
//
// [IDS-03] Shape de retorno expone AMBOS alias (espanol + ingles) para
// garantizar compatibilidad con todos los consumidores:
//   - bookingSaga.js lee: allowCombine, linkedPhases, phase1Duration,
//     phase2Duration, exposureDuration.
//   - citasManager.js y funciones internas leen: linkFases,
//     permitirCombinar, tiempoFase1, tiempoExposicion, tiempoFase2.
// =============================================================================

export async function _mapServiceImport2ToUX(service, traceId) {
    const serviceId = _safeTrim(_readImport2Field(service, "serviceId"));
    if (!_looksLikeGuid(serviceId)) {
        throw new Error("Import2 invalid: serviceId missing or not a GUID");
    }

    const isHiddenF2 = _readImport2Field(service, "hidden") === true;
    const allowCombine = !isHiddenF2 && _readImport2Field(service, "allowCombine") === true;
    const linkedPhases = _safeTrim(_readImport2Field(service, "linkedPhases"));
    if (allowCombine && !_looksLikeGuid(linkedPhases)) {
        throw new Error("Import2 invalid: linkedPhases missing or not a GUID for dual service");
    }

    const phase1Duration = Number(_readImport2Field(service, "phase1Duration")) || 0;
    const exposureDuration = Number(_readImport2Field(service, "exposureDuration")) || 0;
    const phase2Duration = Number(_readImport2Field(service, "phase2Duration")) || 0;
    const totalDuration = Number(_readImport2Field(service, "totalDuration")) || 0;
    const buffer = Number(_readImport2Field(service, "buffer")) || 0;

    const title = _safeTrim(_readImport2Field(service, "title")) || "Servicio";
    const price = Number(_readImport2Field(service, "price")) || 0;
    const currency = _safeTrim(_readImport2Field(service, "currency")) || "EUR";
    const pricingModel = _safeTrim(_readImport2Field(service, "pricingModel")) || null;
    const slugUrl = _safeTrim(_readImport2Field(service, "slugUrl")) || null;
    const serviceType = _safeTrim(_readImport2Field(service, "serviceType")) || null;
    const sku = _safeTrim(_readImport2Field(service, "sku")) || null;

    const depositAmount = Number(_readImport2Field(service, "depositAmount")) || 0;
    const depositType = _safeTrim(_readImport2Field(service, "depositType")) || null;
    const onlinePayment = _readImport2Field(service, "onlinePayment") === true;
    const inPersonPayment = _readImport2Field(service, "inPersonPayment") === true;
    const taxIncluded = _readImport2Field(service, "taxIncluded") === true;
    const taxRate = Number(_readImport2Field(service, "taxRate")) || 0;

    const categoryId = _safeTrim(_readImport2Field(service, "categoryId")) || null;
    const categoryName = _safeTrim(_readImport2Field(service, "categoryName")) || null;
    const locationId = _safeTrim(_readImport2Field(service, "locationId")) || null;
    const localizacion = _safeTrim(_readImport2Field(service, "location")) || null;

    const imageUrl = _safeTrim(_readImport2Field(service, "mainMedia")) || "";
    const resumenCorto = _safeTrim(_readImport2Field(service, "tagLine")) || null;
    const descripcionLarga = _safeTrim(_readImport2Field(service, "description")) || null;
    const internalNotes = _safeTrim(_readImport2Field(service, "internalNotes")) || null;

    const estimatedTotal = totalDuration ||
        (allowCombine ? phase1Duration + exposureDuration + phase2Duration : phase1Duration) ||
        30;

    const staffDisponible = _readOptionalImport2ResourceIds(
        _readImport2Field(service, "availableStaff"),
        traceId
    );

    const staffOptions = await Promise.all(
        staffDisponible.map(async (resourceId) => {
            const displayName = (await _getStaffDisplayNamePublic(resourceId).catch(() => "")) || STAFF_DEFAULT_NAME;
            return { id: resourceId, value: resourceId, name: displayName, label: displayName };
        })
    );

    const addons = _parseImport2Addons(_readImport2Field(service, "addOnOptions"))
        .map((addon) => _normalizeImport2Addon(addon))
        .filter(Boolean);

    return {
        // -------- Identificadores y clasificacion
        serviceId,
        slugUrl,
        serviceType,
        sku,
        categoryId,
        categoryName,
        locationId,
        localizacion,
        internalNotes,

        // -------- [IDS-03] Alias en ESPANOL (shape interno historico)
        linkFases: allowCombine ? linkedPhases : null,
        permitirCombinar: allowCombine,
        tiempoFase1: phase1Duration,
        tiempoExposicion: exposureDuration,
        tiempoFase2: phase2Duration,
        duracionTotal: totalDuration,
        buffer,
        staffDisponible,
        staffOptions,
        depositAmount,
        depositType,
        onlinePayment,
        inPersonPayment,
        taxIncluded,
        taxRate,
        pricingModel,
        currency,

        // -------- [IDS-03] Alias en INGLES (contratos de bookingSaga.js)
        linkedPhases: allowCombine ? linkedPhases : null,
        allowCombine: allowCombine,
        phase1Duration,
        exposureDuration,
        phase2Duration,
        totalDuration,
        hidden: isHiddenF2,

        // -------- Metadata agregada (shape interno consumido por UI)
        metadata: {
            titulo: title,
            tituloServicio: title,
            precio: price,
            duracionTotal: estimatedTotal,
            localizacion,
            resumenCorto,
            descripcionLarga,
            pricingModel,
            addons,
            addonsPrecio: addons.map((addon) => Number(addon?.precio || 0)),
            imageUrl,
            currency,
            taxRate,
            pricing: { base: price, currency },
            timing: { estimatedTotal, totalDuration: estimatedTotal },
        },
    };
}

export async function getServiceForBookingInternal(serviceId, traceId = null) {
    return await _getServiceBySlugOrIdInternal(serviceId, traceId || makeTraceId("service-internal"));
}

export const getServiceBySlugOrId = webMethod(Permissions.Anyone, async (slugOrId) => {
    const traceId = makeTraceId("wm-svc");
    try {
        const result = await _getServiceBySlugOrIdInternal(slugOrId, traceId);
        return result?.status === "SUCCESS" ?
            { status: "SUCCESS", data: _toPublicService(result.data), error: null } :
            result;
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "SERVICE_LOOKUP_FAILED") };
    }
});

export const resolveServiceId = webMethod(Permissions.Anyone, async (serviceIdReq) => {
    const traceId = makeTraceId("wm-svc-resolve");
    try {
        const resolved = await _resolveServiceIdInternal(serviceIdReq);
        if (!resolved) {
            return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Identificador de servicio no encontrado." } };
        }
        return { status: "SUCCESS", data: String(resolved), error: null };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "SERVICE_RESOLVE_FAILED") };
    }
});

export function _toPublicService(service) {
    if (!service || typeof service !== "object") return null;
    const { linkFases, ...publicService } = service;
    return publicService;
}

// [FIX] Export publico delega en internal (sin recursion)
export async function _resolveAddonContextPublic(service, requestedAddonIds) {
    return _resolveAddonContextInternal(service, requestedAddonIds);
}

export async function revalidateExactAvailabilitySlot({ serviceId, localStartDate, localEndDate, resourceId, nativeAddonIds = [], traceId }) {
    const activeTraceId = traceId || makeTraceId("exact-slot");
    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    const start = _normalizeLocalIsoStr(localStartDate);
    const end = _normalizeLocalIsoStr(localEndDate);
    const requiredResourceId = _safeTrim(resourceId);
    if (!resolvedServiceId || !start || !end) {
        return { status: "ERROR", data: null, error: { code: "INVALID_SLOT_RECHECK", message: "Selected slot data is invalid." } };
    }

    try {
        const normalizedNativeAddonIds = Array.from(new Set(
            (Array.isArray(nativeAddonIds) ? nativeAddonIds : [])
            .map((id) => _safeTrim(id))
            .filter((id) => _looksLikeGuid(id))
        )).sort();

        let rawSlot = null;

        if (normalizedNativeAddonIds.length > 0) {
            const listPayload = {
                serviceId: String(resolvedServiceId),
                fromLocalDate: start,
                toLocalDate: end,
                timeZone: SDK_CONFIG.TZ,
                bookable: true,
                locations: [LOCATION_TS],
                includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID],
                customerChoices: { addOnIds: normalizedNativeAddonIds },
            };
            if (requiredResourceId) {
                listPayload.resourceTypes = [{ resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: [requiredResourceId] }];
            }

            const listed = await _executeWithRetry(
                () => withTimeout(availabilityTimeSlots.listAvailabilityTimeSlots(listPayload), WATCHDOG_TIMEOUT_MS, "listAvailabilityTimeSlots:addonRecheck"),
                2,
                300
            );
            rawSlot = (Array.isArray(listed?.timeSlots) ? listed.timeSlots : []).find((slot) =>
                _normalizeLocalIsoStr(slot?.localStartDate || slot?.startDate) === start &&
                _normalizeLocalIsoStr(slot?.localEndDate || slot?.endDate) === end &&
                slot?.bookable === true
            ) || null;
        } else {
            const getPayload = {
                serviceId: String(resolvedServiceId),
                localStartDate: start,
                localEndDate: end,
                location: LOCATION_TS,
                timeZone: SDK_CONFIG.TZ,
            };
            if (requiredResourceId) {
                getPayload.resourceTypes = [{ resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: [requiredResourceId] }];
            }

            const result = await _executeWithRetry(
                () => withTimeout(availabilityTimeSlots.getAvailabilityTimeSlot(getPayload), WATCHDOG_TIMEOUT_MS, "getAvailabilityTimeSlot"),
                2,
                300
            );
            rawSlot = result?.timeSlot || null;
        }

        const normalized = _attachServiceId(rawSlot, resolvedServiceId, activeTraceId, "revalidateExactAvailabilitySlot");
        const availableResourceIds = _getResourceIdsFromSlot(normalized);

        // [FIX] Validacion reforzada: bookable + al menos un recurso disponible
        if (
            !normalized ||
            normalized.bookable !== true ||
            availableResourceIds.length === 0
        ) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "SLOT_UNAVAILABLE",
                    message: "Selected slot is no longer available.",
                },
            };
        }
        if (requiredResourceId && !availableResourceIds.includes(requiredResourceId)) {
            return { status: "ERROR", data: null, error: { code: "STAFF_UNAVAILABLE", message: "Selected staff is no longer available for this slot." } };
        }

        return {
            status: "SUCCESS",
            data: {
                slot: { ...normalized, localStartDate: start, localEndDate: end },
                resourceId: requiredResourceId || (availableResourceIds.length === 1 ? availableResourceIds[0] : null),
                candidateResourceIds: availableResourceIds,
            },
            error: null,
        };
    } catch (error) {
        const httpStatus = Number(error?.httpStatus || error?.statusCode || error?.response?.status || 0) || null;
        const wixErrorCode = _safeTrim(error?.code || error?.details?.applicationError?.code) || "UNKNOWN";
        const requestedAddonCount = Array.isArray(nativeAddonIds) ? nativeAddonIds.length : 0;
        log.warn("Exact slot recheck failed", {
            traceId: activeTraceId,
            wixErrorCode,
            httpStatus,
            message: error?.message || String(error),
            serviceId: String(resolvedServiceId),
            localStartDate: start,
            localEndDate: end,
            locationId: LOCATION_TS.id,
            locationType: LOCATION_TS.locationType,
            requestedAddonCount,
            hasRequiredResource: Boolean(requiredResourceId),
        });
        return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "Selected slot could not be revalidated.", traceId: activeTraceId } };
    }
}

async function _listTimeSlotsV2({ serviceId, fromLocalDate, toLocalDate, resourceIds, nativeAddonIds = [] }, options = {}) {
    const { skipCache = false, timeSlotsPerDay } = options;
    const traceId = makeTraceId("slots");
    const fromKey = _normalizeLocalIsoStr(fromLocalDate);
    const toKey = _normalizeLocalIsoStr(toLocalDate);
    if (!fromKey || !toKey) return [];

    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    if (!resolvedServiceId) return [];

    const normalizedResourceIds = Array.isArray(resourceIds) ? resourceIds.map(String).filter(Boolean) : [];
    const normalizedNativeAddonIds = Array.from(new Set(
        (Array.isArray(nativeAddonIds) ? nativeAddonIds : [])
        .map((id) => _safeTrim(id))
        .filter((id) => _looksLikeGuid(id))
    )).sort();

    const resourceKey = normalizedResourceIds.slice().sort().join(",");
    const addonKey = normalizedNativeAddonIds.join(",");
    const cacheKey = `${String(resolvedServiceId)}__${resourceKey}__${addonKey}__${fromKey}__${toKey}__ts:${timeSlotsPerDay || 0}`;

    if (!skipCache) {
        const cached = availabilityCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < SLOTS_CACHE_TTL_MS) return cached.data;
        const inflight = inflightRequests.get(cacheKey);
        if (inflight) return inflight;
    }

    const p = (async () => {
        try {
            const resourceTypes = normalizedResourceIds.length ? [{ resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: normalizedResourceIds }] : [];
            const payload = {
                serviceId: String(resolvedServiceId),
                fromLocalDate: String(fromKey),
                toLocalDate: String(toKey),
                timeZone: SDK_CONFIG.TZ,
                bookable: true,
                locations: [LOCATION_TS],
                includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID],
            };
            if (resourceTypes.length) payload.resourceTypes = resourceTypes;
            if (normalizedNativeAddonIds.length > 0) payload.customerChoices = { addOnIds: normalizedNativeAddonIds };
            if (Number.isFinite(timeSlotsPerDay) && Number(timeSlotsPerDay) > 0) payload.timeSlotsPerDay = Number(timeSlotsPerDay);

            const data = await _executeWithRetry(
                () => withTimeout(availabilityTimeSlots.listAvailabilityTimeSlots(payload), WATCHDOG_TIMEOUT_MS, "listAvailabilityTimeSlots"),
                3,
                500
            );

            const rawSlots = Array.isArray(data?.timeSlots) ? data.timeSlots : [];
            const slots = rawSlots
                .map((s) => {
                    if (!s) return null;
                    const start = s.localStartDate || s.startDate || "";
                    const end = s.localEndDate || s.endDate || "";
                    const fixed = _attachServiceId(s, resolvedServiceId, traceId, "_listTimeSlotsV2");
                    if (!fixed) return null;
                    return { ...fixed, localStartDate: String(start), localEndDate: String(end) };
                })
                .filter((s) => s && s.localStartDate);

            if (!skipCache) _cacheSetBounded(availabilityCache, cacheKey, { data: slots, timestamp: Date.now() }, CACHE_MAX_SIZE);
            return slots;
        } catch (e) {
            log.error("_listTimeSlotsV2 failed", { traceId, message: e?.message });
            return [];
        }
    })();

    if (!skipCache) {
        inflightRequests.set(cacheKey, p);
        try {
            return await p;
        } finally {
            inflightRequests.delete(cacheKey);
        }
    }

    return await p;
}

async function _getBookedMinutesByResourceForDay(dateYMD, resourceIds, traceId) {
    const ymd = String(dateYMD || "").slice(0, 10);
    const ids = Array.isArray(resourceIds) ? resourceIds.map(String).filter(Boolean) : [];
    if (!ymd || ids.length === 0) return {};

    // [FIX] Campo canonico dateYmd (bookingCore.js)
    const q = wixData
        .query(CITAS_COL)
        .eq("dateYmd", ymd)
        .hasSome("resourceId", ids)
        .limit(1000);
    const res = await withTimeout(q.find({ suppressAuth: true }), WATCHDOG_TIMEOUT_MS, "balance:queryCitas").catch(() => null);
    const items = Array.isArray(res?.items) ? res.items : [];
    const minutes = {};
    ids.forEach((rid) => (minutes[rid] = 0));

    for (const it of items) {
        const rid = String(it?.resourceId || "").trim();
        if (!rid || minutes[rid] === undefined) continue;
        const start = it?.startDate ? new Date(it.startDate) : null;
        const end = it?.endDate ? new Date(it.endDate) : null;
        if (!(start instanceof Date) || isNaN(start.getTime())) continue;
        if (!(end instanceof Date) || isNaN(end.getTime())) continue;
        minutes[rid] += _minutesBetweenUtcDates(start, end);
    }
    return minutes;
}

async function _rankResourcesByLoad(candidateResourceIds, dateYMD, traceId) {
    const ids = Array.from(new Set(Array.isArray(candidateResourceIds) ? candidateResourceIds.map(String).filter(Boolean) : []));
    if (ids.length <= 1) return ids;
    const minutesMap = await _getBookedMinutesByResourceForDay(dateYMD, ids, traceId).catch(() => ({}));
    const names = {};
    await Promise.allSettled(ids.map(async (rid) => {
        names[rid] = (await _getStaffDisplayNamePublic(rid).catch(() => "")) || "";
    }));
    return ids.sort((a, b) => {
        const ma = Number(minutesMap[a] || 0);
        const mb = Number(minutesMap[b] || 0);
        if (ma !== mb) return ma - mb;
        const na = String(names[a] || a);
        const nb = String(names[b] || b);
        return na.localeCompare(nb);
    });
}

async function _pickLeastLoadedResource(candidateResourceIds, dateYMD, traceId) {
    const ranked = await _rankResourcesByLoad(candidateResourceIds, dateYMD, traceId);
    return ranked[0] || null;
}

async function _findNextSlotForServiceInternal(serviceId, fromLocalDateTime, requiredResourceId, traceId, sameDayOnly = false) {
    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    if (!resolvedServiceId) return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" } };

    const fromLocal = _normalizeLocalIsoStr(fromLocalDateTime);
    if (!fromLocal) return { status: "ERROR", data: null, error: { code: "INVALID_DATES", message: "fromLocalDateTime invalid" } };

    const startYMD = fromLocal.slice(0, 10);
    const mustHaveStaff = _looksLikeGuid(requiredResourceId);
    const resourceIds = mustHaveStaff ? _normalizeResourceIds(requiredResourceId, traceId) : [];
    const maxDayOffset = sameDayOnly ? 0 : DIAS_LIMITE;

    for (let i = 0; i <= maxDayOffset; i++) {
        const ymd = _addDaysYMD(startYMD, i);
        const dayFrom = i === 0 ? fromLocal : `${ymd}T00:00:00`;
        const dayTo = `${ymd}T23:59:59`;

        const slots = await _listTimeSlotsV2({ serviceId: resolvedServiceId, fromLocalDate: dayFrom, toLocalDate: dayTo, resourceIds }, { skipCache: true });
        const normFrom = _normalizeLocalIsoStr(dayFrom);
        const candidates = (slots || [])
            .filter((s) => _normalizeLocalIsoStr(s.localStartDate) >= normFrom)
            .sort((a, b) => String(a.localStartDate).localeCompare(String(b.localStartDate)));

        if (!candidates.length) continue;

        if (mustHaveStaff) {
            const required = String(requiredResourceId);
            const match = candidates.find((s) => _getResourceIdsFromSlot(s).includes(required));
            if (match) return { status: "SUCCESS", data: { slot: match, dayYMD: ymd }, error: null };
            continue;
        }

        return { status: "SUCCESS", data: { slot: candidates[0], dayYMD: ymd }, error: null };
    }

    return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "No available slot found in search window." } };
}

export async function _cleanExpiredDualSlotsInternal({ limit = 100, traceId = null } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
    const now = new Date();
    const result = await withTimeout(
        wixData.query(DUAL_CACHE_COL).lt("expiresAt", now).limit(safeLimit).find({ suppressAuth: true }),
        WATCHDOG_TIMEOUT_MS,
        "cleanExpiredDualSlotsQuery"
    );
    let removed = 0;
    for (const item of result?.items || []) {
        await withTimeout(wixData.remove(DUAL_CACHE_COL, item._id, { suppressAuth: true }), WATCHDOG_TIMEOUT_MS, "cleanExpiredDualSlotsRemove");
        removed += 1;
    }
    log.info("Expired dual cache entries cleaned", { removed, traceId });
    return { status: "SUCCESS", data: { removed }, error: null };
}

export async function _getCertifiedDualSlotsInternal(serviceId, resourceId, dateYMD, requestedAddonIds = []) {
    const traceId = makeTraceId("dual");
    if (!serviceId || !_isValidMadridYmd(dateYMD)) {
        return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "serviceId and valid Madrid dateYMD are required" } };
    }

    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    if (!resolvedServiceId) {
        return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" } };
    }

    const serviceRes = await _getServiceBySlugOrIdInternal(resolvedServiceId, traceId);
    if (!serviceRes || serviceRes.status !== "SUCCESS" || !serviceRes.data) {
        return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service catalog missing" } };
    }

    const service = serviceRes.data;
    const addonContext = _resolveAddonContext(service, requestedAddonIds);
    const linkedServiceId = service.linkFases || null;
    const isDual = service.permitirCombinar && !!linkedServiceId;
    const resourceIdsFilter = _normalizeResourceIds(resourceId, traceId);
    const rankedCandidateCache = new Map();

    async function _rankCandidates(candidateResourceIds) {
        const normalized = Array.from(new Set((candidateResourceIds || []).map(String).filter(Boolean)));
        const key = normalized.slice().sort().join("|");
        if (!key) return [];
        if (rankedCandidateCache.has(key)) return rankedCandidateCache.get(key);
        const ranked = await _rankResourcesByLoad(normalized, dateYMD, traceId);
        rankedCandidateCache.set(key, ranked);
        return ranked;
    }

    const fromLocalDate = `${dateYMD}T00:00:00`;
    const toLocalDate = `${dateYMD}T23:59:59`;
    const slotsF1 = await _listTimeSlotsV2({
        serviceId: resolvedServiceId,
        fromLocalDate,
        toLocalDate,
        resourceIds: resourceIdsFilter,
        nativeAddonIds: addonContext.nativeAddonIds,
    }, { skipCache: true });

    if (!isDual) {
        const out = [];
        for (const s1 of slotsF1 || []) {
            const candidateResourceIds = _getResourceIdsFromSlot(s1);
            const rankedCandidates = await _rankCandidates(candidateResourceIds);
            const chosen = rankedCandidates[0] || null;
            const pairToken = _generateUUID();
            const forcedSlot = _attachServiceId({ ...s1 }, resolvedServiceId, traceId, "single");
            if (!forcedSlot) continue;
            out.push({
                fase1: { slotRef: forcedSlot, resourceId: chosen || null },
                fase2: null,
                uiPairToken: pairToken,
                pairToken,
                candidateResourceIds,
                serviceId: resolvedServiceId,
                dateYMD,
            });
        }
        return { status: "SUCCESS", data: out, error: null };
    }

    const exposureMs = Math.max(0, Number(service.tiempoExposicion || 0)) * 60 * 1000;
    const pairs = [];
    for (const s1 of slotsF1 || []) {
        const s1EndLocal = _normalizeLocalIsoStr(s1.localEndDate);
        if (!s1EndLocal) continue;
        const s1EndUtc = getUtcDateFromMadridLocal(s1EndLocal);
        if (!s1EndUtc) continue;
        const earliestF2Utc = new Date(s1EndUtc.getTime() + exposureMs);
        const earliestF2Local = getMadridLocalStringNoZ(earliestF2Utc);
        const candidateResourceIds = _getResourceIdsFromSlot(s1);
        if (!candidateResourceIds.length) continue;

        const rankedCandidates = await _rankCandidates(candidateResourceIds);
        let chosenResourceId = null;
        let s2 = null;
        for (const candidateResourceId of rankedCandidates) {
            const nextF2 = await _findNextSlotForServiceInternal(linkedServiceId, earliestF2Local, candidateResourceId, traceId, true);
            if (nextF2?.status !== "SUCCESS" || !nextF2?.data?.slot) continue;
            const candidateF2 = nextF2.data.slot;
            const s2StartLocal = _normalizeLocalIsoStr(candidateF2.localStartDate || candidateF2.startDate);
            const s2EndLocal = _normalizeLocalIsoStr(candidateF2.localEndDate || candidateF2.endDate);
            if (!_isValidSlotRange(s1.localStartDate, s1.localEndDate) || !_isValidSlotRange(s2StartLocal, s2EndLocal)) continue;
            const s2StartUtc = getUtcDateFromMadridLocal(s2StartLocal);
            const gapMinutes = _minutesBetweenUtcDates(s1EndUtc, s2StartUtc);
            const minimumGapMinutes = Math.max(0, Number(service.tiempoExposicion || 0));
            if (gapMinutes < minimumGapMinutes || gapMinutes > MAX_DUAL_GAP_MINUTES) continue;
            const s2Staff = _getResourceIdsFromSlot(candidateF2);
            if (s2Staff.length > 0 && !s2Staff.includes(String(candidateResourceId))) continue;
            chosenResourceId = candidateResourceId;
            s2 = candidateF2;
            break;
        }
        if (!chosenResourceId || !s2) continue;

        const pairToken = _generateUUID();
        const forcedF1 = _attachServiceId({ ...s1 }, resolvedServiceId, traceId, "dual:F1");
        const forcedF2 = _attachServiceId({ ...s2 }, linkedServiceId, traceId, "dual:F2");
        if (!forcedF1 || !forcedF2) continue;

        pairs.push({
            fase1: { slotRef: forcedF1, resourceId: chosenResourceId },
            fase2: { slotRef: forcedF2, resourceId: chosenResourceId },
            uiPairToken: pairToken,
            pairToken,
            candidateResourceIds,
            serviceId: resolvedServiceId,
            dateYMD,
            earliestF2Local,
        });
    }

    if (pairs.length > 0) {
        const cachePromises = pairs.map((slotPair) => {
            const pairToken = slotPair.uiPairToken;
            const expiresAt = new Date(Date.now() + DUAL_CACHE_TTL_MS);
            const record = {
                _id: pairToken,
                pairToken,
                slotF1: slotPair.fase1?.slotRef || null,
                slotF2: slotPair.fase2?.slotRef || null,
                resourceId: slotPair.fase1?.resourceId || null,
                candidateResourceIds: slotPair.candidateResourceIds || [],
                serviceId: String(slotPair.serviceId),
                linkFases: String(linkedServiceId),
                dateYMD: String(dateYMD),
                expiresAt,
                createdAt: new Date(),
                status: "ACTIVE",
            };
            return wixData.save(DUAL_CACHE_COL, record, { suppressAuth: true }).catch(() => null);
        });
        await Promise.allSettled(cachePromises);
    }

    return { status: "SUCCESS", data: pairs, error: null };
}

export async function _invalidateCachesInternal(serviceId, dateYMD, resourceId, traceId = null) {
    const tId = traceId || makeTraceId("invalidate");
    const resolvedServiceId = (await _resolveServiceIdInternal(serviceId)) || _safeTrim(serviceId);
    const ymd = _safeTrim(dateYMD);
    if (!resolvedServiceId || !_isValidMadridYmd(ymd)) return { ok: true, traceId: tId, skipped: true };

    const prefix = `${String(resolvedServiceId)}__`;
    for (const k of availabilityCache.keys()) {
        if (String(k).startsWith(prefix)) availabilityCache.delete(k);
    }

    const yearMonth = String(ymd).slice(0, 7);
    const resourceIds = _normalizeResourceIds(resourceId, tId).sort().join(",");
    const daysCacheId = `${DAYS_CACHE_VERSION}__${String(resolvedServiceId)}__${_hashKey(resourceIds)}__${String(yearMonth)}`;
    try {
        await withTimeout(wixData.remove(DAYS_CACHE_COL, daysCacheId, { suppressAuth: true }), WATCHDOG_TIMEOUT_MS, "invalidateDaysCache");
    } catch (e) {
        const msg = String(e?.message || "");
        if (!msg.includes("WDE0073") && !msg.includes("does not exist") && !msg.includes("WD_ITEM_DOES_NOT_EXIST")) throw e;
    }

    try {
        const res = await withTimeout(
            (() => {
                let query = wixData.query(DUAL_CACHE_COL)
                    .eq("serviceId", String(resolvedServiceId))
                    .eq("dateYmd", String(ymd));
                const requestedResourceIds = _normalizeResourceIds(resourceId, tId);
                if (requestedResourceIds.length === 1) query = query.eq("resourceId", requestedResourceIds[0]);
                return query.limit(100).find({ suppressAuth: true });
            })(),
            WATCHDOG_TIMEOUT_MS,
            "invalidateDualCacheQuery"
        );
        await Promise.allSettled((res?.items || []).map((it) => wixData.remove(DUAL_CACHE_COL, it._id, { suppressAuth: true }).catch(() => null)));
    } catch (e) {
        log.warn("_invalidateCachesInternal: dual cache cleanup failed (best-effort)", { traceId: tId, message: e?.message });
    }

    return { ok: true, traceId: tId };
}

export const invalidateCachesInternal = webMethod(Permissions.Admin, async (serviceId, dateYMD, resourceId) => {
    const traceId = makeTraceId("wm-invalidate-internal");
    try {
        const res = await _invalidateCachesInternal(serviceId, dateYMD, resourceId, traceId);
        return { status: "SUCCESS", data: res, error: null };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "INVALIDATE_FAILED") };
    }
});

export const getAvailableDays = webMethod(Permissions.Anyone, async (serviceId, resourceId, year, month, addonIds = []) => {
    const traceId = makeTraceId("wm-days");
    try {
        const resolved = await _resolveServiceIdInternal(serviceId);
        if (!resolved) return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" } };

        const svcRes = await _getServiceBySlugOrIdInternal(resolved, traceId);
        const service = svcRes?.data;
        if (!service) return { status: "ERROR", data: null, error: { code: "SERVICE_CONFIG_MISSING", message: "Service configuration missing" } };

        const addonContext = _resolveAddonContext(service, addonIds);
        const resourceIds = _normalizeResourceIds(resourceId, traceId);

        const y = Number(year);
        const m = Number(month);
        if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
            return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "Invalid year/month" } };
        }

        const yearMonth = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
        const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG.TZ });
        const tomorrowStr = _addDaysYMD(todayStr, 1);
        const maxDateStr = _addDaysYMD(todayStr, DIAS_LIMITE);
        const firstDay = `${yearMonth}-01`;
        const lastDayNum = new Date(y, m, 0).getDate();
        const lastDay = `${yearMonth}-${String(lastDayNum).padStart(2, "0")}`;
        const fromLocal = tomorrowStr > firstDay ? tomorrowStr : firstDay;
        const toLocal = maxDateStr < lastDay ? maxDateStr : lastDay;

        if (fromLocal > toLocal) return { status: "SUCCESS", data: [], error: null };

        const slots = await _listTimeSlotsV2({
            serviceId: resolved,
            fromLocalDate: `${fromLocal}T00:00:00`,
            toLocalDate: `${toLocal}T23:59:59`,
            resourceIds,
            nativeAddonIds: addonContext.nativeAddonIds,
        }, { skipCache: true, timeSlotsPerDay: 1 });

        const dateSet = new Set();
        slots.forEach((s) => {
            if (s.localStartDate) dateSet.add(String(s.localStartDate).slice(0, 10));
        });

        return { status: "SUCCESS", data: _filterDaysByLimit(Array.from(dateSet).sort()), error: null };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "DAYS_QUERY_FAILED") };
    }
});

export const getCertifiedDualSlots = webMethod(Permissions.Anyone, async (serviceId, resourceId, dateYMD, addonIds = []) => {
    const traceId = makeTraceId("wm-dual");
    try {
        return await _getCertifiedDualSlotsInternal(serviceId, resourceId, dateYMD, addonIds);
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "DUAL_SLOTS_FAILED") };
    }
});

// =============================================================================
// NUCLEO REUTILIZABLE DE RESOLUCION DE STAFF
// Consumido por bookingSaga.js (contrato objeto).
// =============================================================================

export async function _resolveStaffForSlotInternal(params = {}) {
    const traceId = params.traceId || makeTraceId("staff-int");
    try {
        const serviceIdInput = params.serviceId;
        const f1Start = _normalizeLocalIsoStr(params.f1Start);
        const f1End = _normalizeLocalIsoStr(params.f1End || "");
        const f2Start = _normalizeLocalIsoStr(params.f2Start || "");
        const f2End = _normalizeLocalIsoStr(params.f2End || "");
        const addonIds = Array.isArray(params.addonIds) ? params.addonIds : [];
        const requestedResourceId = _safeTrim(params.requestedResourceId);

        const resolvedServiceId = await _resolveServiceIdInternal(serviceIdInput);
        if (!resolvedServiceId) {
            return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" } };
        }

        const svcRes = await _getServiceBySlugOrIdInternal(resolvedServiceId, traceId);
        const serviceCfg = svcRes?.data;
        if (!serviceCfg) {
            return { status: "ERROR", data: null, error: { code: "SERVICE_CONFIG_MISSING", message: "Service not in catalog" } };
        }

        if (!f1Start) {
            return { status: "ERROR", data: null, error: { code: "INVALID_DATES", message: "f1Start is required" } };
        }
        const dateYMD = String(f1Start).slice(0, 10);
        if (!_isValidMadridYmd(dateYMD)) {
            return { status: "ERROR", data: null, error: { code: "INVALID_DATES", message: "f1Start must be a valid Madrid local ISO" } };
        }

        const addonContext = _resolveAddonContext(serviceCfg, addonIds);
        const isAnyStaff = !requestedResourceId ||
            ["all", "any"].includes(requestedResourceId.toLowerCase());

        const slotsF1 = await _listTimeSlotsV2({
            serviceId: resolvedServiceId,
            fromLocalDate: `${dateYMD}T00:00:00`,
            toLocalDate: `${dateYMD}T23:59:59`,
            resourceIds: isAnyStaff ? [] : _normalizeResourceIds(requestedResourceId, traceId),
            nativeAddonIds: addonContext.nativeAddonIds,
        }, { skipCache: true });

        const normF1Start = _normalizeLocalIsoStr(f1Start);
        const slotF1Raw = (slotsF1 || []).find((s) =>
            _normalizeLocalIsoStr(s.localStartDate) === normF1Start
        );
        if (!slotF1Raw) {
            return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "F1 slot is no longer available." } };
        }

        const slotF1 = _attachServiceId(slotF1Raw, resolvedServiceId, traceId, "resolveStaffInternal:F1Norm");
        let candidateResourceIds = _getResourceIdsFromSlot(slotF1);
        const linkedServiceId = serviceCfg.permitirCombinar ? _safeTrim(serviceCfg.linkFases) : "";
        let slotF2 = null;

        if (linkedServiceId) {
            if (!f2Start) {
                return { status: "ERROR", data: null, error: { code: "F2_SLOT_REQUIRED", message: "Dual service requires the certified F2 slot." } };
            }
            const requestedF2Ymd = String(f2Start).slice(0, 10);
            if (requestedF2Ymd !== dateYMD) {
                return { status: "ERROR", data: null, error: { code: "F2_DIFFERENT_DAY", message: "F2 must occur on the same Madrid day as F1." } };
            }

            const nextF2 = await _findNextSlotForServiceInternal(
                linkedServiceId,
                f2Start,
                isAnyStaff ? null : requestedResourceId,
                traceId,
                true
            );
            if (nextF2?.status !== "SUCCESS" || !nextF2?.data?.slot) {
                return { status: "ERROR", data: null, error: { code: "F2_UNAVAILABLE", message: "F2 slot is no longer available." } };
            }
            slotF2 = nextF2.data.slot;

            const slotF1EndLocal = _normalizeLocalIsoStr(slotF1.localEndDate || slotF1.endDate);
            const f1EndUtc = getUtcDateFromMadridLocal(f1End || slotF1EndLocal);
            const f2StartLocalNorm = _normalizeLocalIsoStr(slotF2.localStartDate || slotF2.startDate);
            const f2EndLocalNorm = _normalizeLocalIsoStr(slotF2.localEndDate || slotF2.endDate);
            const f2StartUtc = getUtcDateFromMadridLocal(f2StartLocalNorm);
            const gapMinutes = _minutesBetweenUtcDates(f1EndUtc, f2StartUtc);
            const minimumGapMinutes = Math.max(0, Number(serviceCfg.tiempoExposicion || 0));
            if (!_isValidSlotRange(f2StartLocalNorm, f2EndLocalNorm) ||
                gapMinutes < minimumGapMinutes ||
                gapMinutes > MAX_DUAL_GAP_MINUTES) {
                return { status: "ERROR", data: null, error: { code: "INVALID_GAP", message: "F2 gap is outside the allowed range." } };
            }
            const candidatesF2 = _getResourceIdsFromSlot(slotF2);
            candidateResourceIds = candidateResourceIds.filter((id) => candidatesF2.includes(id));
        } else if (f2Start) {
            return { status: "ERROR", data: null, error: { code: "UNEXPECTED_F2_CONTEXT", message: "Simple service cannot include F2 context." } };
        }

        if (!candidateResourceIds.length) {
            return { status: "ERROR", data: null, error: { code: "STAFF_NOT_AVAILABLE", message: "No staff available for this combined slot." } };
        }
        if (!isAnyStaff && !candidateResourceIds.includes(requestedResourceId)) {
            return { status: "ERROR", data: null, error: { code: "STAFF_NOT_AVAILABLE", message: "Selected staff is not available for this combined slot." } };
        }

        const finalResourceId = isAnyStaff
            ? await _pickLeastLoadedResource(candidateResourceIds, dateYMD, traceId)
            : requestedResourceId;
        if (!finalResourceId) {
            return { status: "ERROR", data: null, error: { code: "STAFF_NOT_AVAILABLE", message: "No staff could be assigned." } };
        }

        const finalResourceName = (await _getStaffDisplayNamePublic(finalResourceId)) || STAFF_DEFAULT_NAME;
        return {
            status: "SUCCESS",
            data: {
                slotF1: _attachServiceId(slotF1, resolvedServiceId, traceId, "resolveStaffInternal:F1"),
                slotF2: slotF2 ? _attachServiceId(slotF2, linkedServiceId, traceId, "resolveStaffInternal:F2") : null,
                resourceId: finalResourceId,
                resourceName: finalResourceName,
                dayYMD: dateYMD,
            },
            error: null,
        };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "STAFF_RESOLVE_FAILED") };
    }
}

/**
 * Adaptador webMethod: firma posicional legacy.
 * Delega integramente en _resolveStaffForSlotInternal.
 */
export const resolveStaffForSlot = webMethod(
    Permissions.Anyone,
    async (serviceId, start1, rId, addonIds = [], dualContext = null) => {
        const traceId = makeTraceId("wm-staff");
        try {
            return await _resolveStaffForSlotInternal({
                serviceId,
                f1Start: start1,
                f1End: null,
                f2Start: dualContext?.start2 || null,
                f2End: dualContext?.end2 || null,
                requestedResourceId: rId,
                addonIds,
                traceId,
            });
        } catch (err) {
            return { status: "ERROR", data: null, error: _toPublicError(err, "STAFF_RESOLVE_FAILED") };
        }
    }
);
