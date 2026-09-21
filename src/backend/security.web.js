/*
=============================================================================
MODULE: backend/security.web.js
VERSION: v5009-FISCAL-V20.1
BASE: v5007.1-FINAL + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Web methods de seguridad para frontend.
                Delegacion exclusiva en backend/security.js.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: sin renombrados funcionales. El modulo no importa constantes
            renombradas ni toca campos CMS con nomenclatura cambiada.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";

import { makeTraceId } from "public/mmUtils";

import {
    isAdmin,
    isCajero,
    isStaffCollaborator,
} from "backend/security";

import {
    successResponse,
    errorResponse,
} from "backend/responseUtils";

// =============================================================================
// BLOQUE 1 - HELPERS INTERNOS
// =============================================================================

function _resolveTraceId(options, prefix) {
    const suppliedTraceId =
        options &&
        typeof options === "object" &&
        typeof options.traceId === "string" ?
        options.traceId.trim() :
        "";

    return suppliedTraceId || makeTraceId(prefix);
}

function _createAccessResponse(authorized, role) {
    return successResponse({
        authorized: authorized === true,
        role: authorized === true ? role : null,
    });
}

function _handleSecurityError(error, fallbackCode) {
    return errorResponse(
        error?.code || fallbackCode,
        error?.message || "No se pudo verificar el acceso."
    );
}

// =============================================================================
// BLOQUE 2 - CHECK ADMIN ACCESS
// =============================================================================

export const checkAdminAccess = webMethod(
    Permissions.SiteMember,
    async (options = {}) => {
        const traceId = _resolveTraceId(options, "sec-admin");

        try {
            const authorized = await isAdmin(traceId);

            return _createAccessResponse(authorized, "ADMIN");
        } catch (error) {
            return _handleSecurityError(error, "SEC_ADMIN_FAIL");
        }
    }
);

// =============================================================================
// BLOQUE 3 - CHECK CAJERO ACCESS
// =============================================================================

export const checkCajeroAccess = webMethod(
    Permissions.SiteMember,
    async (options = {}) => {
        const traceId = _resolveTraceId(options, "sec-cajero");

        try {
            const authorized = await isCajero(traceId);

            return _createAccessResponse(authorized, "CAJERO");
        } catch (error) {
            return _handleSecurityError(error, "SEC_CAJERO_FAIL");
        }
    }
);

// =============================================================================
// BLOQUE 4 - CHECK STAFF COLLABORATOR ACCESS
// =============================================================================

export const checkStaffCollaboratorAccess = webMethod(
    Permissions.SiteMember,
    async (options = {}) => {
        const traceId = _resolveTraceId(options, "sec-staff");

        try {
            const authorized = await isStaffCollaborator(traceId);

            return _createAccessResponse(authorized, "COLLABORATOR");
        } catch (error) {
            return _handleSecurityError(error, "SEC_STAFF_FAIL");
        }
    }
);