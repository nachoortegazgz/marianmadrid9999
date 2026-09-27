/*
=============================================================================
MODULE: backend/repositories/fiscalRepository.js
VERSION: v5010-CLEAN
RESPONSIBILITY: Read-only access to the fiscal system configuration.
SOURCE: BIBLIA TECNICA v5009, R3 and singleton CONFIG_SISTEMA_FISCAL.
STANDARDS: G10 ASCII Strict, no silent operational fallback.
=============================================================================
*/

import wixData from "wix-data";

import { COLLECTIONS, SDK_CONFIG } from "backend/internalConfig";
import { SSOT_RECORD_TYPES } from "backend/ssotCollectionContract";
import { _safeTrim, withTimeout } from "public/mmUtils";

const FISCAL_COLLECTION = COLLECTIONS.DATOS_FISCALES;
const FISCAL_CONFIG_ID = "CONFIG_SISTEMA_FISCAL";
const CACHE_TTL_MS = 300000;
const DEFAULT_QUERY_TIMEOUT_MS = 15000;
const MAX_CONFIG_RESULTS = 2;
const QUERY_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.CMS_MS) || DEFAULT_QUERY_TIMEOUT_MS;

let cachedConfig = null;
let cachedAt = 0;

function _readTaxId(item) {
    return _safeTrim(
        item?.producerTaxId ||
        item?.taxId ||
        item?.nifCif ||
        item?.nifEmisor
    ).toUpperCase();
}

function _readLegalName(item) {
    return _safeTrim(
        item?.producerLegalName ||
        item?.legalName ||
        item?.razonSocial
    );
}

function _validateConfig(item) {
    if (!item || typeof item !== "object") {
        throw new Error("FISCAL_CONFIG_NOT_FOUND");
    }
    if (_safeTrim(item.recordType) !== SSOT_RECORD_TYPES.FISCAL_SYSTEM_CONFIG) {
        throw new Error("FISCAL_CONFIG_INVALID_RECORD_TYPE");
    }

    const taxId = _readTaxId(item);
    if (!taxId) {
        throw new Error("FISCAL_CONFIG_MISSING_TAX_ID");
    }

    const legalName = _readLegalName(item);
    if (!legalName) {
        throw new Error("FISCAL_CONFIG_MISSING_LEGAL_NAME");
    }

    return Object.freeze({
        _id: _safeTrim(item._id) || FISCAL_CONFIG_ID,
        recordType: SSOT_RECORD_TYPES.FISCAL_SYSTEM_CONFIG,
        taxId,
        producerTaxId: taxId,
        legalName,
        producerLegalName: legalName,
        fiscalRegime: _safeTrim(item.fiscalRegime || item.regimeKey) || null,
        vatRate: Number.isFinite(Number(item.vatRate)) ? Number(item.vatRate) : null,
        irpfRate: Number.isFinite(Number(item.irpfRate)) ? Number(item.irpfRate) : null,
        computerSystem: item.computerSystem && typeof item.computerSystem === "object"
            ? Object.freeze({ ...item.computerSystem })
            : null,
        revision: Number.isFinite(Number(item.revision)) ? Number(item.revision) : null,
    });
}

async function _queryConfig() {
    const byId = await withTimeout(
        () => wixData.get(FISCAL_COLLECTION, FISCAL_CONFIG_ID, { suppressAuth: true }),
        QUERY_TIMEOUT_MS,
        "fiscalRepository:getConfig"
    ).catch(() => null);

    if (byId) {
        return byId;
    }

    const result = await withTimeout(
        () => wixData.query(FISCAL_COLLECTION)
            .eq("recordType", SSOT_RECORD_TYPES.FISCAL_SYSTEM_CONFIG)
            .limit(MAX_CONFIG_RESULTS)
            .find({ suppressAuth: true }),
        QUERY_TIMEOUT_MS,
        "fiscalRepository:queryConfig"
    );

    const items = result?.items || [];
    if (items.length !== 1) {
        throw new Error(
            items.length === 0
                ? "FISCAL_CONFIG_NOT_FOUND"
                : "FISCAL_CONFIG_NOT_UNIQUE"
        );
    }
    return items[0];
}

export async function getFiscalSystemConfig() {
    const now = Date.now();
    if (cachedConfig && now - cachedAt < CACHE_TTL_MS) {
        return cachedConfig;
    }

    const item = await _queryConfig();
    const normalized = _validateConfig(item);
    cachedConfig = normalized;
    cachedAt = now;
    return normalized;
}

export function clearFiscalSystemConfigCache() {
    cachedConfig = null;
    cachedAt = 0;
}

export function getFiscalRepositoryContract() {
    return Object.freeze({
        collection: FISCAL_COLLECTION,
        recordType: SSOT_RECORD_TYPES.FISCAL_SYSTEM_CONFIG,
        singletonId: FISCAL_CONFIG_ID,
        cacheTtlMs: CACHE_TTL_MS,
        requires: ["taxId", "legalName"],
    });
}
