/*
=============================================================================
MODULE: public/qrHelper.js
VERSION: v5007.4-FINAL
RESPONSIBILITY: Generacion de datos, URL y HTML de recibos Verifactu.
STANDARDS: G10 ASCII Strict.
=============================================================================
*/

export const AEAT_VERIFACTU_ENDPOINTS = Object.freeze({
    VERIFICATION_BASE_URL: "https://sede.agenciatributaria.gob.es/verifactu",
    DEV_ENVIRONMENT: false,
});

const DEFAULT_AMOUNT = "0";

// =============================================================================
// HELPERS
// =============================================================================

function _safeString(value) {
    if (value === null || value === undefined) {
        return "";
    }

    return String(value).trim();
}

function _formatDateToAeatDdMmYyyy(dateValue) {
    const date =
        dateValue instanceof Date ? dateValue : new Date(dateValue);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

    return [
        String(date.getDate()).padStart(2, "0"),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getFullYear()),
    ].join("/");
}

function _escapeHtml(value) {
    return _safeString(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function _escapeAttribute(value) {
    return _escapeHtml(value);
}

function _resolveInvoiceDate(movimiento) {
    const explicitDate = _safeString(movimiento?.fechaEmision);

    if (explicitDate) {
        return explicitDate;
    }

    return _formatDateToAeatDdMmYyyy(movimiento?.registeredAt);
}

// =============================================================================
// URL DE VERIFICACION
// =============================================================================

export function generateVerifactuQrUrl(params = {}) {
    const nifEmisor = _safeString(
        params.nifEmisor || params.businessTaxId
    );

    const numFactura = _safeString(
        params.numFactura ||
        params.numTicketFactura ||
        params.invoiceNumber
    );

    const fechaEmision = _safeString(
        params.fechaEmision || params.issueDate
    );

    const qrImporteTotal =
        _safeString(
            params.qrImporteTotal ||
            params.totalAmount ||
            DEFAULT_AMOUNT
        ) || DEFAULT_AMOUNT;

    const hashCadena = _safeString(
        params.hashCadena || params.currentRecordHash
    );

    if (!nifEmisor || !numFactura || !fechaEmision) {
        return null;
    }

    const query = new URLSearchParams({
        nif: nifEmisor,
        numFactura,
        fecha: fechaEmision,
        importe: qrImporteTotal,
        hash: hashCadena,
    });

    return `${AEAT_VERIFACTU_ENDPOINTS.VERIFICATION_BASE_URL}?${query.toString()}`;
}

// =============================================================================
// EXTRACCION DE DATOS
// =============================================================================

export function extractVerifactuData(
    movimiento = {},
    options = {}
) {
    const nifEmisor = _safeString(
        movimiento.nifEmisor ||
        movimiento.businessTaxId ||
        options.businessTaxId
    );

    const numTicketFactura = _safeString(
        movimiento.numTicketFactura ||
        movimiento.numFactura ||
        movimiento.invoiceNumber
    );

    const fechaEmision = _resolveInvoiceDate(movimiento);

    const qrImporteTotal =
        _safeString(
            movimiento.qrImporteTotal ||
            movimiento.totalAmount ||
            DEFAULT_AMOUNT
        ) || DEFAULT_AMOUNT;

    const hashCadena = _safeString(
        movimiento.hashCadena ||
        movimiento.currentRecordHash
    );

    const firmaDigital = _safeString(
        movimiento.firmaDigital ||
        movimiento.digitalSignature
    );

    const qrUrl = generateVerifactuQrUrl({
        nifEmisor,
        numFactura: numTicketFactura,
        fechaEmision,
        qrImporteTotal,
        hashCadena,
    });

    return {
        nifEmisor,
        numTicketFactura,
        fechaEmision,
        qrImporteTotal,
        hashCadena,
        firmaDigital,
        qrUrl,
    };
}

// =============================================================================
// RECIBO HTML
// =============================================================================

export function buildVerifactuReceiptHtml(
    movimiento = {},
    options = {}
) {
    const data = extractVerifactuData(movimiento, options);

    if (!data.qrUrl) {
        return "";
    }

    const shortHash = data.hashCadena ?
        `${data.hashCadena.slice(0, 16)}...` :
        "";

    return `
<div style="font-family:Arial,sans-serif;padding:16px;border:1px solid #ccc;border-radius:8px;">
  <h3 style="margin:0 0 12px;">Factura Simplificada</h3>
  <p><strong>NIF Emisor:</strong> ${_escapeHtml(data.nifEmisor)}</p>
  <p><strong>Numero:</strong> ${_escapeHtml(data.numTicketFactura)}</p>
  <p><strong>Fecha:</strong> ${_escapeHtml(data.fechaEmision)}</p>
  <p><strong>Importe:</strong> ${_escapeHtml(data.qrImporteTotal)} EUR</p>
  <p>
    <strong>Verificacion:</strong>
    <a
      href="${_escapeAttribute(data.qrUrl)}"
      target="_blank"
      rel="noopener noreferrer"
    >
      Verificar factura
    </a>
  </p>
  ${
    shortHash
      ? `<p style="font-size:10px;color:#666;">Hash: ${_escapeHtml(
          shortHash
        )}</p>`
      : ""
  }
</div>`.trim();
}