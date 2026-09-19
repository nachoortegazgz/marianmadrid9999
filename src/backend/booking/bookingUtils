/*
=============================================================================
MODULE: backend/booking/bookingUtils.js
VERSION: v5002.6
STANDARDS: G10 ASCII Strict
=============================================================================
*/

import { _safeTrim, _looksLikeGuid } from "public/mmUtils";

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

export function computeGapMinutes(
    f1EndUtc,
    f2StartUtc
) {
    if (
        !(f1EndUtc instanceof Date) ||
        !(f2StartUtc instanceof Date)
    ) {
        return 0;
    }

    const milliseconds =
        f2StartUtc.getTime() -
        f1EndUtc.getTime();

    return Math.max(
        0,
        Math.round(milliseconds / 60000)
    );
}

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

    const max = rawMax > 0
        ? rawMax
        : Infinity;

    if (min <= 0 && max === Infinity) {
        return null;
    }

    if (max !== Infinity && max <= min) {
        return null;
    }

    return { min, max };
}

export function resolveExpectedSlotMinutes(
    serviceConfig
) {
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


Después, los imports actuales podrán resolverse correctamente.
