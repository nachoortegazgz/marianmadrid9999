/*
=============================================================================
MODULE: backend/booking/bookingUtils.js
VERSION: v5008.2-FINAL
BASE: v5002.6 + consolidacion de helpers compartidos
STANDARDS: G10 ASCII Strict

RESPONSIBILITY: Helpers compartidos entre reservas, citas, bookingSaga y
                bookingCore. Elimina duplicacion y garantiza coherencia.

FIXES APLICADOS:
  - FIX-18: cleanGuid, cleanGuidList (unificado).
  - FIX-26: numberOrZero, booleanValue.
  - FIX-16: toUtcRange (conversion Madrid -> UTC).
  - FIX-17: validateSlotDuration (dual mode: range o fijo).

COMPATIBILIDAD:
  - Conserva las firmas de v5002.6 para no romper consumidores actuales.
  - resolveLinkedPhase2Duration mantiene el patron (linkedId, traceId,
    visited, resolver).
=============================================================================
*/

import {
    _safeTrim,
    _looksLikeGuid,
    _normalizeLocalIsoStr,
    getUtcDateFromMadridLocal,
} from "public/mmUtils";

import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// BLOQUE 1 - GUID Y COERCION
// =============================================================================

/**
 * Valida y normaliza un GUID. Lanza error si no es valido.
 */
export function cleanGuid(value, errorCode = "INVALID_GUID") {
    const clean = _safeTrim(value);

    if (!clean || !_looksLikeGuid(clean)) {
        throw new Error(`${errorCode}: GUID invalido o ausente`);
    }

    return clean;
}

/**
 * Extrae lista unica de GUIDs validos desde:
 *   - array de strings
 *   - array de objetos con resourceId | id | _id
 *   - string separado por comas
 */
export function cleanGuidList(value) {
    const source = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? value.split(",")
            : [];

    return Array.from(
        new Set(
            source
                .map((item) => {
                    if (typeof item === "string") {
                        return _safeTrim(item);
                    }

                    return _safeTrim(
                        item?.resourceId ||
                        item?.id ||
                        item?._id
                    );
                })
                .filter((id) => _looksLikeGuid(id))
        )
    );
}

/**
 * Coerciona a numero no negativo. 0 si no es finito o < 0.
 */
export function numberOrZero(value) {
    const number = Number(value);

    return Number.isFinite(number) && number >= 0
        ? number
        : 0;
}

/**
 * Devuelve true si alguno de los valores es estrictamente `true`.
 */
export function booleanValue(...values) {
    return values.some((value) => value === true);
}

// =============================================================================
// BLOQUE 2 - GAP Y UTC RANGES
// =============================================================================

/**
 * Gap en minutos entre dos Date UTC. 0 si no valido o F2 < F1.
 */
export function computeGapMinutes(f1EndUtc, f2StartUtc) {
    if (
        !(f1EndUtc instanceof Date) ||
        !(f2StartUtc instanceof Date)
    ) {
        return 0;
    }

    const milliseconds =
        f2StartUtc.getTime() - f1EndUtc.getTime();

    return Math.max(
        0,
        Math.round(milliseconds / 60000)
    );
}

/**
 * Convierte un par de strings locales Madrid a { startUtc, endUtc }.
 * Devuelve null si alguna conversion falla o end <= start.
 */
export function toUtcRange(startLocal, endLocal) {
    const startUtc = getUtcDateFromMadridLocal(
        _normalizeLocalIsoStr(startLocal)
    );

    const endUtc = getUtcDateFromMadridLocal(
        _normalizeLocalIsoStr(endLocal)
    );

    if (!startUtc || !endUtc) {
        return null;
    }

    if (endUtc.getTime() <= startUtc.getTime()) {
        return null;
    }

    return { startUtc, endUtc };
}

// =============================================================================
// BLOQUE 3 - DURATION RANGE
// =============================================================================

/**
 * Detecta durationRange en un item del catalogo.
 *
 * Soporta:
 *   - availabilityConstraints.durationRange.{minDuration, maxDuration}
 *   - availabilityConstraints.durationRange.{min, max}
 *   - durationRange.{minDuration, maxDuration}
 *   - durationRange.{min, max}
 *
 * Devuelve { min, max } o null.
 */
export function readDurationRange(item) {
    const constraints =
        item?.availabilityConstraints ||
        item?.data?.availabilityConstraints ||
        item?.fields?.availabilityConstraints;

    const range =
        constraints?.durationRange ||
        item?.durationRange ||
        item?.data?.durationRange ||
        item?.fields?.durationRange;

    if (!range || typeof range !== "object") {
        return null;
    }

    const min = Number(
        range.minDuration ??
        range.min ??
        0
    ) || 0;

    const rawMax = Number(
        range.maxDuration ??
        range.max ??
        0
    ) || 0;

    const max = rawMax > 0 ? rawMax : Infinity;

    if (min <= 0 && max === Infinity) {
        return null;
    }

    if (max !== Infinity && max <= min) {
        return null;
    }

    return { min, max };
}

// =============================================================================
// BLOQUE 4 - DURACION EFECTIVA
// =============================================================================

/**
 * Duracion esperada del slot para servicios SIN durationRange.
 *
 * - allowCombine=true: F1 => phase1Duration.
 * - allowCombine=false: phase1Duration || totalDuration || estimatedTotal.
 */
export function resolveExpectedSlotMinutes(serviceConfig) {
    if (!serviceConfig) {
        return 0;
    }

    if (serviceConfig.allowCombine === true) {
        return Number(
            serviceConfig.phase1Duration || 0
        ) || 0;
    }

    return (
        Number(serviceConfig.phase1Duration || 0) ||
        Number(serviceConfig.totalDuration || 0) ||
        Number(
            serviceConfig.metadata?.timing?.estimatedTotal || 0
        ) ||
        0
    );
}

/**
 * Resolucion de la duracion real de F2 desde linkedPhases.
 *
 * @param {string} linkedServiceId
 * @param {string} traceId
 * @param {Set}    visited  - serviceIds ya resueltos (proteccion ciclos)
 * @param {Function} resolver - async (serviceId, traceId) => { status, data }
 * @returns {Promise<number>}
 */
export async function resolveLinkedPhase2Duration(
    linkedServiceId,
    traceId,
    visited = new Set(),
    resolver
) {
    const linkedId = _safeTrim(linkedServiceId);

    if (
        !_looksLikeGuid(linkedId) ||
        typeof resolver !== "function"
    ) {
        return 0;
    }

    if (visited.has(linkedId)) {
        log.warn(
            "Cycle detected in linkedPhases chain",
            { traceId, linkedId, visited: Array.from(visited) }
        );
        return 0;
    }

    visited.add(linkedId);

    const result = await resolver(
        linkedId,
        traceId
    );

    if (
        result?.status !== "SUCCESS" ||
        !result?.data
    ) {
        return 0;
    }

    const service = result.data;

    return (
        Number(service.phase1Duration || 0) ||
        Number(service.totalDuration || 0) ||
        Number(service.metadata?.timing?.estimatedTotal || 0) ||
        0
    );
}

// =============================================================================
// BLOQUE 5 - VALIDACION DE DURACION DE SLOT
// =============================================================================

/**
 * Valida la duracion real de un slot contra el servicio.
 *
 * Dos modos:
 *   - durationRange configurado: valida min <= actualMinutes <= max.
 *   - Sin durationRange: comparacion exacta phase-aware con tolerancia 1 min.
 *
 * @returns {{
 *   ok: boolean,
 *   code: string | null,
 *   actualMinutes: number,
 *   expectedMinutes: number | null,
 *   min: number | null,
 *   max: number | null
 * }}
 */
export function validateSlotDuration({
    serviceConfig,
    startLocal,
    endLocal,
}) {
    const result = {
        ok: true,
        code: null,
        actualMinutes: 0,
        expectedMinutes: null,
        min: null,
        max: null,
    };

    if (!serviceConfig || typeof serviceConfig !== "object") {
        return result;
    }

    const startUtc = getUtcDateFromMadridLocal(
        _normalizeLocalIsoStr(startLocal)
    );

    const endUtc = getUtcDateFromMadridLocal(
        _normalizeLocalIsoStr(endLocal)
    );

    if (!startUtc || !endUtc) {
        return result;
    }

    const diffMs = endUtc.getTime() - startUtc.getTime();

    if (!Number.isFinite(diffMs) || diffMs <= 0) {
        return result;
    }

    const actualMinutes = Math.round(diffMs / 60000);

    result.actualMinutes = actualMinutes;

    const durationRange = serviceConfig.durationRange;

    if (durationRange) {
        const { min, max } = durationRange;

        result.min = min;
        result.max = max === Infinity ? null : max;

        const belowMin = min > 0 && actualMinutes < min;
        const aboveMax = max !== Infinity && actualMinutes > max;

        if (belowMin || aboveMax) {
            result.ok = false;
            result.code = "SLOT_DURATION_OUT_OF_RANGE";
        }

        return result;
    }

    const expectedMinutes =
        resolveExpectedSlotMinutes(serviceConfig);

    if (expectedMinutes > 0) {
        result.expectedMinutes = expectedMinutes;

        if (Math.abs(actualMinutes - expectedMinutes) > 1) {
            result.ok = false;
            result.code = "SLOT_DURATION_MISMATCH";
        }
    }

    return result;
}
