/*
=============================================================================
MODULE: public/qrHelper.js
VERSION: v5009-FISCAL-V20.1
BASE: v5007.4-FINAL + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Generacion de datos, URL y HTML de recibos Verifactu.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: lecturas de campos de MovimientosCaja migradas a nomenclatura
            V20.1 (issuerTaxId, invoiceNumber, invoiceIssueDate, totalAmount,
            recordHash, digitalSignature, recordTimestamp).
  - V20-02: fallback legacy preservado para consumidores no migrados.
  - V20-03: businessTaxId deprecated (apunta a issuerTaxId).

FIXES APLICADOS v5007.4 (heredados):
  - Generacion de datos, URL y HTML de recibos Verifactu.
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
    const explicitDate = _safeString(
        movimiento?.invoiceIssueDate ||
        movimiento?.fechaExpedicionFactura ||
        movimiento?.fechaEmision
    );

    if (explicitDate) {
        return explicitDate;
    }

    const timestamp = movimiento?.recordTimestamp || movimiento?.registeredAt;
    return _formatDateToAeatDdMmYyyy(timestamp);
}

function _readIssuerTaxId(movimiento, options) {
    return _safeString(
        movimiento?.issuerTaxId ||
        movimiento?.nifEmisor ||
        movimiento?.businessTaxId ||
        options?.issuerTaxId ||
        options?.businessTaxId
    );
}

function _readInvoiceNumber(movimiento) {
    return _safeString(
        movimiento?.invoiceNumber ||
        movimiento?.numSerieFactura ||
        movimiento?.numFactura ||
        movimiento?.numTicketFactura
    );
}

function _readTotalAmount(movimiento) {
    return _safeString(
        movimiento?.totalAmount ||
        movimiento?.qrImporteTotal ||
        movimiento?.importeTotal ||
        DEFAULT_AMOUNT
    ) || DEFAULT_AMOUNT;
}

function _readRecordHash(movimiento) {
    return _safeString(
        movimiento?.recordHash ||
        movimiento?.hashCadena ||
        movimiento?.currentRecordHash ||
        movimiento?.huella
    );
}

function _readDigitalSignature(movimiento) {
    return _safeString(
        movimiento?.digitalSignature ||
        movimiento?.firmaDigital
    );
}

// =============================================================================
// URL DE VERIFICACION
// =============================================================================

export function generateVerifactuQrUrl(params = {}) {
    const issuerTaxId = _safeString(
        params.issuerTaxId ||
        params.nifEmisor ||
        params.businessTaxId
    );

    const invoiceNumber = _safeString(
        params.invoiceNumber ||
        params.numSerieFactura ||
        params.numFactura ||
        params.numTicketFactura
    );

    const invoiceIssueDate = _safeString(
        params.invoiceIssueDate ||
        params.fechaExpedicionFactura ||
        params.fechaEmision ||
        params.issueDate
    );

    const totalAmount =
        _safeString(
            params.totalAmount ||
            params.qrImporteTotal ||
            DEFAULT_AMOUNT
        ) || DEFAULT_AMOUNT;

    const recordHash = _safeString(
        params.recordHash ||
        params.hashCadena ||
        params.currentRecordHash
    );

    if (!issuerTaxId || !invoiceNumber || !invoiceIssueDate) {
        return null;
    }

    const query = new URLSearchParams({
        nif: issuerTaxId,
        numFactura: invoiceNumber,
        fecha: invoiceIssueDate,
        importe: totalAmount,
        hash: recordHash,
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
    const issuerTaxId = _readIssuerTaxId(movimiento, options);
    const invoiceNumber = _readInvoiceNumber(movimiento);
    const invoiceIssueDate = _resolveInvoiceDate(movimiento);
    const totalAmount = _readTotalAmount(movimiento);
    const recordHash = _readRecordHash(movimiento);
    const digitalSignature = _readDigitalSignature(movimiento);

    const qrUrl = generateVerifactuQrUrl({
        issuerTaxId,
        invoiceNumber,
        invoiceIssueDate,
        totalAmount,
        recordHash,
    });

    return {
        issuerTaxId,
        invoiceNumber,
        invoiceIssueDate,
        totalAmount,
        recordHash,
        digitalSignature,
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

    const shortHash = data.recordHash ?
        `${data.recordHash.slice(0, 16)}...` :
        "";

    return `
<div style="font-family:Arial,sans-serif;padding:16px;border:1px solid #ccc;border-radius:8px;">
  <h3 style="margin:0 0 12px;">Factura Simplificada</h3>
  <p><strong>NIF Emisor:</strong> ${_escapeHtml(data.issuerTaxId)}</p>
  <p><strong>Numero:</strong> ${_escapeHtml(data.invoiceNumber)}</p>
  <p><strong>Fecha:</strong> ${_escapeHtml(data.invoiceIssueDate)}</p>
  <p><strong>Importe:</strong> ${_escapeHtml(data.totalAmount)} EUR</p>
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