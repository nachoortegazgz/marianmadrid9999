/**
 * ============================================================================
 * FILE: backend/reservas.web.js
 * VERSION: v5008.9-FINAL
 * RESPONSIBILITY: Availability engine, dual slots, staff pairing and caching.
 * STANDARDS: G10 ASCII Strict.
 *
 * FIXES HISTORICOS (v5008.3 a v5008.8):
 *  - FIX-1 a FIX-20: ver cabeceras previas.
 *
 * FIXES APLICADOS (v5008.9):
 *  - FIX-21: getAvailableSlots rechaza la combinacion durationRange+addons
 *            ANTES de enviar customerChoices (Wix no lo soporta).
 *  - FIX-22: getAvailableSlots rechaza servicios duales con SERVICE_IS_DUAL.
 *  - FIX-23: Consolidacion con bookingUtils.js:
 *              * cleanGuidList       (era _readOptionalImport2ResourceIds)
 *              * readDurationRange   (era _readDurationRange)
 *              * resolveExpectedSlotMinutes (era _resolveExpectedSlotMinutes)
 *              * resolveLinkedPhase2Duration (era _resolveLinkedPhase2Duration)
 *  - FIX-24: Eliminadas _resolveAddonContext y _resolveAddonContextPublic
 *            (dead code).
 * ============================================================================
 */

import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import { availabilityTimeSlots } from "@wix/bookings";

import {
  COLLECTIONS,
  SDK_CONFIG,
  SLOT_SEARCH,
  API,
  STAFF_DEFAULT_NAME
} from "backend/internalConfig";

import {
  makeTraceId,
  _safeTrim,
  _safeSlugOrId,
  _looksLikeGuid,
  _normalizeLocalIsoStr,
  getUtcDateFromMadridLocal,
  _executeWithRetry,
  withTimeout
} from "public/mmUtils";

import {
  cleanGuidList,
  readDurationRange,
  resolveExpectedSlotMinutes,
  resolveLinkedPhase2Duration
} from "backend/booking/bookingUtils";

import { logger } from "backend/logger";
import { getStaffDisplayName } from "backend/staff";

const log = logger;

function _readImport2Field(item, field) {
  if (!item || typeof item !== "object") return null;

  return (
    item[field] ??
    item.data?.[field] ??
    item.fields?.[field] ??
    null
  );
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
    id: _safeTrim(
      addon.id ||
      addon._id ||
      addon.addonId
    ),
    nombre: _safeTrim(
      addon.nombre ||
      addon.name ||
      addon.title
    ),
    precio: Number(
      addon.precio ??
      addon.price ??
      0
    ) || 0
  };
}

const SERVICIOS_COL = COLLECTIONS.SERVICIOS_CATALOGO;

const WATCHDOG_TIMEOUT_MS = SDK_CONFIG.TIMEOUTS.WATCHDOG_MS;
const SERVICE_CACHE_TTL_MS = SDK_CONFIG.CACHE.SERVICES_TTL_MS;

const DIAS_LIMITE = SLOT_SEARCH.DIAS_LIMITE;

const CACHE_MAX_SIZE = SDK_CONFIG.CACHE.MAX_ENTRIES;
const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;

const CONFIGURED_LOCATION_TYPE = _safeTrim(
  SDK_CONFIG.LOCATION_TYPES?.TIME_SLOTS
);

const LOCATION_TS = Object.freeze({
  id: SDK_CONFIG.LOCATION_ID,
  locationType:
    !CONFIGURED_LOCATION_TYPE ||
    CONFIGURED_LOCATION_TYPE === "BUSINESS"
      ? "OWNER_BUSINESS"
      : CONFIGURED_LOCATION_TYPE
});

const serviceCatalogRAM = new Map();

function _cacheSetBounded(map, key, value, maxSize) {
  if (map.has(key)) {
    map.delete(key);
  }

  map.set(key, value);

  if (map.size <= maxSize) return;

  const firstKey = map.keys().next().value;

  if (firstKey !== undefined) {
    map.delete(firstKey);
  }
}

function _toPublicError(
  err,
  fallbackCode = "INTERNAL_ERROR",
  fallbackMessage = "Internal Error"
) {
  return {
    code: String(err?.code || fallbackCode),
    message: String(err?.message || fallbackMessage)
  };
}

function _normalizeSlotShape(slot) {
  if (!slot || typeof slot !== "object") return null;

  if (slot.slot && typeof slot.slot === "object") {
    return {
      ...slot.slot,
      ...slot
    };
  }

  return slot;
}

function _attachServiceId(slot, forcedServiceId, traceId, ctx) {
  const normalizedSlot = _normalizeSlotShape(slot);

  if (!normalizedSlot) return null;

  const serviceId = _safeTrim(forcedServiceId);

  if (!serviceId || !_looksLikeGuid(serviceId)) {
    log.error("_attachServiceId: invalid serviceId", {
      traceId,
      ctx,
      serviceId
    });

    return null;
  }

  return {
    ...normalizedSlot,
    serviceId,
    ...(normalizedSlot.slot &&
    typeof normalizedSlot.slot === "object"
      ? {
          slot: {
            ...normalizedSlot.slot,
            serviceId
          }
        }
      : {})
  };
}

function _isValidMadridYmd(value) {
  const ymd = _safeTrim(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);

  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(
    Date.UTC(year, month - 1, day, 12, 0, 0)
  );

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function _addDaysYMD(ymd, days) {
  if (!_isValidMadridYmd(ymd)) return "";

  const parts = String(ymd).split("-").map(Number);

  const date = new Date(
    Date.UTC(
      parts[0],
      parts[1] - 1,
      parts[2],
      12,
      0,
      0
    )
  );

  date.setUTCDate(
    date.getUTCDate() + Number(days || 0)
  );

  return date.toLocaleDateString(
    "sv-SE",
    { timeZone: SDK_CONFIG.TZ }
  );
}

function _filterDaysByLimit(daysArray) {
  if (!Array.isArray(daysArray) || daysArray.length === 0) {
    return [];
  }

  const now = new Date();

  const todayStr = now.toLocaleDateString(
    "sv-SE",
    { timeZone: SDK_CONFIG.TZ }
  );

  const tomorrowStr = _addDaysYMD(todayStr, 1);
  const maxDateStr = _addDaysYMD(
    todayStr,
    DIAS_LIMITE
  );

  if (!tomorrowStr || !maxDateStr) return [];

  return daysArray.filter(
    (date) =>
      date >= tomorrowStr &&
      date <= maxDateStr
  );
}

function _normalizeResourceIds(resourceId, traceId) {
  if (!resourceId) return [];

  const normalized = _safeTrim(resourceId);

  if (
    !normalized ||
    ["all", "any"].includes(normalized.toLowerCase())
  ) {
    return [];
  }

  if (_looksLikeGuid(normalized)) {
    return [normalized];
  }

  log.warn(
    "_normalizeResourceIds: invalid resource identifier",
    {
      resourceId: normalized,
      traceId
    }
  );

  return [];
}

function _getResourceIdsFromSlot(slot) {
  const normalizedSlot = _normalizeSlotShape(slot);

  if (!normalizedSlot || typeof normalizedSlot !== "object") {
    return [];
  }

  let groups = [];

  if (Array.isArray(normalizedSlot.availableResources)) {
    groups = normalizedSlot.availableResources;
  } else if (
    normalizedSlot.slot &&
    typeof normalizedSlot.slot === "object" &&
    Array.isArray(normalizedSlot.slot.availableResources)
  ) {
    groups = normalizedSlot.slot.availableResources;
  }

  if (groups.length > 0) {
    const staffGroup = groups.find(
      (group) =>
        String(group?.resourceTypeId) ===
        String(STAFF_RESOURCE_TYPE_ID)
    );

    if (!staffGroup) return [];

    return Array.from(
      new Set(
        (staffGroup.resources || [])
          .map((resource) =>
            _safeTrim(
              resource?.id ||
              resource?._id ||
              resource?.resourceId
            )
          )
          .filter((resourceId) =>
            _looksLikeGuid(resourceId)
          )
      )
    );
  }

  const directId = _safeTrim(
    normalizedSlot.resource?.id ||
    normalizedSlot.resource?._id ||
    normalizedSlot.resource?.resourceId ||
    normalizedSlot.resourceId
  );

  return _looksLikeGuid(directId) ? [directId] : [];
}

function _minutesBetweenUtcDates(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date)) {
    return 0;
  }

  const milliseconds = b.getTime() - a.getTime();

  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return 0;
  }

  return Math.round(milliseconds / 60000);
}

function _isValidSlotRange(startLocal, endLocal) {
  const startUtc = getUtcDateFromMadridLocal(
    _normalizeLocalIsoStr(startLocal)
  );

  const endUtc = getUtcDateFromMadridLocal(
    _normalizeLocalIsoStr(endLocal)
  );

  return Boolean(
    startUtc &&
    endUtc &&
    endUtc.getTime() > startUtc.getTime()
  );
}

async function _verifyRequiredStaffViaGet({
  serviceId,
  start,
  end,
  requiredResourceId,
  nativeAddonIds,
  traceId
}) {
  const getPayload = {
    serviceId: String(serviceId),
    localStartDate: start,
    localEndDate: end,
    location: LOCATION_TS,
    timeZone: SDK_CONFIG.TZ,
    resourceTypes: [
      {
        resourceTypeId: STAFF_RESOURCE_TYPE_ID,
        resourceIds: [requiredResourceId]
      }
    ]
  };

  if (
    Array.isArray(nativeAddonIds) &&
    nativeAddonIds.length > 0
  ) {
    getPayload.customerChoices = {
      addOnIds: nativeAddonIds
    };
  }

  try {
    const result = await _executeWithRetry(
      () =>
        withTimeout(
          availabilityTimeSlots
            .getAvailabilityTimeSlot(
              getPayload
            ),
          WATCHDOG_TIMEOUT_MS,
          "exactSlot:verifyStaffGet"
        ),
      2,
      300
    );

    if (result?.timeSlot) {
      return {
        ok: true,
        slot: result.timeSlot,
        errorCode: null
      };
    }

    return {
      ok: false,
      slot: null,
      errorCode: "STAFF_UNAVAILABLE"
    };
  } catch (error) {
    log.warn(
      "getAvailabilityTimeSlot verification failed",
      {
        traceId,
        serviceId: String(serviceId),
        start,
        end,
        requiredResourceId,
        message: error?.message
      }
    );

    return {
      ok: false,
      slot: null,
      errorCode: "STAFF_UNAVAILABLE"
    };
  }
}

/**
 * FIX-18: Resuelve complementos por id o nativeId.
 */
function _getRequestedAddonContext(service, requestedAddonIds) {
  const requested = new Set(
    (Array.isArray(requestedAddonIds)
      ? requestedAddonIds
      : []
    )
      .map((id) => _safeTrim(id))
      .filter(Boolean)
  );

  const addons = Array.isArray(service?.metadata?.addons)
    ? service.metadata.addons
    : [];

  const selected = addons.filter((addon) => {
    const id = _safeTrim(addon?.id);
    const nativeId = _safeTrim(addon?.nativeId);

    return requested.has(id) || requested.has(nativeId);
  });

  return {
    nativeAddonIds: Array.from(
      new Set(
        selected
          .map((addon) =>
            _safeTrim(addon?.nativeId || addon?.id)
          )
          .filter((id) => _looksLikeGuid(id))
      )
    ),
    addons: selected
  };
}

function _resolveAddonContextInternal(
  service,
  requestedAddonIds
) {
  return _getRequestedAddonContext(
    service,
    requestedAddonIds
  );
}

async function _getStaffDisplayNamePublic(resourceId) {
  const id = _safeTrim(resourceId);

  if (!id || !_looksLikeGuid(id)) {
    return STAFF_DEFAULT_NAME;
  }

  try {
    const name = await getStaffDisplayName(id);

    return _safeTrim(name) || STAFF_DEFAULT_NAME;
  } catch (_) {
    return STAFF_DEFAULT_NAME;
  }
}

export async function _getServiceBySlugOrIdInternal(
  slugOrId,
  externalTraceId = null
) {
  const traceId =
    externalTraceId || makeTraceId("service");

  const raw = _safeTrim(slugOrId);
  const isGuid = _looksLikeGuid(raw);

  const clean = isGuid
    ? raw
    : _safeTrim(raw)
      ? String(raw)
          .split("?")[0]
          .split("#")[0]
          .replace(/^\//, "")
          .replace(/\/$/, "")
      : "";

  if (!clean) {
    return {
      status: "ERROR",
      data: null,
      error: {
        code: "SERVICE_NOT_FOUND",
        message: "Service identifier is required."
      }
    };
  }

  const cached = serviceCatalogRAM.get(clean);

  if (
    cached &&
    Date.now() - cached.timestamp < SERVICE_CACHE_TTL_MS
  ) {
    return {
      status: "SUCCESS",
      data: cached.data,
      error: null
    };
  }

  try {
    let result;

    if (isGuid) {
      result = await withTimeout(
        wixData
          .query(SERVICIOS_COL)
          .eq("serviceId", clean)
          .limit(1)
          .find({ suppressAuth: true }),
        WATCHDOG_TIMEOUT_MS,
        "getServiceBySlugOrId:serviceId"
      );
    } else {
      result = await withTimeout(
        wixData
          .query(SERVICIOS_COL)
          .eq("slugUrl", clean)
          .limit(1)
          .find({ suppressAuth: true }),
        WATCHDOG_TIMEOUT_MS,
        "getServiceBySlugOrId:slugUrl"
      );

      if (
        !result?.items?.[0] &&
        _looksLikeGuid(clean)
      ) {
        result = await withTimeout(
          wixData
            .query(SERVICIOS_COL)
            .eq("serviceId", clean)
            .limit(1)
            .find({ suppressAuth: true }),
          WATCHDOG_TIMEOUT_MS,
          "getServiceBySlugOrId:guidFallback"
        );
      }
    }

    const service = result?.items?.[0] || null;

    if (!service) {
      log.error("Service not found in catalog", {
        key: clean,
        traceId
      });

      return {
        status: "ERROR",
        data: null,
        error: {
          code: "SERVICE_NOT_FOUND",
          message: "Service not found."
        }
      };
    }

    const mapped = await _mapServiceImport2ToUX(
      service,
      traceId
    );

    const cacheEntry = {
      data: mapped,
      timestamp: Date.now()
    };

    _cacheSetBounded(
      serviceCatalogRAM,
      clean,
      cacheEntry,
      CACHE_MAX_SIZE
    );

    if (mapped.serviceId) {
      _cacheSetBounded(
        serviceCatalogRAM,
        mapped.serviceId,
        cacheEntry,
        CACHE_MAX_SIZE
      );
    }

    if (mapped.slugUrl) {
      _cacheSetBounded(
        serviceCatalogRAM,
        mapped.slugUrl,
        cacheEntry,
        CACHE_MAX_SIZE
      );
    }

    return {
      status: "SUCCESS",
      data: mapped,
      error: null
    };
  } catch (error) {
    log.error("Error loading service", {
      traceId,
      message: error?.message
    });

    return {
      status: "ERROR",
      data: null,
      error: {
        code: "DATABASE_ERROR",
        message:
          error?.message ||
          "Error loading service."
      }
    };
  }
}

export async function _resolveServiceIdInternal(serviceIdReq) {
  const raw = _safeTrim(serviceIdReq);

  if (!raw) return null;

  const key = _looksLikeGuid(raw)
    ? raw
    : _safeSlugOrId(raw);

  if (!key) return null;

  const result =
    await _getServiceBySlugOrIdInternal(key);

  if (
    result?.status === "SUCCESS" &&
    result?.data?.serviceId
  ) {
    const serviceId = _safeTrim(
      result.data.serviceId
    );

    if (_looksLikeGuid(serviceId)) {
      return serviceId;
    }
  }

  return null;
}

export async function _mapServiceImport2ToUX(
  service,
  traceId
) {
  const serviceId = _safeTrim(
    _readImport2Field(service, "serviceId")
  );

  if (!_looksLikeGuid(serviceId)) {
    throw new Error(
      "Catalog serviceId is missing or invalid."
    );
  }

  const hidden = _readImport2Field(
    service,
    "hidden"
  ) === true;

  const allowCombine =
    !hidden &&
    _readImport2Field(
      service,
      "allowCombine"
    ) === true;

  const linkedPhases = _safeTrim(
    _readImport2Field(
      service,
      "linkedPhases"
    )
  );

  if (
    allowCombine &&
    !_looksLikeGuid(linkedPhases)
  ) {
    throw new Error(
      "Dual service linkedPhases is missing or invalid."
    );
  }

  if (
    allowCombine &&
    _looksLikeGuid(linkedPhases) &&
    linkedPhases === serviceId
  ) {
    throw new Error(
      "A service cannot link to itself (linkedPhases === serviceId)."
    );
  }

  const phase1Duration = Number(
    _readImport2Field(
      service,
      "phase1Duration"
    )
  ) || 0;

  const exposureDuration = Number(
    _readImport2Field(
      service,
      "exposureDuration"
    )
  ) || 0;

  let phase2Duration = Number(
    _readImport2Field(
      service,
      "phase2Duration"
    )
  ) || 0;

  // FIX-23: usa resolveLinkedPhase2Duration de bookingUtils.
  if (allowCombine && _looksLikeGuid(linkedPhases)) {
    const visited = new Set([serviceId]);

    const resolved = await resolveLinkedPhase2Duration(
      linkedPhases,
      traceId,
      visited,
      _getServiceBySlugOrIdInternal
    );

    if (resolved > 0) {
      phase2Duration = resolved;
    }
  }

  const totalDuration = Number(
    _readImport2Field(
      service,
      "totalDuration"
    )
  ) || 0;

  const buffer = Number(
    _readImport2Field(
      service,
      "buffer"
    )
  ) || 0;

  const title = _safeTrim(
    _readImport2Field(service, "title")
  ) || "Service";

  const price = Number(
    _readImport2Field(service, "price")
  ) || 0;

  const currency = _safeTrim(
    _readImport2Field(service, "currency")
  ) || "EUR";

  const pricingModel = _safeTrim(
    _readImport2Field(service, "pricingModel")
  ) || null;

  const slugUrl = _safeTrim(
    _readImport2Field(service, "slugUrl")
  ) || null;

  const serviceType = _safeTrim(
    _readImport2Field(service, "serviceType")
  ) || null;

  const sku = _safeTrim(
    _readImport2Field(service, "sku")
  ) || null;

  const depositAmount = Number(
    _readImport2Field(service, "depositAmount")
  ) || 0;

  const depositType = _safeTrim(
    _readImport2Field(service, "depositType")
  ) || null;

  const onlinePayment =
    _readImport2Field(
      service,
      "onlinePayment"
    ) === true;

  const inPersonPayment =
    _readImport2Field(
      service,
      "inPersonPayment"
    ) === true;

  const taxIncluded =
    _readImport2Field(
      service,
      "taxIncluded"
    ) === true;

  const taxRate = Number(
    _readImport2Field(service, "taxRate")
  ) || 0;

  const categoryId = _safeTrim(
    _readImport2Field(service, "categoryId")
  ) || null;

  const categoryName = _safeTrim(
    _readImport2Field(service, "categoryName")
  ) || null;

  const locationId = _safeTrim(
    _readImport2Field(service, "locationId")
  ) || null;

  const location = _safeTrim(
    _readImport2Field(service, "location")
  ) || null;

  const imageUrl = _safeTrim(
    _readImport2Field(service, "mainMedia")
  ) || "";

  const shortDescription = _safeTrim(
    _readImport2Field(service, "tagLine")
  ) || null;

  const longDescription = _safeTrim(
    _readImport2Field(service, "description")
  ) || null;

  const internalNotes = _safeTrim(
    _readImport2Field(service, "internalNotes")
  ) || null;

  // FIX-23: usa readDurationRange de bookingUtils.
  const durationRange = readDurationRange(service);

  const estimatedTotal =
    totalDuration ||
    (
      allowCombine
        ? phase1Duration +
          exposureDuration +
          phase2Duration
        : phase1Duration
    ) ||
    30;

  // FIX-23: usa cleanGuidList de bookingUtils.
  const staffDisponible = cleanGuidList(
    _readImport2Field(service, "availableStaff")
  );

  const staffOptions = await Promise.all(
    staffDisponible.map(async (resourceId) => {
      const displayName =
        await _getStaffDisplayNamePublic(
          resourceId
        );

      return {
        id: resourceId,
        value: resourceId,
        name: displayName,
        label: displayName
      };
    })
  );

  const addons = _parseImport2Addons(
    _readImport2Field(
      service,
      "addOnOptions"
    )
  )
    .map(_normalizeImport2Addon)
    .filter(Boolean);

  return {
    serviceId,
    slugUrl,
    serviceType,
    sku,
    categoryId,
    categoryName,
    locationId,
    localizacion: location,
    internalNotes,

    linkFases: allowCombine
      ? linkedPhases
      : null,

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

    linkedPhases: allowCombine
      ? linkedPhases
      : null,

    allowCombine,
    phase1Duration,
    exposureDuration,
    phase2Duration,
    totalDuration: estimatedTotal,
    hidden,

    durationRange,

    metadata: {
      titulo: title,
      tituloServicio: title,
      precio: price,
      duracionTotal: estimatedTotal,
      localizacion: location,
      resumenCorto: shortDescription,
      descripcionLarga: longDescription,
      pricingModel,
      addons,
      addonsPrecio: addons.map(
        (addon) => Number(
          addon?.precio || 0
        )
      ),
      imageUrl,
      currency,
      taxRate,
      pricing: {
        base: price,
        currency
      },
      timing: {
        estimatedTotal,
        totalDuration: estimatedTotal
      },
      durationRange
    }
  };
}

export async function getServiceForBookingInternal(
  serviceId,
  traceId = null
) {
  return _getServiceBySlugOrIdInternal(
    serviceId,
    traceId || makeTraceId("service-internal")
  );
}

export const getServiceBySlugOrId = webMethod(
  Permissions.Anyone,
  async (slugOrId) => {
    const traceId = makeTraceId("wm-service");

    try {
      const result =
        await _getServiceBySlugOrIdInternal(
          slugOrId,
          traceId
        );

      if (result?.status !== "SUCCESS") {
        return result;
      }

      return {
        status: "SUCCESS",
        data: _toPublicService(result.data),
        error: null
      };
    } catch (error) {
      return {
        status: "ERROR",
        data: null,
        error: _toPublicError(
          error,
          "SERVICE_LOOKUP_FAILED"
        )
      };
    }
  }
);

export const resolveServiceId = webMethod(
  Permissions.Anyone,
  async (serviceIdRequest) => {
    try {
      const resolved =
        await _resolveServiceIdInternal(
          serviceIdRequest
        );

      if (!resolved) {
        return {
          status: "ERROR",
          data: null,
          error: {
            code: "SERVICE_NOT_FOUND",
            message: "Service identifier not found."
          }
        };
      }

      return {
        status: "SUCCESS",
        data: String(resolved),
        error: null
      };
    } catch (error) {
      return {
        status: "ERROR",
        data: null,
        error: _toPublicError(
          error,
          "SERVICE_RESOLVE_FAILED"
        )
      };
    }
  }
);

export function _toPublicService(service) {
  if (!service || typeof service !== "object") {
    return null;
  }

  const {
    linkFases,
    internalNotes,
    ...publicService
  } = service;

  return {
    ...publicService,
    linkedPhases:
      publicService.linkedPhases || null
  };
}

/**
 * FIX-20 + FIX-21 + FIX-22: Disponibilidad single-service.
 *  - Rechaza servicios duales (SERVICE_IS_DUAL).
 *  - Rechaza durationRange + addons antes de customerChoices.
 *  - Filtra slots bookable y adjunta serviceId validado.
 */
export const getAvailableSlots = webMethod(
  Permissions.Anyone,
  async (
    serviceIdOrSlug,
    resourceId,
    dateYMD,
    addonIds = []
  ) => {
    const traceId = makeTraceId("available-slots");

    try {
      const serviceResult =
        await _getServiceBySlugOrIdInternal(
          serviceIdOrSlug,
          traceId
        );

      if (
        serviceResult?.status !== "SUCCESS" ||
        !serviceResult.data?.serviceId
      ) {
        return {
          status: "ERROR",
          data: null,
          error: {
            code: "SERVICE_NOT_FOUND",
            message: "Service not found."
          }
        };
      }

      const service = serviceResult.data;
      const serviceId = service.serviceId;

      // FIX-22: getAvailableSlots es solo para servicios single.
      if (service.allowCombine === true) {
        log.warn(
          "FIX-22: getAvailableSlots called for dual service",
          {
            traceId,
            serviceId: String(serviceId)
          }
        );

        return {
          status: "ERROR",
          data: null,
          error: {
            code: "SERVICE_IS_DUAL",
            message:
              "Use getCertifiedDualSlots for dual services."
          }
        };
      }

      const requestedResourceId =
        _normalizeResourceIds(resourceId, traceId);

      const addonContext =
        _resolveAddonContextInternal(
          service,
          addonIds
        );

      // FIX-21: durationRange + addons no soportado por Wix.
      if (
        addonContext.nativeAddonIds.length > 0 &&
        service.durationRange
      ) {
        log.warn(
          "FIX-21: durationRange + addons combination not supported",
          {
            traceId,
            serviceId: String(serviceId),
            durationRange: service.durationRange,
            addonCount: addonContext.nativeAddonIds.length
          }
        );

        return {
          status: "ERROR",
          data: null,
          error: {
            code: "DURATION_RANGE_WITH_ADDONS_NOT_SUPPORTED",
            message:
              "Services with a duration range cannot be combined with addons."
          }
        };
      }

      const ymd = _safeTrim(dateYMD);

      if (!_isValidMadridYmd(ymd)) {
        return {
          status: "ERROR",
          data: null,
          error: {
            code: "INVALID_DATE",
            message: "Invalid booking date."
          }
        };
      }

      const payload = {
        serviceId: String(serviceId),
        fromLocalDate: `${ymd}T00:00:00`,
        toLocalDate: `${ymd}T23:59:59`,
        timeZone: SDK_CONFIG.TZ,
        bookable: true,
        locations: [LOCATION_TS],
        includeResourceTypeIds: [
          STAFF_RESOURCE_TYPE_ID
        ]
      };

      if (requestedResourceId.length > 0) {
        payload.resourceTypes = [
          {
            resourceTypeId: STAFF_RESOURCE_TYPE_ID,
            resourceIds: requestedResourceId
          }
        ];
      }

      if (addonContext.nativeAddonIds.length > 0) {
        payload.customerChoices = {
          addOnIds: addonContext.nativeAddonIds
        };
      }

      const result = await _executeWithRetry(
        () =>
          withTimeout(
            availabilityTimeSlots.listAvailabilityTimeSlots(
              payload
            ),
            WATCHDOG_TIMEOUT_MS,
            "getAvailableSlots"
          ),
        2,
        300
      );

      const timeSlots = Array.isArray(
        result?.timeSlots
      )
        ? result.timeSlots
        : [];

      const slots = timeSlots
        .filter((slot) => slot?.bookable === true)
        .map((slot) =>
          _attachServiceId(
            slot,
            serviceId,
            traceId,
            "getAvailableSlots"
          )
        )
        .filter(Boolean);

      return {
        status: "SUCCESS",
        data: {
          slots,
          serviceId,
          dateYMD: ymd,
          resourceId:
            requestedResourceId[0] || null
        },
        error: null
      };
    } catch (error) {
      log.warn("getAvailableSlots failed", {
        traceId,
        serviceIdOrSlug: _safeTrim(serviceIdOrSlug),
        dateYMD: _safeTrim(dateYMD),
        message: error?.message
      });

      return {
        status: "ERROR",
        data: null,
        error: {
          code: "AVAILABLE_SLOTS_FAILED",
          message:
            "Could not load available slots."
        }
      };
    }
  }
);

export async function revalidateExactAvailabilitySlot({
  serviceId,
  localStartDate,
  localEndDate,
  resourceId,
  nativeAddonIds = [],
  traceId
}) {
  const activeTraceId =
    traceId || makeTraceId("exact-slot");

  const resolvedServiceId =
    await _resolveServiceIdInternal(serviceId);

  const start = _normalizeLocalIsoStr(
    localStartDate
  );

  const end = _normalizeLocalIsoStr(
    localEndDate
  );

  const rawResourceId = _safeTrim(resourceId);
  const requiredResourceId =
    _looksLikeGuid(rawResourceId)
      ? rawResourceId
      : "";

  if (
    !resolvedServiceId ||
    !start ||
    !end ||
    !_isValidSlotRange(start, end)
  ) {
    return {
      status: "ERROR",
      data: null,
      error: {
        code: "INVALID_SLOT_RECHECK",
        message: "Selected slot data is invalid."
      }
    };
  }

  try {
    const normalizedAddonIds = Array.from(
      new Set(
        (Array.isArray(nativeAddonIds)
          ? nativeAddonIds
          : []
        )
          .map((id) => _safeTrim(id))
          .filter((id) => _looksLikeGuid(id))
      )
    ).sort();

    const earlyServiceConfig =
      await _getServiceBySlugOrIdInternal(
        resolvedServiceId,
        activeTraceId
      );

    const serviceDurationRange =
      earlyServiceConfig?.status === "SUCCESS" &&
      earlyServiceConfig?.data?.durationRange
        ? earlyServiceConfig.data.durationRange
        : null;

    if (
      normalizedAddonIds.length > 0 &&
      serviceDurationRange
    ) {
      log.warn(
        "durationRange + addons combination not supported",
        {
          traceId: activeTraceId,
          serviceId: String(resolvedServiceId),
          durationRange: serviceDurationRange,
          addonCount: normalizedAddonIds.length
        }
      );

      return {
        status: "ERROR",
        data: null,
        error: {
          code: "DURATION_RANGE_WITH_ADDONS_NOT_SUPPORTED",
          message:
            "Services with a duration range cannot be combined with addons.",
          traceId: activeTraceId
        }
      };
    }

    let rawSlot = null;

    if (normalizedAddonIds.length > 0) {
      const listPayload = {
        serviceId: String(resolvedServiceId),
        fromLocalDate: start,
        toLocalDate: end,
        timeZone: SDK_CONFIG.TZ,
        bookable: true,
        locations: [LOCATION_TS],
        includeResourceTypeIds: [
          STAFF_RESOURCE_TYPE_ID
        ],
        customerChoices: {
          addOnIds: normalizedAddonIds
        }
      };

      if (requiredResourceId) {
        listPayload.resourceTypes = [
          {
            resourceTypeId:
              STAFF_RESOURCE_TYPE_ID,
            resourceIds: [requiredResourceId]
          }
        ];
      }

      const listed =
        await _executeWithRetry(
          () =>
            withTimeout(
              availabilityTimeSlots
                .listAvailabilityTimeSlots(
                  listPayload
                ),
              WATCHDOG_TIMEOUT_MS,
              "exactSlot:list"
            ),
          2,
          300
        );

      rawSlot = (
        Array.isArray(listed?.timeSlots)
          ? listed.timeSlots
          : []
      ).find((slot) => {
        const slotStart =
          _normalizeLocalIsoStr(
            slot?.localStartDate ||
            slot?.startDate
          );

        const slotEnd =
          _normalizeLocalIsoStr(
            slot?.localEndDate ||
            slot?.endDate
          );

        return (
          slotStart === start &&
          slotEnd === end &&
          slot?.bookable === true
        );
      }) || null;
    } else {
      const getPayload = {
        serviceId: String(resolvedServiceId),
        localStartDate: start,
        localEndDate: end,
        location: LOCATION_TS,
        timeZone: SDK_CONFIG.TZ
      };

      if (requiredResourceId) {
        getPayload.resourceTypes = [
          {
            resourceTypeId:
              STAFF_RESOURCE_TYPE_ID,
            resourceIds: [requiredResourceId]
          }
        ];
      }

      const result =
        await _executeWithRetry(
          () =>
            withTimeout(
              availabilityTimeSlots
                .getAvailabilityTimeSlot(
                  getPayload
                ),
              WATCHDOG_TIMEOUT_MS,
              "exactSlot:get"
            ),
          2,
          300
        );

      rawSlot = result?.timeSlot || null;
    }

    if (requiredResourceId) {
      const verification =
        await _verifyRequiredStaffViaGet({
          serviceId: resolvedServiceId,
          start,
          end,
          requiredResourceId,
          nativeAddonIds: normalizedAddonIds,
          traceId: activeTraceId
        });

      if (!verification.ok) {
        return {
          status: "ERROR",
          data: null,
          error: {
            code: "STAFF_UNAVAILABLE",
            message:
              "Selected staff is no longer available.",
            traceId: activeTraceId
          }
        };
      }

      rawSlot = verification.slot;
    } else if (!rawSlot) {
      return {
        status: "ERROR",
        data: null,
        error: {
          code: "SLOT_UNAVAILABLE",
          message:
            "Selected slot is no longer available."
        }
      };
    }

    const normalizedSlot = _attachServiceId(
      rawSlot,
      resolvedServiceId,
      activeTraceId,
      "revalidateExactAvailabilitySlot"
    );

    const availableResourceIds =
      _getResourceIdsFromSlot(
        normalizedSlot
      );

    if (
      !normalizedSlot ||
      normalizedSlot.bookable !== true ||
      availableResourceIds.length === 0
    ) {
      return {
        status: "ERROR",
        data: null,
        error: {
          code: "SLOT_UNAVAILABLE",
          message:
            "Selected slot is no longer available."
        }
      };
    }

    if (
      requiredResourceId &&
      !availableResourceIds.includes(
        requiredResourceId
      )
    ) {
      return {
        status: "ERROR",
        data: null,
        error: {
          code: "STAFF_UNAVAILABLE",
          message:
            "Selected staff is no longer available."
        }
      };
    }

    if (
      earlyServiceConfig?.status === "SUCCESS" &&
      earlyServiceConfig?.data
    ) {
      const config = earlyServiceConfig.data;
      const startUtc = getUtcDateFromMadridLocal(start);
      const endUtc = getUtcDateFromMadridLocal(end);
      const actualMinutes =
        _minutesBetweenUtcDates(startUtc, endUtc);

      const durationRange = config.durationRange;

      if (
        durationRange &&
        actualMinutes > 0
      ) {
        const { min, max } = durationRange;

        const belowMin =
          min > 0 && actualMinutes < min;

        const aboveMax =
          max !== Infinity && actualMinutes > max;

        if (belowMin || aboveMax) {
          log.warn(
            "Slot duration out of range",
            {
              traceId: activeTraceId,
              serviceId: String(resolvedServiceId),
              actualMinutes,
              min,
              max,
              start,
              end
            }
          );

          return {
            status: "ERROR",
            data: null,
            error: {
              code: "SLOT_DURATION_OUT_OF_RANGE",
              message:
                "Selected slot duration is out of the allowed range.",
              traceId: activeTraceId
            }
          };
        }
      } else {
        // FIX-23: usa resolveExpectedSlotMinutes de bookingUtils.
        const expectedMinutes =
          resolveExpectedSlotMinutes(config);

        if (expectedMinutes > 0) {
          if (
            actualMinutes > 0 &&
            Math.abs(actualMinutes - expectedMinutes) > 1
          ) {
            log.warn(
              "Slot duration mismatch",
              {
                traceId: activeTraceId,
                serviceId: String(resolvedServiceId),
                allowCombine:
                  config.allowCombine === true,
                expectedMinutes,
                actualMinutes,
                start,
                end
              }
            );

            return {
              status: "ERROR",
              data: null,
              error: {
                code: "SLOT_DURATION_MISMATCH",
                message:
                  "Selected slot duration does not match service configuration.",
                traceId: activeTraceId
              }
            };
          }
        }
      }
    }

    return {
      status: "SUCCESS",
      data: {
        slot: {
          ...normalizedSlot,
          localStartDate: start,
          localEndDate: end
        },
        resourceId:
          requiredResourceId ||
          (
            availableResourceIds.length === 1
              ? availableResourceIds[0]
              : null
          ),
        candidateResourceIds:
          availableResourceIds
      },
      error: null
    };
  } catch (error) {
    log.warn(
      "Exact slot revalidation failed",
      {
        traceId: activeTraceId,
        serviceId: String(resolvedServiceId),
        start,
        end,
        message: error?.message
      }
    );
    return {
      status: "ERROR",
      data: null,
      error: {
        code: "SLOT_UNAVAILABLE",
        message:
          "Selected slot could not be revalidated.",
        traceId: activeTraceId
      }
    };
  }
}
