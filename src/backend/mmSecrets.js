/*
=============================================================================
MODULE: backend/mmSecrets.js
VERSION: v5007.5-FINAL
BASE: BIBLIA v5002.5 + Gestor de secretos actual
RESPONSIBILITY: Nombres canonicos de secretos Wix.
STANDARDS: G10 ASCII Strict.
CORRECTIONS APPLIED:
  [VF-01] Anadidos FISCAL_SIGNER_ENDPOINT y FISCAL_SIGNER_BEARER para
          delegacion de firma X.509 en microservicio externo.
=============================================================================
*/

export const SECRETS = Object.freeze({
    // Fiscal (obligatorio Veri*factu)
    FISCAL_KEY: "SECRET_FISCALKEY",
    FISCAL_NIF_EMISOR: "FISCAL_NIF_EMISOR",

    // [VF-01] Firma X.509 delegada en microservicio externo
    // El certificado cualificado NO se almacena en Velo (limite de
    // Secrets Manager y limitaciones de crypto en sandbox).
    // El microservicio externo (AWS Lambda / Cloud Run / SaaS Veri*factu)
    // posee el certificado y firma bajo demanda.
    FISCAL_SIGNER_ENDPOINT: "FISCAL_SIGNER_ENDPOINT",
    FISCAL_SIGNER_BEARER: "FISCAL_SIGNER_BEARER",

    // Autenticacion y roles
    AUTH_JWT_KEY: "SECRET_AUTH_JWT_KEY",
    ADMIN_EMAILS: "ADMIN_EMAILS",
    CAJERO_EMAILS: "CAJERO_EMAILS",

    // Automatizacion
    POWER_AUTOMATE: "POWER_AUTOMATE_TOKEN",

    // Email (SendGrid legacy + Resend actual)
    SENDGRID_API_KEY: "SENDGRID_API_KEY",
    SENDGRID_FROM_EMAIL: "SENDGRID_FROM_EMAIL",
    RESEND_API_KEY: "RESEND_API_KEY",
    RESEND_FROM_EMAIL: "RESEND_FROM_EMAIL",

    // Asistente IA
    MARIAN_ASSISTANT_OPENAI_KEY: "MARIAN_ASSISTANT_OPENAI_KEY",

    // Microsoft 365 Graph API
    M365_GRAPH_CLIENT_ID: "M365_CLIENT_ID",
    M365_GRAPH_CLIENT_SECRET: "M365_CLIENT_SECRET",
    M365_GRAPH_TENANT_ID: "M365_TENANT_ID",
    M365_GRAPH_SITE_ID: "M365_GRAPH_SITE_ID",
    M365_GRAPH_LIST_ID: "M365_LIST_ID",
    M365_WEBHOOK_HMAC_KEY: "SECRET_M365_WEBHOOK_HMAC_KEY",
});