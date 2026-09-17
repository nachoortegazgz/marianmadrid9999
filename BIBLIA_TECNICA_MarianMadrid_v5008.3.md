# BIBLIA TECNICA DEL PROYECTO
## Marian Madrid — Peluqueria y Estetica
### Version de referencia: v5008.3-FINAL
### Stack: Wix Velo + Wix Bookings V2 + Wix eCom/Stores + CMS

---

## 1. IDENTIDAD DEL SITIO

| Campo | Valor |
|-------|--------|
| Nombre comercial | Marian Madrid Peluqueria y Estetica |
| Site ID (Wix) | `188bed94-177c-4bc9-a9f0-35080d874f3e` |
| Repositorio | `https://github.com/nachoortegazgz/marianmadrid9999` |
| Zona horaria operativa | `Europe/Madrid` |
| Moneda | `EUR` (2 decimales) |
| Location ID (Bookings) | `7a12abfd-bf30-4847-bcdf-00dc573d4802` |
| Location type slots | `BUSINESS` |
| Location type Writer API | `OWNER_BUSINESS` |

### 1.1 Staff / Resources (Bookings)

| Resource ID | Display |
|-------------|---------|
| `e556070a-6d6a-402e-8422-11133033ea76` | Marian Madrid (gestion) |
| `07f7344f-e7e4-4c53-854b-47fd82ac8d40` | Andrea |
| `9b905bfd-1a09-485d-9273-a24a20dfe648` | Alba |

- `API.STAFF_RESOURCE_TYPE_ID` = `1cd44cf8-756f-41c3-bd90-3e2ffcaf1155`
- `API.MARIAN_MANAGEMENT_RESOURCE_ID` = resource Marian

### 1.2 Roles internos (COLLAB_ROLES / STAFF_ACCESS)

| Rol | Uso |
|-----|-----|
| `ADMIN` | Acceso total |
| `GESTION` | Caja, citas, fiscal |
| `ESTILISTA` | Operativa limitada |

---

## 2. WIX APPS NATIVAS Y CONFIGURACION OPTIMA

### 2.1 Apps instaladas (APP_IDS de referencia)

| App | App ID | Rol en el sistema |
|-----|--------|-------------------|
| **Wix Bookings** | `13d21c63-b5ec-5912-8397-c3a5ddb27a97` | Motor nativo de citas; Writer API V2 custom |
| **Wix Stores** | `215238eb-22a5-4c36-9e7b-e7c08025e04e` | Productos / checkout online |
| **Wix Events** | `140603ad-af8d-84fb-9004-ee174e35054d` | (referencia; no motor de reservas) |
| **Forms & Payments** | `14ce1214-b278-a7e4-1373-00cebd1bef7c` | Pagos auxiliares |
| **Invoices** | `13ee94c1-b635-8505-3391-97919052c16f` | Facturacion nativa opcional |
| **Members Area** | `14cc59bc-f0b7-15b8-e1c7-89ce41d0e0c9` | Area de miembros |
| **Gift Cards** | `d80111c5-a0f4-47a8-b63a-65b54d774a27` | Tarjetas regalo |

### 2.2 Configuracion optima — Wix Bookings

1. **Business location** unica alineada con `SDK_CONFIG.LOCATION_ID`.
2. **Timezone** del negocio = `Europe/Madrid` (mismo que `SDK_CONFIG.TZ`).
3. **Resources** = los 3 staff IDs anteriores; tipo recurso staff = `STAFF_RESOURCE_TYPE_ID`.
4. **Services**:
   - Simple: un servicio, una duracion, sin `allowCombine`.
   - Dual: servicio F1 con `allowCombine` + `linkedPhases` apuntando al serviceId de F2; gap maximo `SLOT_SEARCH.MAX_DUAL_GAP_MINUTES` (120).
5. **No depender del formulario nativo** para el flujo dual con gap: usar UI custom + `executeBookingSaga`.
6. **Webhooks Bookings V2** activos hacia backend `events.js`:
   - `Booking Confirmed`
   - `Booking Canceled`
7. **Disponibilidad**: el backend usa `revalidateExactAvailabilitySlot` + caches; no desactivar validacion nativa en el panel sin motivo.

### 2.3 Configuracion optima — Wix Stores / eCom

1. Moneda EUR, impuestos ES (IVA 21% general servicios/productos segun catalogo).
2. Checkout online para reservas `PENDING_PAYMENT` via `checkout` API (`createCheckout` / `getCheckoutUrl`).
3. **Webhooks eCom** activos:
   - `Order Payment Status Updated`
   - `Order Refunded`
   - `Order Canceled`
4. Inventario de productos se **espeja** en CMS (`InventarioStockVenta` / `MovimientosInventario`); no sustituye el stock nativo de Stores.

### 2.4 Configuracion optima — sitio / Velo

1. **Git Integration** conectado al repo; backend en `src/backend/`.
2. **Secrets** (Wix Secrets Manager) via `backend/mmSecrets.js` (HMAC M365, firmador fiscal, etc.).
3. **Jobs** definidos en `src/backend/jobs.config` (timezone Madrid, `concurrencyPolicy: Forbid`).
4. **Permissions**: webMethods publicos (`Permissions.Anyone`) solo para lectura de disponibilidad y creacion de reserva controlada; mutaciones de caja/fiscal con `requireCajero` / `requireAdmin` / `requireMarianManager`.
5. No mezclar APIs deprecadas (`wix-bookings-backend`); solo `@wix/bookings` / `wix-bookings.v2` y eCom v2.

### 2.5 Principio de no-friccion con nativo

- Bookings nativo sigue siendo fuente de verdad de **slots y bookings**.
- `CitasF2` es SSOT **interno** (estado pago, pairToken, meta, contabilidad).
- No reescribir el calendario nativo; si hay conflicto, manda Bookings + compensacion.
- Pagos online: flujo eCom nativo; el backend solo registra ledger e inventarios.

---

## 3. CONSTANTES SSOT (`backend/internalConfig.js`)

### 3.1 COLLECTIONS (nombre logico → CMS)

| Constante | Coleccion CMS |
|-----------|---------------|
| `ALERTAS_OPERATIVAS` | AlertasOperativas |
| `PROCESSED_WEBHOOK_EVENTS` | ProcessedWebhookEvents |
| `ASIENTOS_CONTABLES` | AsientosContables |
| `AVAILABILITY_DAYS_CACHE` | AvailabilityDaysCache |
| `BOOKINGS_SERVICE_SYNC_QUEUE` | BookingsServiceSyncQueue |
| `BOOKING_TRANSACTIONS` | BookingTransactions |
| `CAJA_ACTUAL` | CajaActual |
| `CITAS_F2` | CitasF2 |
| `COMPENSACIONES_PENDIENTES` | CompensacionesPendientes |
| `COMPLEMENTOS_CATALOGO` | ComplementosCatalogo |
| `CONFIGURACION_FISCAL` | ConfiguracionFiscal |
| `DATOS_FISCALES` | DatosFiscales |
| `DUAL_SLOT_CACHE` | DualSlotCache |
| `HISTORICO_CIERRES_Z` | HistoricoCierresZ |
| `INVENTARIO_STOCK_VENTA` | InventarioStockVenta |
| `LIBRO_ASIENTOS_CONTABLES_DETALLE` | LibroAsientosContablesDetalle |
| `M365_GRAPH_SYNC_QUEUE` | M365GraphSyncQueue |
| `MAPA_STAFF` | MapaStaff |
| `MOVIMIENTOS_CAJA` | MovimientosCaja |
| `MOVIMIENTOS_INVENTARIO` | MovimientosInventario |
| `PROVEEDORES_LISTA` | ProveedoresLista |
| `RATE_LIMIT_BLOCKS` | RateLimitBlocks |
| `REGISTROS_HORARIOS_STAFF` | RegistrosHorariosStaff |
| `SERVICIOS_CATALOGO` | ServiciosCatalogo |
| `SLOT_LOCKS` | SlotLocks |

**Singleton:** `SINGLETONS.CAJA` = `CAJA_PRINCIPAL` (documento en CajaActual).

### 3.2 Estados y enums

**ESTADO_CITA:** `CONFIRMED` | `PENDING_PAYMENT` | `CANCELED` | `REFUNDED`

**ESTADO_PAGO:** `UNPAID` | `NOT_PAID` | `PENDING_PAYMENT` | `PENDING_LEDGER` | `PAID` | `REFUNDED` | `PARTIALLY_REFUNDED`

**FORMA_PAGO:** `EFECTIVO` | `TARJETA` | `BIZUM` | `ONLINE` | `TARJETA_REGALO`

**TIPO_MOVIMIENTO (caja):**  
`VENTA_EFECTIVO`, `VENTA_TARJETA`, `VENTA_BIZUM`, `VENTA_ONLINE`, `VENTA_PRODUCTO`, `VENTA_PRODUCTO_ONLINE`, `VENTA_TARJETA_REGALO`, `CANJE_TARJETA_REGALO`, `REEMBOLSO`, `DEVOLUCION_SERVICIO`, `DEVOLUCION_PRODUCTO`, `AJUSTE`, `PROPINA`, `APORTE`, `RETIRO`, `GASTO`, `PAGO_PROVEEDOR`, `ANTICIPO`, `FONDO_INICIAL`

**CAJA_STATUS:** `ABIERTA` | `CERRADA`

**IVA_RATES:** GENERAL 0.21 | REDUCIDO 0.10 | SUPERREDUCIDO 0.04 | EXENTO 0

**SERVICE_CATALOG.STATES:** `ACTIVO` | `INACTIVO` | `BORRADOR` — currency EUR

**SLOT_SEARCH:** `DIAS_LIMITE=14`, `TOLERANCE_MINUTES=10`, `MAX_DUAL_GAP_MINUTES=120`

**BOOKINGS_ADDON_CONFIG:** `MAX_PER_BOOKING=5`

**CONCURRENCY (referencia):** `MUTEX_TTL_MS=300000`, `HEARTBEAT_MS=15000`, `LEDGER_MUTEX_TTL_MS=45000`, etc.

**CITA_FIELDS (nombres de campo canonico):**

| Constante | Campo CMS |
|-----------|-----------|
| STATUS | status |
| STATUS_PAGO | paymentStatus |
| PAIR_TOKEN | pairToken |
| SERVICE_ID | serviceId |
| RESOURCE_ID | resourceId |
| BOOKING_ID | bookingId |
| DATE_YMD | dateYmd |
| META | meta |

**MONEY:** DISPLAY_CURRENCY EUR, DECIMALS 2  
**JWT:** HS256, EXPIRATION_MS 1800000

---

## 4. COLECCIONES — CAMPOS, TIPOS, INDICES, PERMISOS

> Los indices recomendados son los que el codigo consulta. Crearlos en CMS (Wix Data indexes) si no existen.

### 4.1 CitasF2 (SSOT citas internas)

| Campo | Tipo | Notas |
|-------|------|--------|
| `bookingId` | Text (GUID) | ID booking Bookings V2; **indice unique** |
| `pairToken` | Text | Idempotencia simple/dual; **indice** |
| `revision` | Number | |
| `serviceId` | Text (GUID) | **indice** |
| `scheduleId` | Text | nullable |
| `resourceId` | Text (GUID) | **indice** |
| `startDate` | DateTime | |
| `endDate` | DateTime | |
| `dateYmd` | Text | `YYYY-MM-DD` Madrid; **indice** |
| `bookingType` | Text | `SIMPLE` / `DUAL_F1` / `DUAL_F2` |
| `status` | Text | ESTADO_CITA |
| `paymentStatus` | Text | ESTADO_PAGO |
| `meta` | Object | JSON: checkoutUrl, fases dual, addons… |
| `contactDetails` | Object | email, firstName, lastName, phone |
| `traceId` | Text | |

**Permisos CMS:** lectura backend elevated; escritura solo backend (`suppressAuth` en codigo). Frontend no escribe directo.

**Indices recomendados:**  
`(bookingId)`, `(pairToken)`, `(dateYmd + resourceId)`, `(serviceId + dateYmd)`, `(status + paymentStatus)`

### 4.2 BookingTransactions

| Campo | Tipo | Uso |
|-------|------|-----|
| `_id` / pairToken | Text | Clave de transaccion saga |
| `status` | Text | INIT / COMPLETED / FAILED |
| `meta` | Object | contexto |
| timestamps | DateTime | |

**Indice:** status + updatedDate

### 4.3 SlotLocks

| Campo | Tipo | Uso |
|-------|------|-----|
| lock key | Text | `lock:{resourceId}:{dateYmd}:{HHmm}` |
| `expiresAt` | DateTime | TTL mutex |
| `owner` / `traceId` | Text | |

**Indice:** expiresAt (purga cron)

### 4.4 MovimientosCaja (ledger fiscal LEDGER_V3)

| Campo | Tipo | Notas |
|-------|------|--------|
| `amount` | Number | > 0 ventas; signos segun tipo |
| `paymentMethod` | Text | FORMA_PAGO |
| `tipoMovimiento` | Text | TIPO_MOVIMIENTO |
| `concept` | Text | |
| `resourceId` | Text | staff u `ONLINE` |
| `reservaIdVinculada` | Text | bookingId(s) CSV |
| `transactionId` | Text | **indice** (idempotencia) |
| `orderId` | Text | eCom |
| `schemaVersion` | Text | `LEDGER_V3` |
| hash / prevHash | Text | cadena fiscal |
| `registeredAt` | DateTime | |

**Permisos:** solo roles caja/admin; hooks `data.js` impiden update/remove indebidos.

**Indices:** `(transactionId)`, `(registeredAt)`, `(tipoMovimiento + registeredAt)`, `(reservaIdVinculada)`

### 4.5 CajaActual

| Campo | Tipo | Notas |
|-------|------|--------|
| `_id` | Text | `CAJA_PRINCIPAL` |
| estado | Text | ABIERTA / CERRADA |
| saldos | Number | por forma de pago |
| metadata cierre | Object | |

### 4.6 HistoricoCierresZ

Cierres diarios sellados. Hooks: no update/remove libre.

### 4.7 AsientosContables + LibroAsientosContablesDetalle

- Cabecera asiento + lineas detalle (PGC).
- Proyeccion desde `projectLedgerMovementToAccounting(movimiento)`.
- Hooks de integridad en `data.js` (incl. `LibroAsientosContablesDetalle_*`).

### 4.8 InventarioStockVenta + MovimientosInventario

Espejo de ventas/refunds online. Indices por SKU / orderId.

### 4.9 CompensacionesPendientes

Recuperacion fiscal y compensacion de bookings fallidos (F2, cancel parcial).

### 4.10 DualSlotCache + AvailabilityDaysCache

Caches de disponibilidad; TTL y purga por crons.

### 4.11 ServiciosCatalogo + ComplementosCatalogo + MapaStaff

Catalogo interno sincronizable con Bookings (`bookingServiceSync`).

### 4.12 ProcessedWebhookEvents

Idempotencia de webhooks (`eventId`). **No** usar AlertasOperativas.

### 4.13 AlertasOperativas

Solo alertas reales de salud / fallos operativos.

### 4.14 Otras

`RateLimitBlocks`, `RegistrosHorariosStaff`, `ProveedoresLista`, `DatosFiscales`, `ConfiguracionFiscal`, `BookingsServiceSyncQueue`, `M365GraphSyncQueue`.

---

## 5. ARQUITECTURA DE MODULOS

```
Frontend (pages) 
    -> webMethods: reservas.web / citasManager.web / cajas.web / ...
Backend core:
    bookingSaga.executeBookingSaga
        -> bookingCore (locks, transactions, persist, elevate APIs)
        -> reservas.web (servicio, staff, dual slots)
        -> Bookings V2 createBooking (oficial)
Events (webhooks Wix)
    -> cajas.registerBookingPayment -> MovimientosCaja
    -> contabilidad.projectLedgerMovementToAccounting (async)
    -> inventario.recordOnline*
Crons
    -> locks, dual cache, compensaciones, cierre Z, health
```

### 5.1 Mapa de responsabilidades

| Modulo | Responsabilidad |
|--------|-----------------|
| `booking/bookingCore.js` | Primitivas: elevate APIs, locks, transactions, persist CitasF2, errores |
| `booking/bookingSaga.js` | Orquestacion simple/dual, payload oficial, compensacion |
| `reservas.web.js` | Disponibilidad, servicios, dual cache, staff resolution |
| `citasManager.web.js` | processDualBooking, confirmPayment, reschedule |
| `events.js` | Webhooks Bookings + eCom |
| `cajas.web.js` | Ledger, caja, cierre Z, gift cards, recovery fiscal |
| `contabilidad.js` | Asientos desde movimientos de caja |
| `inventario.web.js` | Stock y movimientos online |
| `internalConfig.js` | SSOT constantes |
| `logger.js` | Logging con redaccion PII |
| `security.js` / `securityEngine.js` / `security.web.js` | Auth, rate limit, HMAC |
| `staff.js` | Schedule IDs staff |
| `data.js` | Hooks inmutabilidad CMS |
| `crons.js` + `jobs.config` | Mantenimiento |
| `bookingServiceSync.js` | Cola ServiciosCatalogo <-> Bookings |
| `fiscalDocuments.web.js` / `fiscalAggregator.web.js` | Paquetes y resúmenes AEAT |
| `horario.web.js` | Laboral |
| `audit.js` | Auditoria centralizada |
| `http-functions.js` | Webhook M365 HMAC |
| `m365GraphSync.js` | Cola Graph |
| `marianAssistant.web.js` | Asistente AI gestion |
| `facturasRecibidas.web.js` | Facturas proveedores |
| `responseUtils.js` | Errores publicos |
| `mmSecrets.js` | Nombres de secretos |

---

## 6. FUNCIONES Y HELPERS PRINCIPALES

### 6.1 bookingCore

| Simbolo | Tipo | Descripcion |
|---------|------|-------------|
| `createBookingElevated` | elevate | Proxy `bookings.createBooking` |
| `cancelBookingElevated` | elevate | Cancel |
| `confirmOrDeclineBookingElevated` | elevate | Confirm/decline |
| `rescheduleBookingElevated` | elevate | Reschedule |
| `createCheckoutElevated` / `getCheckoutUrlElevated` | elevate | Checkout eCom |
| `getCheckoutUrlSafe` | helper | Checkout URL tolerante a fallos |
| `_forceStaffInPristineSlot` | helper | Slot minimo oficial: serviceId, scheduleId, start/end ISO, resource.id, location |
| `_lockSlotKeyOrFail` / `_unlockSlotKey` / `_renewLock` | concurrency | Mutex por slot |
| `_generateSlotKey` / `_buildLockKeys` | helper | Claves lock simple/dual |
| `_initTransaction` / `_completeTransaction` / `_failTransaction` | idempotencia | BookingTransactions |
| `_persistBooking` | write | Upsert CitasF2 campos canonico |
| `_updateCitaSafe` | write | Update seguro por bookingId |
| `_areSlotsContiguous` | helper | Gap dual |
| `ERROR_CODES` / `BookingError` / `createBookingError` / `normalizeError` / `_handleError` | errores | |

**Contrato oficial createBooking:**

```js
const payload = {
  bookedEntity: { slot },  // slot con fechas ISO, resource {id}, location {id, locationType: OWNER_BUSINESS}
  contactDetails: { ... },
  totalParticipants: 1
};
await elevate(bookings.createBooking)(payload, {
  flowControlSettings: { skipAvailabilityValidation: true } // solo tras revalidacion propia
});
```

### 6.2 bookingSaga

| Simbolo | Descripcion |
|---------|-------------|
| `executeBookingSaga(input)` | Entrada unica simple/dual |
| `BookingSagaOrchestrator` | Clase orquestadora |
| `_normalizePersistedMeta` | Meta persistida |

Flujo dual: lock → transaction → create F1 → create F2 (secuencial) → persist ambas → checkout si ONLINE → complete transaction. Si F2 falla: compensar F1 + cola compensaciones.

### 6.3 reservas.web (webMethods)

| WebMethod | Permiso tipico | Uso |
|-----------|----------------|-----|
| `getServiceBySlugOrId` | Anyone | Catalogo |
| `resolveServiceId` | Anyone | Resolucion ID |
| `getAvailableDays` | Anyone | Dias libres |
| `getCertifiedDualSlots` | Anyone | Pares dual |
| `resolveStaffForSlot` | Anyone/Admin | Staff para slot |
| `invalidateCachesInternal` | Admin | Invalidar cache |

Internals exportados para saga: `_resolveServiceIdInternal`, `_getServiceBySlugOrIdInternal`, `_resolveStaffForSlotInternal`, `_invalidateCachesInternal`, `_getCertifiedDualSlotsInternal`.

### 6.4 citasManager.web

| WebMethod | Uso |
|-----------|-----|
| `processDualBooking` | Alta dual (delega saga) |
| `confirmPayment` | Confirmacion pago |
| `rescheduleExistingBooking` | Reprogramar simple |
| `rescheduleDualBookings` | Reprogramar dual |

### 6.5 cajas.web

| Simbolo | Uso |
|---------|-----|
| `registerManualTransaction` | Movimiento de caja generico |
| `registerBookingPayment` | Cobro ligado a booking(s) |
| `queueFiscalRecovery` | CompensacionesPendientes |
| `getCashierState` | Estado caja |
| `registerZClosing` | Cierre Z |
| `verifyFiscalHashChainIntegrity` | Auditoria hash |
| `registerGiftCardSale` / `registerGiftCardRedemption` | Tarjeta regalo |

Tras insert en MovimientosCaja: `projectLedgerMovementToAccounting(movimiento)` en background.

### 6.6 events.js (handlers automaticos Wix)

| Handler | Efecto |
|---------|--------|
| `wixBookingsV2_onBookingConfirmed` | Alinea estado cita |
| `wixBookingsV2_onBookingCanceled` | Cita CANCELED + side effects |
| `wixEcom_onOrderPaymentStatusUpdated` | PAID → ledger + inventario |
| `wixEcom_onOrderRefunded` | Refund ledger + inventario |
| `wixEcom_onOrderCanceled` | Cancelacion coherente |

Idempotencia: `ProcessedWebhookEvents` por `eventId`.

### 6.7 contabilidad.js

| Simbolo | Uso |
|---------|-----|
| `projectLedgerMovementToAccounting` | Movimiento → asiento + lineas |
| `isAccountingProjectionError` | Clasificacion error |

### 6.8 inventario.web

| Simbolo | Uso |
|---------|-----|
| `recordOnlineInventoryOrderInternal` | Baja stock por pedido |
| `recordOnlineInventoryRefundInternal` | Restock / traza refund |
| `recordInventoryMovementSafe` | Movimiento generico |
| Dashboard / cierre inventarios | webMethods gestion |

---

## 7. FLUJOS DE NEGOCIO

### 7.1 Reserva simple (presencial / unpaid)

1. UI → `executeBookingSaga` / webMethod reservas-citas.
2. Resolve service + staff + revalidate slot.
3. Lock slot + init transaction.
4. `createBooking` oficial Bookings V2.
5. `_persistBooking` → CitasF2 (`CONFIRMED` / `UNPAID`).
6. Unlock + complete transaction.

### 7.2 Reserva dual (gap)

1. Certificar par F1/F2 (`getCertifiedDualSlots` / cache).
2. Locks de ambos slots.
3. Create F1 → Create F2 secuencial.
4. Dos filas CitasF2 mismo `pairToken`, tipos `DUAL_F1` / `DUAL_F2`.
5. Compensacion si F2 falla.

### 7.3 Reserva online (pago)

1. Saga con forma ONLINE → status `PENDING_PAYMENT`.
2. `createCheckout` + `checkoutUrl` en `meta`.
3. Cliente paga en checkout Wix.
4. Webhook `onOrderPaymentStatusUpdated` → `registerBookingPayment` → MovimientosCaja `VENTA_ONLINE`.
5. Proyeccion contable async + inventario si hay productos.
6. Cita → `paymentStatus: PAID`.

### 7.4 Cancelacion / reembolso

1. Bookings cancel webhook y/o eCom refund.
2. `_updateCitaSafe` estados.
3. Ledger reembolso + inventario refund.
4. Compensaciones si queda trabajo pendiente.

### 7.5 Caja presencial

1. `registerManualTransaction` con TIPO_MOVIMIENTO y FORMA_PAGO.
2. Actualiza CajaActual.
3. Proyeccion contable async.
4. Cierre Z → HistoricoCierresZ.

### 7.6 Mantenimiento (jobs)

| Job | Cron (Madrid) | Funcion |
|-----|---------------|---------|
| cleanExpiredLocks | 15 * * * * | SlotLocks |
| cleanupExpiredDualCache | 20 * * * * | DualSlotCache |
| runPendingCompensationsJob | 30 * * * * | Compensaciones |
| cleanExpiredDaysCache | 0 1 * * * | AvailabilityDaysCache |
| cleanExpiredSlotsCache | 10 1 * * * | slots cache |
| verifyNightlyZClosing | 20 1 * * * | Cierre Z |
| systemHealthCheck | 0 7 * * * | Salud |
| cleanAuditLogs | 0 2 * * 0 | Retencion logs |

---

## 8. ERRORES CANONICOS (ERROR_CODES)

Usar siempre `createBookingError` / `normalizeError`. Codigos tipicos en core: validacion, lock, disponibilidad, pago, desconocido. No filtrar mensajes internos al cliente: usar `responseUtils._toPublicError`.

---

## 9. SEGURIDAD

- **Elevacion selectiva** solo en llamadas Writer que lo requieren.
- **Rate limiting** (`security.rateLimiter`) en superficies publicas.
- **Logger** enmascara PII/secretos.
- **Hooks data.js**: bloqueo de update/remove en colecciones fiscales/caja.
- **HTTP M365**: HMAC + timingSafeEqual.
- WebMethods de mutacion sensible: `requireCajero` / `requireAdmin` / `requireMarianManager`.

---

## 10. DESPLIEGUE Y VERSION

- Paquete de referencia: **v5008.3-FINAL**.
- Tras deploy: crear CMS `ProcessedWebhookEvents` si no existe.
- Verificar checklist: simple → dual → pago online → cancel/refund → cuadre caja/contabilidad.

### 10.1 Compatibilidad Wix

| Requisito | Estado |
|-----------|--------|
| Bookings V2 Writer | Si (sin APIs deprecadas) |
| eCom checkout V2 | Si |
| Webhooks nativos | Si |
| Velo webMethods | Si |
| Git Integration backend | Si |

---

## 11. GLOSARIO RAPIDO

| Termino | Significado |
|---------|-------------|
| SSOT | Single Source of Truth (internalConfig + CitasF2) |
| pairToken | Clave idempotente de una reserva (simple o dual) |
| elevate | Ejecutar API Wix con permisos elevados de backend |
| LEDGER_V3 | Esquema actual de MovimientosCaja con hash chain |
| Dual | Dos bookings enlazados (F1 + F2) con gap de exposicion |
| Compensacion | Deshacer/recuperar tras fallo parcial de saga o fiscal |

---

*Documento generado a partir del codigo v5008.3-FINAL y de la configuracion SSOT del repositorio. Cualquier cambio de IDs de staff, location o App IDs debe actualizarse en `internalConfig.js` y en este documento.*
