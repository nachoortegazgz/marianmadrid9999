# BIBLIA TECNICA DEL PROYECTO
## Marian Madrid — Peluqueria y Estetica
### Version de referencia: v5009-V20-FINAL
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
| `movementType` | Text | TIPO_MOVIMIENTO |
| `concept` | Text | |
| `resourceId` | Text | staff u `ONLINE` |
| `linkedBookingIds` | Text | bookingId(s) CSV |
| `transactionId` | Text | **indice** (idempotencia) |
| `orderId` | Text | eCom |
| `schemaVersion` | Text | `LEDGER_V3` |
| hash / prevHash | Text | cadena fiscal |
| `registeredAt` | DateTime | |

**Permisos:** solo roles caja/admin; hooks `data.js` impiden update/remove indebidos.

**Indices:** `(transactionId)`, `(registeredAt)`, `(movementType + registeredAt)`, `(linkedBookingIds)`

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

- Paquete de referencia: **v5009-V20-FINAL**.
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

# SSOT CMS V20.1-EXPANDED-v3 + JSON Matriz de Cambio

Documento consolidado con el esquema completo de las 15 colecciones y la matriz de migración.

---

# PARTE 1 — SSOT CMS V20.1-EXPANDED-v3

## Convenciones

- **ID nativa:** inglés camelCase (Wix API o AEAT si no hay nativo)
- **Nombre visible:** español, respetando orden de términos
- **`fiscalPayload` interno:** conserva nombres AEAT oficiales en español (excepción normativa)
- **Enums:** Text + "Accept specific values only" con valores en MAYÚSCULAS español

---

## 1. `DatosFiscales`

| ID nativa | Nombre visible | Tipo | Notas |
|---|---|---|---|
| `_id` | id | System | PK Wix |
| `_createdDate` | fechaCreacion | System | Auto |
| `_updatedDate` | fechaActualizacion | System | Auto |
| `_owner` | propietario | System | Auto |
| `taxId` | nifCif | Text | Unique, required, checksum AEAT |
| `legalName` | razonSocial | Text | Required, uppercase |
| `thirdPartyType` | tipoTercero | Text enum | CLIENTE/PROVEEDOR/STAFF/AAPP/MIXTO |
| `contactData` | datosContacto | Object | `{email, tel, cp, direccion, municipio, provincia, pais}` |
| `specialRegimes` | regimenesEspeciales | Object | Flags booleanos AEAT |
| `isRetailerEquivalenceSurcharge` | esMinoristaRecargoEquivalencia | Boolean | Condición para RE |
| `isBusinessProfessional` | esEmpresarioProfesional | Boolean | Exige domicilio en F2 |
| `bookingsResourceId` | recursoIdReservas | Text | FK a Bookings (solo STAFF) |
| `staffMemberId` | personalMiembroId | Text | FK a Members (solo STAFF) |
| `isRegularSupplier` | esProveedorHabitual | Boolean | Sustituye ProveedoresLista |
| `paymentTerms` | condicionesPago | Object | `{dias, formaPago}` |
| `active` | activo | Boolean | Soft delete |
| `registrationTraceId` | trazaIdAlta | Text | Max 100 |

**Índices:** `(taxId) unique`, `(thirdPartyType, active)`, `(bookingsResourceId)`

---

## 2. `MapaStaff`

| ID nativa | Nombre visible | Tipo | Notas |
|---|---|---|---|
| `_id` | id | System | PK Wix |
| `staffMemberId` | personalMiembroId | Text | Unique, required |
| `resourceId` | recursoId | Text | Unique, required |
| `name` | nombre | Text | Max 100 |
| `email` | correo | Text | **NUEVO V20.1** |
| `active` | activo | Boolean | **NUEVO V20.1** |
| `rol` | rol | Text enum | ADMIN/GESTION/ESTILISTA. **NUEVO V20.1** |
| `thirdPartyId` | terceroId | Text | FK a DatosFiscales |
| `displayName` | nombreMostrado | Text | Usado por staff.js |
| `scheduleId` | horarioId | Text | Schedule de Bookings |
| `locationId` | ubicacionId | Text | Location de Bookings |
| `phone` | telefono | Text | — |
| `notes` | notas | Text | — |

**Índices:** `(staffMemberId) unique`, `(resourceId) unique`, `(email)`, `(active)`

---

## 3. `ServiciosCatalogo`

| ID nativa | Nombre visible | Tipo | Notas |
|---|---|---|---|
| `_id` | id | System | PK Wix |
| `_createdDate` / `_updatedDate` / `_owner` | Sistema | — | Auto |
| `serviceId` | servicioId | Text | Unique, GUID Bookings |
| `slugUrl` | slugUrl | Text | Unique |
| `title` | titulo | Text | Required |
| `price` | precio | Number | ≥ 0, sin IVA |
| `currency` | moneda | Text | EUR |
| `sku` | sku | Text | Unique |
| `allowCombine` | permitirCombinar | Boolean | Servicio dual |
| `linkedPhases` | enlazadaFases | Text | GUID servicio F2 |
| `phase1Duration` | fase1Duracion | Number | Minutos |
| `phase2Duration` | fase2Duracion | Number | Minutos |
| `exposureDuration` | exposicionDuracion | Number | Minutos |
| `totalDuration` | totalDuracion | Number | Minutos |
| `durationRange` | duracionRango | Object | `{min, max}` |
| `availableStaff` | disponiblePersonal | Text | CSV GUIDs |
| `addOnOptions` | complementoOpciones | Array | Max 5 |
| `hidden` | oculto | Boolean | — |
| `taxIncluded` | impuestoIncluido | Boolean | — |
| `taxRate` | tipoImpositivo | Number | 0/0.04/0.10/0.21 |
| `serviceType` | tipoServicio | Text | APPOINTMENT/CITA |
| `locationId` | ubicacionId | Text | — |
| `location` | ubicacion | Text | — |
| `itemNature` | naturalezaItem | Text enum | SERVICIO_PROPIO/PRODUCTO_VENTA/PRODUCTO_USO/GASTO_FIJO |
| `taxCode` | codigoImpuesto | Text enum | IVA_21/IVA_10/IVA_4/IVA_0/IRPF_15/IRPF_19/EXENTO |
| `aeatRegimeKey` | claveRegimenAEAT | Text enum | 01–20 |
| `aeatOperationClassification` | calificacionOperacionAEAT | Text enum | S1/S2/N1/N2 |
| `aeatExemptOperation` | operacionExentaAEAT | Text enum | E1–E6 |
| `reverseCharge` | inversionSujetoPasivo | Boolean | — |
| `incomeAccountCode` | cuentaContableIngreso | Text | PGC 6 dígitos |
| `expenseAccountCode` | cuentaContableGasto | Text | PGC 6 dígitos |
| `active` | activo | Boolean | Soft delete |

**Índices:** `(serviceId) unique`, `(sku) unique`, `(active, itemNature)`

---

## 4. `ComplementosCatalogo`

| ID nativa | Nombre visible | Tipo | Notas |
|---|---|---|---|
| `_id` | id | System | PK Wix |
| `taxCode` | codigoImpuesto | Text enum | — |
| `aeatRegimeKey` | claveRegimenAEAT | Text | — |
| `incomeAccountCode` | cuentaContableIngreso | Text | PGC |
| `itemNature` | naturalezaItem | Text enum | — |

---

## 5. `MovimientosCaja`

**Append-only.** Cabecera del log atómico fiscal.

| ID nativa | Nombre visible | Tipo | Notas |
|---|---|---|---|
| `_id` / `_createdDate` / `_updatedDate` / `_owner` | Sistema | — | Auto |
| `amount` | importeTotalLegacy | Number | Alias legacy |
| `totalAmount` | importeTotal | Number | Canónico |
| `paymentMethod` | medioCobro | Text enum | EFECTIVO/TARJETA/BIZUM/ONLINE/TARJETA_REGALO |
| `movementType` | tipoMovimiento | Text enum | 20 valores |
| `concept` | descripcionOperacionLegacy | Text | Alias legacy |
| `operationDescription` | descripcionOperacion | Text | Canónico |
| `resourceId` | recursoId | Text | **Deprecado** |
| `staffResourceId` | personalRecursoId | Text | FK MapaStaff |
| `channelType` | canalTipo | Text enum | POS/ONLINE/CAJA_LOCAL/TELEFONO |
| `linkedBookingIds` | reservaIdVinculada | Text | CSV bookingIds |
| `transactionId` | transaccionId | Text | Indexed, idempotencia |
| `orderId` | pedidoId | Text | eCom |
| `refundId` | reembolsoId | Text | **NUEVO** |
| `schemaVersion` | esquemaVersion | Text | LEDGER_V5_FISCAL |
| `hash` | huellaLegacy | Text | Alias legacy |
| `recordHash` | huella | Text | Canónico SHA-256 |
| `prevHash` | huellaAnteriorLegacy | Text | Alias legacy |
| `previousRecordHash` | huellaAnterior | Text | Canónico |
| `registeredAt` | fechaHoraHusoGenRegistroLegacy | DateTime | Alias |
| `recordTimestamp` | fechaHoraHusoGenRegistro | Text | ISO 8601 Madrid |
| `generationTimestamp` | generationTimestamp | Object | Desglose fecha/hora |
| `invoiceNumber` | numSerieFactura | Text | Unique, FAC-YYYY-NNNNN |
| `invoiceIssueDate` | fechaExpedicionFactura | Date | — |
| `operationDate` | fechaOperacion | Date | Opcional |
| `invoiceType` | tipoFactura | Text enum | F1/F2/F3/R1–R5 |
| `correctionType` | tipoRectificativa | Text enum | S/I |
| `correctionAmount` | importeRectificacion | Object | — |
| `correctionReason` | motivoRectificacion | Text | Enum AEAT |
| `issuerInvoiceNumber` | numSerieFacturaEmisor | Text | Rectificativas |
| `taxableBaseOrNonSubjectAmount` | baseImponibleOImporteNoSujeto | Number | — |
| `taxAmount` | cuotaTotal | Number | — |
| `taxRate` | tipoImpositivo | Number | — |
| `surchargeRate` | tipoRecargoEquivalencia | Number | — |
| `surchargeAmount` | cuotaRecargoEquivalencia | Number | — |
| `irpfWithholdingAmount` | importeRetencionIRPF | Number | — |
| `irpfWithholdingRate` | tipoRetencionIRPF | Number | — |
| `withholdingBase` | baseImponibleRetencion | Number | — |
| `fiscalRole` | rolFiscal | Text enum | EMISOR/RECEPTOR |
| `isB2B` | esB2B | Boolean | **NUEVO** |
| `issuerTaxId` | nifEmisor | Text | Snapshot |
| `issuerLegalName` | nombreRazonEmisor | Text | Snapshot |
| `recipientTaxId` | nifDestinatario | Text | Snapshot |
| `recipientLegalName` | nombreRazonDestinatario | Text | Snapshot |
| `recipientAddress` | domicilioDestinatario | Object | — |
| `issuedByThirdPartyOrRecipient` | emitidaPorTerceroODestinatario | Text enum | E/D/T |
| `thirdPartyLegalName` | nombreRazonTercero | Text | — |
| `issuerThirdPartyTaxId` | nifTerceroExpedidor | Text | — |
| `nonSubjectReason` | causaNoSujeta | Text enum | N1/N2 |
| `reverseCharge` | inversionSujetoPasivo | Boolean | — |
| `regimeKey` | claveRegimen | Text enum | L7 |
| `operationClassification` | calificacionOperacion | Text enum | S1/S2/N1/N2 |
| `exemptOperation` | operacionExenta | Text enum | E1–E6 |
| `cashBasisRegime` | regimenEspecialCriterioCaja | Boolean | — |
| `article20Exempt` | exentaPorArticulo20 | Boolean | — |
| `linkedAdvanceId` | idAnticipoVinculado | Text | **NUEVO** |
| `vatAccrualStatus` | estadoDevengoIVA | Text | **NUEVO** |
| `bankReconciliationReference` | referenciaBancariaConciliacion | Text | **NUEVO** |
| `detailedBreakdown` | desgloseDetallado | Array | AEAT |
| `computerSystem` | sistemaInformatico | Object | Snapshot |
| `previousInvoiceId` | idFacturaAnterior | Text | Encadenamiento |
| `previousInvoiceNumber` | numSerieFacturaAnterior | Text | Encadenamiento |
| `previousInvoiceIssueDate` | fechaExpedicionFacturaAnterior | Date | Encadenamiento |
| `aeatSubmissionStatus` | estadoEnvioAeat | Text enum | 5 valores |
| `aeatCsv` | csvAeat | Text | — |
| `aeatSubmissionDate` | fechaEnvioAeat | Date | — |
| `eventType` | tipoEvento | Text enum | VENTA_LINEA/COMPRA_LINEA/CIERRE_Z/AJUSTE/RECTIFICATIVA/MOV_STOCK |
| `thirdPartyId` | terceroId | Text | FK DatosFiscales |
| `catalogId` | catalogoId | Text | FK ServiciosCatalogo |
| `pairToken` | parToken | Text | Saga dual |
| `fiscalPayload` | payloadFiscal | Object | Snapshot AEAT inmutable |
| `sequenceNumber` | secuenciaNumerica | Number | Unique, monótono |
| `projectionStatus` | proyeccionEstado | Text enum | PENDIENTE/OK/ERROR |
| `projectionDetailIds` | proyeccionDetalleIds | Array | UUIDs |
| `traceId` | trazaId | Text | Max 100 |
| `taxTreatment` | taxTreatment | Text | **NUEVO** (legacy) |
| `lineItems` | lineItems | Array | **NUEVO** (legacy) |
| `recordSource` | origenRegistro | Text | **NUEVO** |

**Índices:** `(invoiceNumber) unique`, `(transactionId)`, `(registeredAt)`, `(movementType, registeredAt)`, `(linkedBookingIds)`, `(thirdPartyId, invoiceIssueDate)`, `(eventType, invoiceIssueDate)`, `(sequenceNumber) unique`

**Append-only:** `beforeUpdate` / `beforeRemove` bloqueados por hook.

---

## 6. `AsientosContables`

| ID nativa | Nombre visible | Tipo | Notas |
|---|---|---|---|
| `_id` / `_createdDate` / `_updatedDate` / `_owner` | Sistema | — | Auto |
| `journalEntryId` | idAsientoDiario | Text | Unique, required |
| `sequenceNumber` | secuenciaNumerica | Number | Copia cabecera |
| `fiscalYear` | ejercicioFiscal | Number | — |
| `fiscalPeriod` | periodoFiscal | Text | YYYY-MM |
| `operationDate` | fechaOperacion | Date | Required |
| `registeredAt` | fechaRegistro | DateTime | — |
| `operationTimeZone` | husoOperacion | Text | — |
| `entryType` | tipoAsiento | Text | — |
| `operationCategory` | categoriaOperacion | Text | — |
| `description` | descripcion | Text | Max 500 |
| `recordSource` | origenRegistro | Text | — |
| `sourceId` | idOrigen | Text | — |
| `transactionId` | transaccionId | Text | — |
| `externalReference` | referenciaExterna | Text | — |
| `invoiceNumber` | numSerieFactura | Text | Required |
| `invoiceIssueDate` | fechaExpedicionFactura | Date | — |
| `fiscalOperationDate` | fechaOperacionFiscal | Date | — |
| `currency` | moneda | Text | EUR |
| `totalDocumentAmount` | importeTotalDocumento | Number | — |
| `paymentMethod` | medioCobro | Text | — |
| `entryStatus` | estadoAsiento | Text enum | CONFIRMADO/POSTED/LOCKED |
| `previousHash` | huellaAnteriorLegacy | Text | — |
| `sourceHash` | huellaOrigen | Text | Alias legacy |
| `hashOrigen` | hashOrigen | Text | Canónico |
| `recordHash` | huella | Text | — |
| `previousRecordHash` | huellaAnterior | Text | — |
| `schemaVersion` | esquemaVersion | Text | — |
| `integrityAlgorithmVersion` | versionAlgoritmoIntegridad | Text | — |
| `traceId` | trazaId | Text | Max 120 |
| `sourceEventId` | eventoOrigenId | Text | Required, FK MovimientosCaja |
| `thirdPartyId` | terceroId | Text | Required, FK DatosFiscales |
| `recipientTaxId` | nifTercero | Text | Max 20 |
| `recipientLegalName` | razonSocialTercero | Text | Max 200 |
| `issuerInvoiceNumber` | numSerieFacturaEmisor | Text | Max 60 |
| `invoiceType` | claveRegistroFactura | Text | Max 4 |
| `withholdingBase` | baseImponibleRetencion | Number | — |
| `irpfWithholdingAmount` | importeRetencionIRPF | Number | — |
| `surchargeAmount` | importeRecargoEquivalencia | Number | — |
| `fiscalRole` | rolFiscal | Text enum | EMISOR/RECEPTOR |
| `correctionReason` | motivoRectificacion | Text | Max 4 |
| `previousInvoiceId` | idFacturaRectificada | Text | Max 120 |
| `sourceData` | datosOrigenAsiento | Object | — |
| `totalDebit` | totalDebe | Number | — |
| `totalCredit` | totalHaber | Number | — |
| `entryHash` | hashAsiento | Text | — |
| `entrySignature` | firmaAsiento | Text | — |
| `fiscalPayloadSnapshot` | payloadFiscalSnapshot | Object | Copia inmutable |
| `detailedBreakdown` | desgloseDetallado | Array | — |
| `regimeKey` | claveRegimen | Text | — |
| `operationClassification` | calificacionOperacion | Text | — |
| `exemptOperation` | operacionExenta | Text | — |
| `reverseCharge` | inversionSujetoPasivo | Boolean | — |
| `computerSystem` | sistemaInformatico | Object | — |
| `previousInvoiceNumber` | numSerieFacturaAnterior | Text | Encadenamiento |
| `previousInvoiceIssueDate` | fechaExpedicionFacturaAnterior | Date | Encadenamiento |

**Índices:** `(journalEntryId) unique`, `(sourceEventId)`, `(fiscalPeriod, entryStatus)`, `(fiscalYear, fiscalPeriod)`, `(recordSource, operationDate)`

**Campos eliminados:** `externalReference` (= `invoiceNumber`), `sourceHash` (= `hashOrigen`).

---

## 7. `LibroAsientosContablesDetalle`

**Append-only.**

| ID nativa | Nombre visible | Tipo | Notas |
|---|---|---|---|
| `_id` / `_createdDate` | Sistema | — | Auto |
| `journalEntryId` | idAsientoDiario | Text | Required |
| `transactionId` | transaccionId | Text | — |
| `lineNumber` | numeroLinea | Number | Required, ≥ 1 |
| `operationDate` | fechaOperacion | Date | — |
| `accountCode` | cuentaContable | Text | Required, 6 dígitos |
| `accountName` | nombreCuenta | Text | Required |
| `accountGroup` | grupoCuenta | Text | — |
| `debitAmount` | importeDebe | Number | — |
| `creditAmount` | importeHaber | Number | — |
| `netAmount` | importeNeto | Number | — |
| `operationCategory` | categoriaOperacion | Text | — |
| `lineDescription` | descripcionLinea | Text | Max 500 |
| `externalReference` | referenciaExterna | Text | — |
| `registeredAt` | fechaRegistro | DateTime | — |
| `traceId` | trazaId | Text | — |
| `lineHash` | lineaHuella | Text | SHA-256 |
| `taxableBaseOrNonSubjectAmount` | baseImponibleOImporteNoSujeto | Number | — |
| `taxRate` | tipoImpositivo | Number | — |
| `chargedTaxAmount` | cuotaRepercutida | Number | — |
| `sourceEventId` | eventoOrigenId | Text | Required, FK MovimientosCaja |
| `thirdPartyId` | terceroId | Text | Required, FK DatosFiscales |
| `catalogId` | catalogoId | Text | Required, FK ServiciosCatalogo |
| `operationDescription` | descripcionOperacion | Text | Required, Max 500 |
| `units` | unidades | Number | Required, > 0 |
| `magnitude` | magnitud | Number | Required, ±1 |
| `netUnitAmount` | importeNetoUnitario | Number | — |
| `taxCode` | codigoImpuesto | Text | — |
| `regimeKey` | claveRegimen | Text | — |
| `operationClassification` | calificacionOperacion | Text | — |
| `exemptOperation` | operacionExenta | Text | — |
| `reverseCharge` | inversionSujetoPasivo | Boolean | — |
| `recipientTaxId` | nifTercero | Text | Max 20 |
| `recipientLegalName` | razonSocialTercero | Text | Max 200 |
| `issuerInvoiceNumber` | numSerieFacturaEmisor | Text | Max 60 |
| `invoiceType` | claveRegistroFactura | Text | Max 4 |
| `withholdingBase` | baseImponibleRetencion | Number | — |
| `irpfWithholdingAmount` | importeRetencionIRPF | Number | — |
| `irpfWithholdingRate` | tipoRetencionIRPF | Number | — |
| `surchargeRate` | tipoRecargoEquivalencia | Number | — |
| `surchargeAmount` | cuotaRecargoEquivalencia | Number | — |
| `fiscalRole` | rolFiscal | Text enum | EMISOR/RECEPTOR |
| `correctionReason` | motivoRectificacion | Text | Max 4 |
| `previousInvoiceId` | idFacturaRectificada | Text | Max 120 |

**Índices:** `(sourceEventId, lineNumber)`, `(journalEntryId, lineNumber)`, `(thirdPartyId)`, `(catalogId)`, `(accountCode)`

---

## 8. `CitasF2`

| ID nativa | Nombre visible | Tipo | Notas |
|---|---|---|---|
| `_id` / `_createdDate` / `_updatedDate` | Sistema | — | Auto |
| `bookingId` | reservaId | Text | Unique, required |
| `pairToken` | parToken | Text | Indexed |
| `revision` | revision | Number | — |
| `serviceId` | servicioId | Text | Required |
| `scheduleId` | horarioId | Text | — |
| `resourceId` | recursoId | Text | Required |
| `staffResourceId` | personalRecursoId | Text | — |
| `startDate` | inicioFecha | DateTime | Required |
| `endDate` | finFecha | DateTime | Required |
| `dateYmd` | fechaYmd | Text | Required, YYYY-MM-DD |
| `bookingType` | reservaTipo | Text enum | SIMPLE/DUAL_F1/DUAL_F2 (acepta legacy lowercase) |
| `status` | estado | Text enum | CONFIRMED/PENDING_PAYMENT/CANCELLED/CANCELED/REFUNDED |
| `paymentStatus` | pagoEstado | Text enum | 7 valores |
| `meta` | meta | Object | JSON auxiliar |
| `contactDetails` | contactoDetalles | Object | — |
| `thirdPartyId` | terceroId | Text | FK DatosFiscales |
| `catalogId` | catalogoId | Text | FK ServiciosCatalogo |
| `sourceEventId` | eventoOrigenId | Text | FK MovimientosCaja |
| `fiscalData` | datosFiscales | Object | `{nifDestinatario, nombreRazonDestinatario, ...}` |
| `cashMovementId` | movimientoCajaId | Text | FK cobro |
| `invoicingDate` | fechaFacturacion | Date | — |
| `traceId` | trazaId | Text | Required, Max 100 |

**Índices:** `(bookingId) unique`, `(pairToken)`, `(dateYmd, resourceId)`, `(serviceId, dateYmd)`, `(status, paymentStatus)`

---

## 9. `FacturasRecibidas`

| ID nativa | Nombre visible | Tipo | Notas |
|---|---|---|---|
| `_id` / `_createdDate` / `_updatedDate` | Sistema | — | Auto |
| `receptionNumber` | numeroRecepcion | Text | Unique |
| `invoiceNumber` | numSerieFactura | Text | Required |
| `invoiceIssueDate` | fechaExpedicionFactura | Date | Required |
| `operationDate` | fechaOperacion | Date | — |
| `receptionDate` | fechaRecepcion | Date | Required |
| `accountingEntryDate` | fechaRegistroContable | Date | Required |
| `thirdPartyId` | terceroId | Text | Required |
| `issuerTaxId` / `issuerLegalName` | nifEmisor/nombreRazonEmisor | Text | Snapshot |
| `recipientTaxId` / `recipientLegalName` | nifDestinatario/nombreRazonDestinatario | Text | Snapshot |
| `invoiceType` | tipoFactura | Text enum | F1/F2/R1–R5 |
| `operationDescription` | descripcionOperacion | Text | Required, Max 500 |
| `totalAmount` | importeTotal | Number | Required |
| `totalTaxableBase` | baseImponibleTotal | Number | Required |
| `totalVatAmount` | cuotaIvaTotal | Number | Required |
| `surchargeAmount` | cuotaRecargoEquivalencia | Number | — |
| `irpfWithholdingAmount` | importeRetencionIRPF | Number | — |
| `irpfWithholdingRate` | tipoRetencionIRPF | Number | — |
| `detailedBreakdown` | desgloseDetallado | Array | — |
| `regimeKey` | claveRegimen | Text | — |
| `operationClassification` | calificacionOperacion | Text | — |
| `exemptOperation` | operacionExenta | Text | — |
| `reverseCharge` | inversionSujetoPasivo | Boolean | — |
| `specialRegime` | regimenEspecial | Object | — |
| `deductible` | deducible | Boolean | — |
| `deductionPercentage` | porcentajeDeduccion | Number | 0–100 |
| `deductibleAmount` | cuotaDeducible | Number | — |
| `paymentStatus` | estadoPago | Text enum | PENDIENTE/PAGADO/PARCIAL |
| `paymentDate` | fechaPago | Date | — |
| `paymentMethod` | medioPago | Text enum | 01–05 |
| `expenseAccountCode` / `vatAccountCode` / `supplierAccountCode` | cuentas contables | Text | 6 dígitos |
| `accountingEntryId` | asientoContableId | Text | FK |
| `sourceEventId` | eventoOrigenId | Text | Required |
| `correctedInvoiceId` | facturaRectificadaId | Text | — |
| `correctionReason` | motivoRectificacion | Text | Max 500 |
| `attachmentUrl` | documentoAdjuntoUrl | URL | — |
| `fileHash` | archivoHash | Text | SHA-256 |
| `receptionSource` | origenRecepcion | Text enum | MANUAL/EMAIL/API/OCR |
| `validationStatus` | estadoValidacion | Text enum | PENDIENTE/VALIDADA/RECHAZADA |
| `traceId` | trazaId | Text | Max 100 |

**Índices:** `(receptionNumber) unique`, `(thirdPartyId, invoiceIssueDate)`, `(paymentStatus)`

---

## 10. `HistoricoCierresZ`

**Contenedor polivalente** (cierres Z caja + cierres inventario + paquetes gestoría).

| ID nativa | Nombre visible | Tipo | Notas |
|---|---|---|---|
| `_id` / `_createdDate` | Sistema | — | Auto |
| `operationDate` | fechaOperacion | Date | **Opcional** (no aplica a inventario/gestoría) |
| `closingStatus` | estadoCierre | Text | — |
| `consolidatedTotalAmount` | importeTotalConsolidado | Number | — |
| `grossSalesTotal` | ventasBrutasTotales | Number | — |
| `netTaxableAmount` | baseImponibleNeta | Number | — |
| `netTaxAmount` | cuotaIvaNeta | Number | — |
| `totalCash` / `totalCard` / `totalBizum` / `totalOnline` | Totales por método | Number | — |
| `totalRefunds` / `totalTips` / `totalAdjustments` | Totales | Number | — |
| `totalOperations` | totalOperaciones | Number | — |
| `startSequence` / `endSequence` | Secuencias | Number | — |
| `startTicketNumber` / `endTicketNumber` | Tickets | Text | — |
| `startRecordHash` / `endRecordHash` | Huellas | Text | — |
| `balancesByMethod` | saldosPorMetodo | Object | — |
| `movementTypeBreakdown` | desgloseTipoMovimiento | Object | — |
| `taxTypeBreakdown` | desgloseTipoImpositivo | Object | — |
| `isIntegrityVerified` | integridadVerificada | Boolean | — |
| `auditedRecordsCount` | registrosAuditados | Number | — |
| `closingHash` | huellaCierre | Text | SHA-256 |
| `closingSignature` | firmaCierre | Text | HMAC |
| `closingSignatureStatus` | estadoFirmaCierre | Text | — |
| `closingSource` | origenCierre | Text | — |
| `closingSchemaVersion` | esquemaVersionCierre | Text | — |
| `timeZone` | husoHorario | Text | — |
| `closedAt` / `verifiedAt` | Cierres | DateTime | — |
| `approverUser` | usuarioAprobador | Text | — |
| `sourceEventId` | eventoOrigenId | Text | Required |
| `breakdownByRegime` | desglosePorRegimen | Array | — |
| `breakdownByOperationType` | desglosePorTipoOperacion | Array | — |
| `breakdownByTaxRate` | desglosePorTipoImpositivo | Array | — |
| `verifactuSummary` | resumenVerifactu | Object | — |
| `aeatSubmissionStatus` | estadoEnvioAeat | Text enum | — |
| `aeatSubmissionDate` | fechaEnvioAeat | Date | — |
| `aeatResponse` | respuestaAeat | Object | — |
| `aeatCsv` | csvAeat | Text | — |
| `traceId` | trazaId | Text | Max 120 |
| **-- Cierres de inventario --** | | | |
| `inventoryClosingId` | idCierreInventario | Text | Unique |
| `fiscalYear` | ejercicioFiscal | Number | — |
| `closingDate` | fechaCierre | DateTime | — |
| `closingType` | tipoCierre | Text enum | ANUAL/MENSUAL/EXTRAORDINARIO/PAQUETE_GESTORIA |
| `sku` | sku | Text | — |
| `productId` | productoId | Text | — |
| `productDescription` | descripcionProducto | Text | — |
| `stockQuantity` | cantidadStock | Number | — |
| `unitCost` | costeUnitario | Number | — |
| `stockValue` | valorStock | Number | — |
| `accountCode` | cuentaContable | Text | PGC |
| `debitBalance` | saldoDebe | Number | — |
| `creditBalance` | saldoHaber | Number | — |
| **-- Paquetes de gestoría --** | | | |
| `summaryData` | datosResumen | Object | — |
| `invoiceData` | datosFacturas | Array | — |
| `status` | estado | Text enum | PREPARED/SENT |

**Índices:** `(operationDate)`, `(inventoryClosingId) unique`, `(fiscalYear, closingType)`, `(closingType, _createdDate)`, `(sku, closingType)`

**Deuda técnica:** separar en 3 colecciones en v5010.

---

## 11. `CompensacionesPendientes`

| ID nativa | Nombre visible | Tipo | Notas |
|---|---|---|---|
| `_id` | id | System | PK Wix |
| `id` | idCompensacion | Text | Legacy |
| `kind` | tipo | Text enum | FISCAL_LEDGER/BOOKING_ROLLBACK/PAYMENT_RECOVERY/CANCEL_BOOKING/RESYNC_LEDGER_ACCOUNTING/RESYNC_CAJA_BALANCE |
| `status` | estado | Text enum | PENDING/PENDING_RECOVERY/PROCESSING/FAILED/COMPLETED/RETRYING |
| `bookingId` | reservaId | Text | — |
| `bookingIds` | reservaIds | Text | CSV |
| `phase` | fase | Text | — |
| `attempts` | intentos | Number | — |
| `amount` | importe | Number | — |
| `paymentMethod` | medioCobro | Text | — |
| `transactionId` | transaccionId | Text | — |
| `orderId` / `refundId` | — | Text | — |
| `concept` | concepto | Text | Max 500 |
| `movementType` | tipoMovimiento | Text | — |
| `alertRequired` | alertaRequerida | Boolean | — |
| `lastError` | ultimoError | Text | Max 500 |
| `errorCode` | errorCodigo | Text | — |
| `errorMessage` | errorMensaje | Text | Max 500 |
| `origin` | origen | Text | — |
| `sourceEventId` | eventoOrigenId | Text | — |
| `thirdPartyId` | terceroId | Text | — |
| `traceId` | trazaId | Text | Max 100 |

**Índices:** `(status, updatedDate)`, `(kind, status)`, `(bookingId)`

---

## 12. `MovimientosInventario`

| ID nativa | Nombre visible | Tipo | Notas |
|---|---|---|---|
| `_id` | id | System | PK Wix |
| `movementToken` | tokenMovimiento | Text | Unique (idempotencia) |
| `sku` | sku | Text | Required |
| `productName` | nombreProducto | Text | — |
| `quantity` | cantidad | Number | Valor absoluto |
| `quantityDelta` | cantidadDelta | Number | Con signo |
| `stockBefore` / `stockAfter` | stockAntes/Despues | Number | — |
| `movementType` | tipoMovimiento | Text | Enum interno |
| `reason` | motivo | Text | — |
| `referenceId` | idReferencia | Text | — |
| `orderId` / `refundId` | — | Text | — |
| `actorEmail` / `actorMemberId` | Actor | Text | — |
| `requiresWixReconciliation` | requiereConciliacionWix | Boolean | — |
| `nativeCommercialMovement` | movimientoComercialNativo | Boolean | — |
| `wixProductId` / `wixVariantId` | IDs Wix | Text | — |
| `sourceEventId` | eventoOrigenId | Text | Required, FK MovimientosCaja |
| `catalogId` | catalogoId | Text | Required, FK ServiciosCatalogo |
| `magnitude` | magnitud | Number | ±1 |
| `thirdPartyId` | terceroId | Text | FK DatosFiscales |
| `traceId` | trazaId | Text | Max 100 |

**Índices:** `(sku, sourceEventId)`, `(orderId)`, `(movementToken) unique`

---

## 13. `RegistrosHorariosStaff`

**Append-only.**

| ID nativa | Nombre visible | Tipo | Notas |
|---|---|---|---|
| `_id` / `_createdDate` | Sistema | — | Auto |
| `resourceId` | recursoId | Text | Required |
| `displayName` | nombreMostrado | Text | — |
| `staffMemberId` | personalMiembroId | Text | — |
| `recordedAt` | fechaRegistro | DateTime | Required |
| `recordedTime` | horaRegistro | Text | — |
| `dayKey` | claveDia | Text | Required, YYYY-MM-DD Madrid |
| `monthKey` | claveMes | Text | YYYY-MM |
| `clockEventType` | tipoFichaje | Text enum | ENTRADA/SALIDA/PAUSA_INICIO/PAUSA_FIN/AJUSTE |
| `type` | tipo | Text enum | REGULAR/AJUSTE |
| `employeeIdentifier` | identificadorEmpleado | Text | — |
| `employeeName` | nombreEmpleado | Text | — |
| `registeredBy` | registradoPor | Text enum | SELF/ADMIN |
| `registeredByMemberId` | miembroRegistrador | Text | — |
| `recordingName` | nombreRegistrador | Text | — |
| `adjustmentReason` | motivoAjuste | Text | Max 500 |
| `deviceIp` / `deviceIpAddress` | IP Dispositivo | Text | — |
| `signature` | firma | Text | HMAC |
| `meta` | meta | Object | — |
| `traceId` | trazaId | Text | Max 120 |

**Índices:** `(resourceId, dayKey)`, `(resourceId, monthKey)`, `(resourceId, recordedAt)`

---

## 14. `ConfiguracionFiscal`

| ID nativa | Nombre visible | Tipo | Notas |
|---|---|---|---|
| `_id` | id | System | PK Wix |
| `computerSystem` | sistemaInformatico | Object | Snapshot Verifactu |
| `producerTaxId` | nifProductor | Text | — |
| `producerLegalName` | nombreRazonProductor | Text | — |
| `computerSystemId` | idSistemaInformatico | Text | — |
| `version` | version | Text | — |
| `installationNumber` | numeroInstalacion | Text | — |
| `possibleUseOnlyVerifactu` | tipoUsoPosibleSoloVerifactu | Text enum | S/N |
| `possibleUseMultiOT` | tipoUsoPosibleMultiOT | Text enum | S/N |
| `multipleOTIndicator` | indicadorMultiplesOT | Text enum | S/N |
| `verifactuStartDate` | fechaInicioVerifactu | Date | — |
| `active` | activo | Boolean | — |
| `businessTaxId` | nifEmisorLegacy | Text | **Legacy**, mapea a `producerTaxId` |

---

## 15. `ProveedoresLista` (deprecada)

Read-only. Datos migrados a `DatosFiscales` con `thirdPartyType = PROVEEDOR`.

---

# PARTE 2 — JSON Matriz de Cambio

```json
{
  "matrixVersion": "V20.1-EXPANDED-v3",
  "sourceVersion": "v5008.x-FISCAL",
  "targetVersion": "v5009-FISCAL-V20.1",
  "generatedAt": "2026-09-21",
  "strategy": "RENAME_IN_PLACE_WITH_ALIAS",
  "summary": {
    "totalCollections": 15,
    "totalChanges": 378,
    "renames": 178,
    "adds": 172,
    "deletes": 10,
    "keeps": 18,
    "deprecates": 1
  },
  "collections": {
    "DatosFiscales": {
      "changeCount": 17,
      "changes": [
        { "action": "KEEP", "field": "_id" },
        { "action": "KEEP", "field": "_createdDate" },
        { "action": "KEEP", "field": "_updatedDate" },
        { "action": "KEEP", "field": "_owner" },
        { "action": "RENAME", "old": "nifCif", "new": "taxId", "visible": "nifCif", "type": "TEXT" },
        { "action": "RENAME", "old": "razonSocial", "new": "legalName", "visible": "razonSocial", "type": "TEXT" },
        { "action": "RENAME", "old": "tipoTercero", "new": "thirdPartyType", "visible": "tipoTercero", "type": "ENUM" },
        { "action": "RENAME", "old": "datosContacto", "new": "contactData", "visible": "datosContacto", "type": "OBJECT" },
        { "action": "RENAME", "old": "regimenesEspeciales", "new": "specialRegimes", "visible": "regimenesEspeciales", "type": "OBJECT" },
        { "action": "RENAME", "old": "esMinoristaRecargoEquivalencia", "new": "isRetailerEquivalenceSurcharge", "visible": "esMinoristaRecargoEquivalencia", "type": "BOOLEAN" },
        { "action": "RENAME", "old": "esEmpresarioProfesional", "new": "isBusinessProfessional", "visible": "esEmpresarioProfesional", "type": "BOOLEAN" },
        { "action": "RENAME", "old": "resourceIdBookings", "new": "bookingsResourceId", "visible": "recursoIdReservas", "type": "TEXT" },
        { "action": "KEEP", "field": "staffMemberId" },
        { "action": "RENAME", "old": "esProveedorHabitual", "new": "isRegularSupplier", "visible": "esProveedorHabitual", "type": "BOOLEAN" },
        { "action": "RENAME", "old": "condicionesPago", "new": "paymentTerms", "visible": "condicionesPago", "type": "OBJECT" },
        { "action": "RENAME", "old": "activo", "new": "active", "visible": "activo", "type": "BOOLEAN" },
        { "action": "RENAME", "old": "traceIdAlta", "new": "registrationTraceId", "visible": "trazaIdAlta", "type": "TEXT" }
      ]
    },
    "MapaStaff": {
      "changeCount": 12,
      "changes": [
        { "action": "KEEP", "field": "_id" },
        { "action": "KEEP", "field": "staffMemberId" },
        { "action": "KEEP", "field": "resourceId" },
        { "action": "RENAME", "old": "nombre", "new": "name", "visible": "nombre", "type": "TEXT" },
        { "action": "RENAME", "old": "terceroId", "new": "thirdPartyId", "visible": "terceroId", "type": "TEXT" },
        { "action": "ADD", "field": "email", "type": "TEXT" },
        { "action": "ADD", "field": "active", "type": "BOOLEAN" },
        { "action": "ADD", "field": "rol", "type": "ENUM", "values": ["ADMIN","GESTION","ESTILISTA"] },
        { "action": "ADD", "field": "displayName", "type": "TEXT" },
        { "action": "ADD", "field": "scheduleId", "type": "TEXT" },
        { "action": "ADD", "field": "locationId", "type": "TEXT" },
        { "action": "ADD", "field": "phone", "type": "TEXT" },
        { "action": "ADD", "field": "notes", "type": "TEXT" }
      ]
    },
    "ServiciosCatalogo": {
      "changeCount": 33,
      "changes": [
        { "action": "KEEP", "field": "_id" },
        { "action": "KEEP", "field": "_createdDate" },
        { "action": "KEEP", "field": "_updatedDate" },
        { "action": "KEEP", "field": "_owner" },
        { "action": "KEEP", "field": "serviceId" },
        { "action": "KEEP", "field": "slugUrl" },
        { "action": "KEEP", "field": "title" },
        { "action": "KEEP", "field": "price" },
        { "action": "KEEP", "field": "currency" },
        { "action": "KEEP", "field": "sku" },
        { "action": "KEEP", "field": "allowCombine" },
        { "action": "KEEP", "field": "linkedPhases" },
        { "action": "KEEP", "field": "phase1Duration" },
        { "action": "KEEP", "field": "phase2Duration" },
        { "action": "KEEP", "field": "exposureDuration" },
        { "action": "KEEP", "field": "totalDuration" },
        { "action": "KEEP", "field": "durationRange" },
        { "action": "KEEP", "field": "availableStaff" },
        { "action": "KEEP", "field": "addOnOptions" },
        { "action": "KEEP", "field": "hidden" },
        { "action": "KEEP", "field": "taxIncluded" },
        { "action": "KEEP", "field": "taxRate" },
        { "action": "RENAME", "old": "naturalezaItem", "new": "itemNature", "visible": "naturalezaItem", "type": "ENUM" },
        { "action": "RENAME", "old": "codigoImpuesto", "new": "taxCode", "visible": "codigoImpuesto", "type": "ENUM" },
        { "action": "RENAME", "old": "claveRegimenAEAT", "new": "aeatRegimeKey", "visible": "claveRegimenAEAT", "type": "ENUM" },
        { "action": "RENAME", "old": "calificacionOperacionAEAT", "new": "aeatOperationClassification", "visible": "calificacionOperacionAEAT", "type": "ENUM" },
        { "action": "RENAME", "old": "operacionExentaAEAT", "new": "aeatExemptOperation", "visible": "operacionExentaAEAT", "type": "ENUM" },
        { "action": "RENAME", "old": "inversionSujetoPasivo", "new": "reverseCharge", "visible": "inversionSujetoPasivo", "type": "BOOLEAN" },
        { "action": "RENAME", "old": "cuentaContableIngreso", "new": "incomeAccountCode", "visible": "cuentaContableIngreso", "type": "TEXT" },
        { "action": "RENAME", "old": "cuentaContableGasto", "new": "expenseAccountCode", "visible": "cuentaContableGasto", "type": "TEXT" },
        { "action": "RENAME", "old": "activo", "new": "active", "visible": "activo", "type": "BOOLEAN" },
        { "action": "ADD", "field": "serviceType", "type": "TEXT" },
        { "action": "ADD", "field": "locationId", "type": "TEXT" },
        { "action": "ADD", "field": "location", "type": "TEXT" }
      ]
    },
    "ComplementosCatalogo": {
      "changeCount": 4,
      "changes": [
        { "action": "RENAME", "old": "codigoImpuesto", "new": "taxCode", "visible": "codigoImpuesto", "type": "ENUM" },
        { "action": "RENAME", "old": "claveRegimenAEAT", "new": "aeatRegimeKey", "visible": "claveRegimenAEAT", "type": "TEXT" },
        { "action": "RENAME", "old": "cuentaContableIngreso", "new": "incomeAccountCode", "visible": "cuentaContableIngreso", "type": "TEXT" },
        { "action": "RENAME", "old": "naturalezaItem", "new": "itemNature", "visible": "naturalezaItem", "type": "ENUM" }
      ]
    },
    "MovimientosCaja": {
      "changeCount": 73,
      "changes": [
        { "action": "KEEP", "field": "_id" },
        { "action": "KEEP", "field": "_createdDate" },
        { "action": "KEEP", "field": "_updatedDate" },
        { "action": "KEEP", "field": "_owner" },
        { "action": "KEEP", "field": "amount" },
        { "action": "RENAME", "old": "importeTotal", "new": "totalAmount", "visible": "importeTotal", "type": "NUMBER" },
        { "action": "KEEP", "field": "paymentMethod" },
        { "action": "RENAME", "old": "tipoMovimiento", "new": "movementType", "visible": "tipoMovimiento", "type": "ENUM" },
        { "action": "KEEP", "field": "concept" },
        { "action": "RENAME", "old": "descripcionOperacion", "new": "operationDescription", "visible": "descripcionOperacion", "type": "TEXT" },
        { "action": "KEEP", "field": "resourceId" },
        { "action": "KEEP", "field": "staffResourceId" },
        { "action": "KEEP", "field": "channelType" },
        { "action": "RENAME", "old": "reservaIdVinculada", "new": "linkedBookingIds", "visible": "reservaIdVinculada", "type": "TEXT" },
        { "action": "KEEP", "field": "transactionId" },
        { "action": "KEEP", "field": "orderId" },
        { "action": "ADD", "field": "refundId", "type": "TEXT" },
        { "action": "KEEP", "field": "schemaVersion" },
        { "action": "KEEP", "field": "hash" },
        { "action": "RENAME", "old": "huella", "new": "recordHash", "visible": "huella", "type": "TEXT" },
        { "action": "KEEP", "field": "prevHash" },
        { "action": "RENAME", "old": "huellaAnterior", "new": "previousRecordHash", "visible": "huellaAnterior", "type": "TEXT" },
        { "action": "KEEP", "field": "registeredAt" },
        { "action": "RENAME", "old": "fechaHoraHusoGenRegistro", "new": "recordTimestamp", "visible": "fechaHoraHusoGenRegistro", "type": "TEXT" },
        { "action": "KEEP", "field": "generationTimestamp" },
        { "action": "RENAME", "old": "numSerieFactura", "new": "invoiceNumber", "visible": "numSerieFactura", "type": "TEXT" },
        { "action": "RENAME", "old": "fechaExpedicionFactura", "new": "invoiceIssueDate", "visible": "fechaExpedicionFactura", "type": "DATE" },
        { "action": "RENAME", "old": "fechaOperacion", "new": "operationDate", "visible": "fechaOperacion", "type": "DATE" },
        { "action": "RENAME", "old": "tipoFactura", "new": "invoiceType", "visible": "tipoFactura", "type": "ENUM" },
        { "action": "RENAME", "old": "tipoRectificativa", "new": "correctionType", "visible": "tipoRectificativa", "type": "ENUM" },
        { "action": "RENAME", "old": "importeRectificacion", "new": "correctionAmount", "visible": "importeRectificacion", "type": "OBJECT" },
        { "action": "RENAME", "old": "baseImponibleOImporteNoSujeto", "new": "taxableBaseOrNonSubjectAmount", "visible": "baseImponibleOImporteNoSujeto", "type": "NUMBER" },
        { "action": "RENAME", "old": "cuotaTotal", "new": "taxAmount", "visible": "cuotaTotal", "type": "NUMBER" },
        { "action": "RENAME", "old": "tipoImpositivo", "new": "taxRate", "visible": "tipoImpositivo", "type": "NUMBER" },
        { "action": "RENAME", "old": "tipoRecargoEquivalencia", "new": "surchargeRate", "visible": "tipoRecargoEquivalencia", "type": "NUMBER" },
        { "action": "RENAME", "old": "cuotaRecargoEquivalencia", "new": "surchargeAmount", "visible": "cuotaRecargoEquivalencia", "type": "NUMBER" },
        { "action": "RENAME", "old": "importeRetencionIRPF", "new": "irpfWithholdingAmount", "visible": "importeRetencionIRPF", "type": "NUMBER" },
        { "action": "RENAME", "old": "tipoRetencionIRPF", "new": "irpfWithholdingRate", "visible": "tipoRetencionIRPF", "type": "NUMBER" },
        { "action": "RENAME", "old": "baseImponibleRetencion", "new": "withholdingBase", "visible": "baseImponibleRetencion", "type": "NUMBER" },
        { "action": "RENAME", "old": "nifEmisor", "new": "issuerTaxId", "visible": "nifEmisor", "type": "TEXT" },
        { "action": "RENAME", "old": "nombreRazonEmisor", "new": "issuerLegalName", "visible": "nombreRazonEmisor", "type": "TEXT" },
        { "action": "RENAME", "old": "nifDestinatario", "new": "recipientTaxId", "visible": "nifDestinatario", "type": "TEXT" },
        { "action": "RENAME", "old": "nombreRazonDestinatario", "new": "recipientLegalName", "visible": "nombreRazonDestinatario", "type": "TEXT" },
        { "action": "RENAME", "old": "domicilioDestinatario", "new": "recipientAddress", "visible": "domicilioDestinatario", "type": "OBJECT" },
        { "action": "RENAME", "old": "emitidaPorTerceroODestinatario", "new": "issuedByThirdPartyOrRecipient", "visible": "emitidaPorTerceroODestinatario", "type": "ENUM" },
        { "action": "RENAME", "old": "nombreRazonTercero", "new": "thirdPartyLegalName", "visible": "nombreRazonTercero", "type": "TEXT" },
        { "action": "RENAME", "old": "nifTerceroExpedidor", "new": "issuerThirdPartyTaxId", "visible": "nifTerceroExpedidor", "type": "TEXT" },
        { "action": "RENAME", "old": "causaNoSujeta", "new": "nonSubjectReason", "visible": "causaNoSujeta", "type": "ENUM" },
        { "action": "RENAME", "old": "inversionSujetoPasivo", "new": "reverseCharge", "visible": "inversionSujetoPasivo", "type": "BOOLEAN" },
        { "action": "RENAME", "old": "claveRegimen", "new": "regimeKey", "visible": "claveRegimen", "type": "ENUM" },
        { "action": "RENAME", "old": "calificacionOperacion", "new": "operationClassification", "visible": "calificacionOperacion", "type": "ENUM" },
        { "action": "RENAME", "old": "operacionExenta", "new": "exemptOperation", "visible": "operacionExenta", "type": "ENUM" },
        { "action": "RENAME", "old": "regimenEspecialCriterioCaja", "new": "cashBasisRegime", "visible": "regimenEspecialCriterioCaja", "type": "BOOLEAN" },
        { "action": "RENAME", "old": "exentaPorArticulo20", "new": "article20Exempt", "visible": "exentaPorArticulo20", "type": "BOOLEAN" },
        { "action": "RENAME", "old": "desgloseDetallado", "new": "detailedBreakdown", "visible": "desgloseDetallado", "type": "ARRAY" },
        { "action": "RENAME", "old": "sistemaInformatico", "new": "computerSystem", "visible": "sistemaInformatico", "type": "OBJECT" },
        { "action": "RENAME", "old": "idFacturaAnterior", "new": "previousInvoiceId", "visible": "idFacturaAnterior", "type": "TEXT" },
        { "action": "RENAME", "old": "numSerieFacturaAnterior", "new": "previousInvoiceNumber", "visible": "numSerieFacturaAnterior", "type": "TEXT" },
        { "action": "RENAME", "old": "fechaExpedicionFacturaAnterior", "new": "previousInvoiceIssueDate", "visible": "fechaExpedicionFacturaAnterior", "type": "DATE" },
        { "action": "RENAME", "old": "estadoEnvioAeat", "new": "aeatSubmissionStatus", "visible": "estadoEnvioAeat", "type": "ENUM" },
        { "action": "RENAME", "old": "csvAeat", "new": "aeatCsv", "visible": "csvAeat", "type": "TEXT" },
        { "action": "RENAME", "old": "fechaEnvioAeat", "new": "aeatSubmissionDate", "visible": "fechaEnvioAeat", "type": "DATE" },
        { "action": "RENAME", "old": "tipoEvento", "new": "eventType", "visible": "tipoEvento", "type": "ENUM" },
        { "action": "RENAME", "old": "terceroId", "new": "thirdPartyId", "visible": "terceroId", "type": "TEXT" },
        { "action": "RENAME", "old": "catalogoId", "new": "catalogId", "visible": "catalogoId", "type": "TEXT" },
        { "action": "KEEP", "field": "pairToken" },
        { "action": "RENAME", "old": "payloadFiscal", "new": "fiscalPayload", "visible": "payloadFiscal", "type": "OBJECT" },
        { "action": "KEEP", "field": "sequenceNumber" },
        { "action": "RENAME", "old": "proyeccionEstado", "new": "projectionStatus", "visible": "proyeccionEstado", "type": "ENUM" },
        { "action": "RENAME", "old": "proyeccionDetalleIds", "new": "projectionDetailIds", "visible": "proyeccionDetalleIds", "type": "ARRAY" },
        { "action": "KEEP", "field": "traceId" },
        { "action": "ADD", "field": "fiscalRole", "type": "ENUM", "values": ["EMISOR","RECEPTOR"] },
        { "action": "ADD", "field": "isB2B", "type": "BOOLEAN" },
        { "action": "ADD", "field": "linkedAdvanceId", "type": "TEXT" },
        { "action": "ADD", "field": "vatAccrualStatus", "type": "TEXT" },
        { "action": "ADD", "field": "bankReconciliationReference", "type": "TEXT" },
        { "action": "ADD", "field": "issuerInvoiceNumber", "type": "TEXT" },
        { "action": "ADD", "field": "correctionReason", "type": "TEXT" },
        { "action": "ADD", "field": "taxTreatment", "type": "TEXT" },
        { "action": "ADD", "field": "lineItems", "type": "ARRAY" },
        { "action": "ADD", "field": "recordSource", "type": "TEXT" }
      ]
    },
    "AsientosContables": {
      "changeCount": 54,
      "changes": [
        { "action": "KEEP", "field": "_id" },
        { "action": "KEEP", "field": "_createdDate" },
        { "action": "KEEP", "field": "_updatedDate" },
        { "action": "KEEP", "field": "_owner" },
        { "action": "KEEP", "field": "journalEntryId" },
        { "action": "KEEP", "field": "sequenceNumber" },
        { "action": "ADD", "field": "fiscalYear", "type": "NUMBER" },
        { "action": "KEEP", "field": "fiscalPeriod" },
        { "action": "KEEP", "field": "operationDate" },
        { "action": "ADD", "field": "registeredAt", "type": "DATETIME" },
        { "action": "ADD", "field": "operationTimeZone", "type": "TEXT" },
        { "action": "ADD", "field": "entryType", "type": "TEXT" },
        { "action": "ADD", "field": "operationCategory", "type": "TEXT" },
        { "action": "ADD", "field": "description", "type": "TEXT" },
        { "action": "ADD", "field": "recordSource", "type": "TEXT" },
        { "action": "ADD", "field": "sourceId", "type": "TEXT" },
        { "action": "KEEP", "field": "transactionId" },
        { "action": "KEEP", "field": "externalReference" },
        { "action": "KEEP", "field": "invoiceNumber" },
        { "action": "ADD", "field": "invoiceIssueDate", "type": "DATE" },
        { "action": "ADD", "field": "fiscalOperationDate", "type": "DATE" },
        { "action": "ADD", "field": "currency", "type": "TEXT" },
        { "action": "KEEP", "field": "totalDocumentAmount" },
        { "action": "ADD", "field": "paymentMethod", "type": "TEXT" },
        { "action": "KEEP", "field": "entryStatus" },
        { "action": "KEEP", "field": "previousHash" },
        { "action": "KEEP", "field": "sourceHash" },
        { "action": "KEEP", "field": "hashOrigen" },
        { "action": "ADD", "field": "recordHash", "type": "TEXT" },
        { "action": "ADD", "field": "previousRecordHash", "type": "TEXT" },
        { "action": "ADD", "field": "schemaVersion", "type": "TEXT" },
        { "action": "ADD", "field": "integrityAlgorithmVersion", "type": "TEXT" },
        { "action": "KEEP", "field": "traceId" },
        { "action": "RENAME", "old": "eventoOrigenId", "new": "sourceEventId", "visible": "eventoOrigenId", "type": "TEXT" },
        { "action": "RENAME", "old": "terceroId", "new": "thirdPartyId", "visible": "terceroId", "type": "TEXT" },
        { "action": "RENAME", "old": "nifTercero", "new": "recipientTaxId", "visible": "nifTercero", "type": "TEXT" },
        { "action": "RENAME", "old": "razonSocialTercero", "new": "recipientLegalName", "visible": "razonSocialTercero", "type": "TEXT" },
        { "action": "RENAME", "old": "numeroSerieFacturaEmisor", "new": "issuerInvoiceNumber", "visible": "numeroSerieFacturaEmisor", "type": "TEXT" },
        { "action": "RENAME", "old": "claveRegistroFactura", "new": "invoiceType", "visible": "claveRegistroFactura", "type": "TEXT" },
        { "action": "RENAME", "old": "baseImponibleRetencion", "new": "withholdingBase", "visible": "baseImponibleRetencion", "type": "NUMBER" },
        { "action": "RENAME", "old": "importeRetencionIRPF", "new": "irpfWithholdingAmount", "visible": "importeRetencionIRPF", "type": "NUMBER" },
        { "action": "RENAME", "old": "importeRecargoEquivalencia", "new": "surchargeAmount", "visible": "importeRecargoEquivalencia", "type": "NUMBER" },
        { "action": "RENAME", "old": "rolFiscal", "new": "fiscalRole", "visible": "rolFiscal", "type": "ENUM" },
        { "action": "RENAME", "old": "motivoRectificacion", "new": "correctionReason", "visible": "motivoRectificacion", "type": "TEXT" },
        { "action": "RENAME", "old": "idFacturaRectificada", "new": "previousInvoiceId", "visible": "idFacturaRectificada", "type": "TEXT" },
        { "action": "RENAME", "old": "datosOrigenAsiento", "new": "sourceData", "visible": "datosOrigenAsiento", "type": "OBJECT" },
        { "action": "ADD", "field": "totalDebit", "type": "NUMBER" },
        { "action": "ADD", "field": "totalCredit", "type": "NUMBER" },
        { "action": "RENAME", "old": "hashAsiento", "new": "entryHash", "visible": "hashAsiento", "type": "TEXT" },
        { "action": "RENAME", "old": "firmaAsiento", "new": "entrySignature", "visible": "firmaAsiento", "type": "TEXT" },
        { "action": "KEEP", "field": "fiscalPayloadSnapshot" },
        { "action": "KEEP", "field": "detailedBreakdown" },
        { "action": "KEEP", "field": "regimeKey" },
        { "action": "KEEP", "field": "operationClassification" },
        { "action": "KEEP", "field": "exemptOperation" },
        { "action": "KEEP", "field": "reverseCharge" },
        { "action": "KEEP", "field": "computerSystem" },
        { "action": "KEEP", "field": "previousInvoiceNumber" },
        { "action": "KEEP", "field": "previousInvoiceIssueDate" }
      ]
    },
    "LibroAsientosContablesDetalle": {
      "changeCount": 44,
      "changes": [
        { "action": "KEEP", "field": "_id" },
        { "action": "KEEP", "field": "_createdDate" },
        { "action": "KEEP", "field": "journalEntryId" },
        { "action": "KEEP", "field": "transactionId" },
        { "action": "KEEP", "field": "lineNumber" },
        { "action": "KEEP", "field": "operationDate" },
        { "action": "KEEP", "field": "accountCode" },
        { "action": "KEEP", "field": "accountName" },
        { "action": "KEEP", "field": "accountGroup" },
        { "action": "KEEP", "field": "debitAmount" },
        { "action": "KEEP", "field": "creditAmount" },
        { "action": "KEEP", "field": "netAmount" },
        { "action": "KEEP", "field": "operationCategory" },
        { "action": "KEEP", "field": "lineDescription" },
        { "action": "KEEP", "field": "externalReference" },
        { "action": "KEEP", "field": "registeredAt" },
        { "action": "KEEP", "field": "traceId" },
        { "action": "KEEP", "field": "lineHash" },
        { "action": "KEEP", "field": "taxableBaseOrNonSubjectAmount" },
        { "action": "KEEP", "field": "taxRate" },
        { "action": "KEEP", "field": "chargedTaxAmount" },
        { "action": "RENAME", "old": "eventoOrigenId", "new": "sourceEventId", "visible": "eventoOrigenId", "type": "TEXT" },
        { "action": "RENAME", "old": "terceroId", "new": "thirdPartyId", "visible": "terceroId", "type": "TEXT" },
        { "action": "RENAME", "old": "catalogoId", "new": "catalogId", "visible": "catalogoId", "type": "TEXT" },
        { "action": "KEEP", "field": "operationDescription" },
        { "action": "KEEP", "field": "units" },
        { "action": "KEEP", "field": "magnitude" },
        { "action": "KEEP", "field": "netUnitAmount" },
        { "action": "KEEP", "field": "taxCode" },
        { "action": "KEEP", "field": "regimeKey" },
        { "action": "KEEP", "field": "operationClassification" },
        { "action": "KEEP", "field": "exemptOperation" },
        { "action": "KEEP", "field": "reverseCharge" },
        { "action": "RENAME", "old": "nifTercero", "new": "recipientTaxId", "visible": "nifTercero", "type": "TEXT" },
        { "action": "RENAME", "old": "razonSocialTercero", "new": "recipientLegalName", "visible": "razonSocialTercero", "type": "TEXT" },
        { "action": "RENAME", "old": "numeroSerieFacturaEmisor", "new": "issuerInvoiceNumber", "visible": "numeroSerieFacturaEmisor", "type": "TEXT" },
        { "action": "RENAME", "old": "claveRegistroFactura", "new": "invoiceType", "visible": "claveRegistroFactura", "type": "TEXT" },
        { "action": "RENAME", "old": "baseImponibleRetencion", "new": "withholdingBase", "visible": "baseImponibleRetencion", "type": "NUMBER" },
        { "action": "RENAME", "old": "importeRetencionIRPF", "new": "irpfWithholdingAmount", "visible": "importeRetencionIRPF", "type": "NUMBER" },
        { "action": "KEEP", "field": "irpfWithholdingRate" },
        { "action": "KEEP", "field": "surchargeRate" },
        { "action": "KEEP", "field": "surchargeAmount" },
        { "action": "RENAME", "old": "rolFiscal", "new": "fiscalRole", "visible": "rolFiscal", "type": "ENUM" },
        { "action": "RENAME", "old": "motivoRectificacion", "new": "correctionReason", "visible": "motivoRectificacion", "type": "TEXT" },
        { "action": "RENAME", "old": "idFacturaRectificada", "new": "previousInvoiceId", "visible": "idFacturaRectificada", "type": "TEXT" }
      ]
    },
    "CitasF2": {
      "changeCount": 25,
      "changes": [
        { "action": "KEEP", "field": "_id" },
        { "action": "KEEP", "field": "_createdDate" },
        { "action": "KEEP", "field": "_updatedDate" },
        { "action": "KEEP", "field": "bookingId" },
        { "action": "KEEP", "field": "pairToken" },
        { "action": "KEEP", "field": "revision" },
        { "action": "KEEP", "field": "serviceId" },
        { "action": "KEEP", "field": "scheduleId" },
        { "action": "KEEP", "field": "resourceId" },
        { "action": "KEEP", "field": "staffResourceId" },
        { "action": "KEEP", "field": "startDate" },
        { "action": "KEEP", "field": "endDate" },
        { "action": "KEEP", "field": "dateYmd" },
        { "action": "KEEP", "field": "bookingType" },
        { "action": "KEEP", "field": "status" },
        { "action": "KEEP", "field": "paymentStatus" },
        { "action": "KEEP", "field": "meta" },
        { "action": "KEEP", "field": "contactDetails" },
        { "action": "RENAME", "old": "terceroId", "new": "thirdPartyId", "visible": "terceroId", "type": "TEXT" },
        { "action": "RENAME", "old": "catalogoId", "new": "catalogId", "visible": "catalogoId", "type": "TEXT" },
        { "action": "RENAME", "old": "eventoOrigenId", "new": "sourceEventId", "visible": "eventoOrigenId", "type": "TEXT" },
        { "action": "RENAME", "old": "datosFiscales", "new": "fiscalData", "visible": "datosFiscales", "type": "OBJECT" },
        { "action": "RENAME", "old": "movimientoCajaId", "new": "cashMovementId", "visible": "movimientoCajaId", "type": "TEXT" },
        { "action": "RENAME", "old": "fechaFacturacion", "new": "invoicingDate", "visible": "fechaFacturacion", "type": "DATE" },
        { "action": "KEEP", "field": "traceId" }
      ]
    },
    "FacturasRecibidas": {
      "changeCount": 46,
      "changes": [
        { "action": "KEEP", "field": "_id" },
        { "action": "KEEP", "field": "_createdDate" },
        { "action": "KEEP", "field": "_updatedDate" },
        { "action": "RENAME", "old": "numeroRecepcion", "new": "receptionNumber", "visible": "numeroRecepcion", "type": "TEXT" },
        { "action": "RENAME", "old": "numSerieFactura", "new": "invoiceNumber", "visible": "numSerieFactura", "type": "TEXT" },
        { "action": "RENAME", "old": "fechaExpedicionFactura", "new": "invoiceIssueDate", "visible": "fechaExpedicionFactura", "type": "DATE" },
        { "action": "RENAME", "old": "fechaOperacion", "new": "operationDate", "visible": "fechaOperacion", "type": "DATE" },
        { "action": "RENAME", "old": "fechaRecepcion", "new": "receptionDate", "visible": "fechaRecepcion", "type": "DATE" },
        { "action": "RENAME", "old": "fechaRegistroContable", "new": "accountingEntryDate", "visible": "fechaRegistroContable", "type": "DATE" },
        { "action": "RENAME", "old": "terceroId", "new": "thirdPartyId", "visible": "terceroId", "type": "TEXT" },
        { "action": "RENAME", "old": "nifEmisor", "new": "issuerTaxId", "visible": "nifEmisor", "type": "TEXT" },
        { "action": "RENAME", "old": "nombreRazonEmisor", "new": "issuerLegalName", "visible": "nombreRazonEmisor", "type": "TEXT" },
        { "action": "RENAME", "old": "nifDestinatario", "new": "recipientTaxId", "visible": "nifDestinatario", "type": "TEXT" },
        { "action": "RENAME", "old": "nombreRazonDestinatario", "new": "recipientLegalName", "visible": "nombreRazonDestinatario", "type": "TEXT" },
        { "action": "RENAME", "old": "tipoFactura", "new": "invoiceType", "visible": "tipoFactura", "type": "ENUM" },
        { "action": "RENAME", "old": "descripcionOperacion", "new": "operationDescription", "visible": "descripcionOperacion", "type": "TEXT" },
        { "action": "RENAME", "old": "importeTotal", "new": "totalAmount", "visible": "importeTotal", "type": "NUMBER" },
        { "action": "RENAME", "old": "baseImponibleTotal", "new": "totalTaxableBase", "visible": "baseImponibleTotal", "type": "NUMBER" },
        { "action": "RENAME", "old": "cuotaIvaTotal", "new": "totalVatAmount", "visible": "cuotaIvaTotal", "type": "NUMBER" },
        { "action": "RENAME", "old": "cuotaRecargoEquivalencia", "new": "surchargeAmount", "visible": "cuotaRecargoEquivalencia", "type": "NUMBER" },
        { "action": "RENAME", "old": "importeRetencionIRPF", "new": "irpfWithholdingAmount", "visible": "importeRetencionIRPF", "type": "NUMBER" },
        { "action": "RENAME", "old": "tipoRetencionIRPF", "new": "irpfWithholdingRate", "visible": "tipoRetencionIRPF", "type": "NUMBER" },
        { "action": "RENAME", "old": "desgloseDetallado", "new": "detailedBreakdown", "visible": "desgloseDetallado", "type": "ARRAY" },
        { "action": "RENAME", "old": "claveRegimen", "new": "regimeKey", "visible": "claveRegimen", "type": "TEXT" },
        { "action": "RENAME", "old": "calificacionOperacion", "new": "operationClassification", "visible": "calificacionOperacion", "type": "TEXT" },
        { "action": "RENAME", "old": "operacionExenta", "new": "exemptOperation", "visible": "operacionExenta", "type": "TEXT" },
        { "action": "RENAME", "old": "inversionSujetoPasivo", "new": "reverseCharge", "visible": "inversionSujetoPasivo", "type": "BOOLEAN" },
        { "action": "RENAME", "old": "regimenEspecial", "new": "specialRegime", "visible": "regimenEspecial", "type": "OBJECT" },
        { "action": "KEEP", "field": "deductible" },
        { "action": "RENAME", "old": "porcentajeDeduccion", "new": "deductionPercentage", "visible": "porcentajeDeduccion", "type": "NUMBER" },
        { "action": "RENAME", "old": "cuotaDeducible", "new": "deductibleAmount", "visible": "cuotaDeducible", "type": "NUMBER" },
        { "action": "RENAME", "old": "estadoPago", "new": "paymentStatus", "visible": "estadoPago", "type": "ENUM" },
        { "action": "RENAME", "old": "fechaPago", "new": "paymentDate", "visible": "fechaPago", "type": "DATE" },
        { "action": "RENAME", "old": "medioPago", "new": "paymentMethod", "visible": "medioPago", "type": "ENUM" },
        { "action": "RENAME", "old": "cuentaContableGasto", "new": "expenseAccountCode", "visible": "cuentaContableGasto", "type": "TEXT" },
        { "action": "RENAME", "old": "cuentaContableIva", "new": "vatAccountCode", "visible": "cuentaContableIva", "type": "TEXT" },
        { "action": "RENAME", "old": "cuentaContableProveedor", "new": "supplierAccountCode", "visible": "cuentaContableProveedor", "type": "TEXT" },
        { "action": "RENAME", "old": "asientoContableId", "new": "accountingEntryId", "visible": "asientoContableId", "type": "TEXT" },
        { "action": "RENAME", "old": "eventoOrigenId", "new": "sourceEventId", "visible": "eventoOrigenId", "type": "TEXT" },
        { "action": "RENAME", "old": "facturaRectificadaId", "new": "correctedInvoiceId", "visible": "facturaRectificadaId", "type": "TEXT" },
        { "action": "RENAME", "old": "motivoRectificacion", "new": "correctionReason", "visible": "motivoRectificacion", "type": "TEXT" },
        { "action": "RENAME", "old": "documentoAdjuntoUrl", "new": "attachmentUrl", "visible": "documentoAdjuntoUrl", "type": "URL" },
        { "action": "RENAME", "old": "archivoHash", "new": "fileHash", "visible": "archivoHash", "type": "TEXT" },
        { "action": "RENAME", "old": "origenRecepcion", "new": "receptionSource", "visible": "origenRecepcion", "type": "ENUM" },
        { "action": "RENAME", "old": "estadoValidacion", "new": "validationStatus", "visible": "estadoValidacion", "type": "ENUM" },
        { "action": "KEEP", "field": "traceId" }
      ]
    },
    "HistoricoCierresZ": {
      "changeCount": 61,
      "changes": [
        { "action": "KEEP", "field": "_id" },
        { "action": "KEEP", "field": "_createdDate" },
        { "action": "KEEP", "field": "operationDate" },
        { "action": "ADD", "field": "closingStatus", "type": "TEXT" },
        { "action": "ADD", "field": "consolidatedTotalAmount", "type": "NUMBER" },
        { "action": "ADD", "field": "grossSalesTotal", "type": "NUMBER" },
        { "action": "ADD", "field": "netTaxableAmount", "type": "NUMBER" },
        { "action": "ADD", "field": "netTaxAmount", "type": "NUMBER" },
        { "action": "ADD", "field": "totalCash", "type": "NUMBER" },
        { "action": "ADD", "field": "totalCard", "type": "NUMBER" },
        { "action": "ADD", "field": "totalBizum", "type": "NUMBER" },
        { "action": "ADD", "field": "totalOnline", "type": "NUMBER" },
        { "action": "ADD", "field": "totalRefunds", "type": "NUMBER" },
        { "action": "ADD", "field": "totalTips", "type": "NUMBER" },
        { "action": "ADD", "field": "totalAdjustments", "type": "NUMBER" },
        { "action": "ADD", "field": "totalOperations", "type": "NUMBER" },
        { "action": "ADD", "field": "startSequence", "type": "NUMBER" },
        { "action": "ADD", "field": "endSequence", "type": "NUMBER" },
        { "action": "ADD", "field": "startTicketNumber", "type": "TEXT" },
        { "action": "ADD", "field": "endTicketNumber", "type": "TEXT" },
        { "action": "ADD", "field": "startRecordHash", "type": "TEXT" },
        { "action": "ADD", "field": "endRecordHash", "type": "TEXT" },
        { "action": "ADD", "field": "movementTypeBreakdown", "type": "OBJECT" },
        { "action": "ADD", "field": "taxTypeBreakdown", "type": "OBJECT" },
        { "action": "ADD", "field": "isIntegrityVerified", "type": "BOOLEAN" },
        { "action": "ADD", "field": "auditedRecordsCount", "type": "NUMBER" },
        { "action": "ADD", "field": "closingHash", "type": "TEXT" },
        { "action": "ADD", "field": "closingSignature", "type": "TEXT" },
        { "action": "ADD", "field": "closingSignatureStatus", "type": "TEXT" },
        { "action": "ADD", "field": "closingSource", "type": "TEXT" },
        { "action": "ADD", "field": "closingSchemaVersion", "type": "TEXT" },
        { "action": "ADD", "field": "timeZone", "type": "TEXT" },
        { "action": "ADD", "field": "closedAt", "type": "DATETIME" },
        { "action": "ADD", "field": "verifiedAt", "type": "DATETIME" },
        { "action": "RENAME", "old": "usuarioAprobador", "new": "approverUser", "visible": "usuarioAprobador", "type": "TEXT" },
        { "action": "RENAME", "old": "saldosPorMetodo", "new": "balancesByMethod", "visible": "saldosPorMetodo", "type": "OBJECT" },
        { "action": "KEEP", "field": "sourceEventId" },
        { "action": "RENAME", "old": "desglosePorRegimen", "new": "breakdownByRegime", "visible": "desglosePorRegimen", "type": "ARRAY" },
        { "action": "RENAME", "old": "desglosePorTipoOperacion", "new": "breakdownByOperationType", "visible": "desglosePorTipoOperacion", "type": "ARRAY" },
        { "action": "RENAME", "old": "desglosePorTipoImpositivo", "new": "breakdownByTaxRate", "visible": "desglosePorTipoImpositivo", "type": "ARRAY" },
        { "action": "RENAME", "old": "resumenVerifactu", "new": "verifactuSummary", "visible": "resumenVerifactu", "type": "OBJECT" },
        { "action": "KEEP", "field": "aeatSubmissionStatus" },
        { "action": "KEEP", "field": "aeatSubmissionDate" },
        { "action": "RENAME", "old": "respuestaAeat", "new": "aeatResponse", "visible": "respuestaAeat", "type": "OBJECT" },
        { "action": "RENAME", "old": "csvAeat", "new": "aeatCsv", "visible": "csvAeat", "type": "TEXT" },
        { "action": "ADD", "field": "traceId", "type": "TEXT" },
        { "action": "ADD", "field": "inventoryClosingId", "type": "TEXT" },
        { "action": "ADD", "field": "fiscalYear", "type": "NUMBER" },
        { "action": "ADD", "field": "closingDate", "type": "DATETIME" },
        { "action": "ADD", "field": "closingType", "type": "ENUM", "values": ["ANUAL","MENSUAL","EXTRAORDINARIO","PAQUETE_GESTORIA"] },
        { "action": "ADD", "field": "sku", "type": "TEXT" },
        { "action": "ADD", "field": "productId", "type": "TEXT" },
        { "action": "ADD", "field": "productDescription", "type": "TEXT" },
        { "action": "ADD", "field": "stockQuantity", "type": "NUMBER" },
        { "action": "ADD", "field": "unitCost", "type": "NUMBER" },
        { "action": "ADD", "field": "stockValue", "type": "NUMBER" },
        { "action": "ADD", "field": "accountCode", "type": "TEXT" },
        { "action": "ADD", "field": "debitBalance", "type": "NUMBER" },
        { "action": "ADD", "field": "creditBalance", "type": "NUMBER" },
        { "action": "ADD", "field": "summaryData", "type": "OBJECT" },
        { "action": "ADD", "field": "invoiceData", "type": "ARRAY" },
        { "action": "ADD", "field": "status", "type": "ENUM", "values": ["PREPARED","SENT"] }
      ]
    },
    "CompensacionesPendientes": {
      "changeCount": 22,
      "changes": [
        { "action": "KEEP", "field": "_id" },
        { "action": "KEEP", "field": "kind" },
        { "action": "KEEP", "field": "status" },
        { "action": "KEEP", "field": "attempts" },
        { "action": "ADD", "field": "id", "type": "TEXT" },
        { "action": "ADD", "field": "bookingId", "type": "TEXT" },
        { "action": "ADD", "field": "bookingIds", "type": "TEXT" },
        { "action": "ADD", "field": "phase", "type": "TEXT" },
        { "action": "ADD", "field": "amount", "type": "NUMBER" },
        { "action": "ADD", "field": "paymentMethod", "type": "TEXT" },
        { "action": "ADD", "field": "transactionId", "type": "TEXT" },
        { "action": "ADD", "field": "orderId", "type": "TEXT" },
        { "action": "ADD", "field": "refundId", "type": "TEXT" },
        { "action": "ADD", "field": "concept", "type": "TEXT" },
        { "action": "ADD", "field": "movementType", "type": "TEXT" },
        { "action": "ADD", "field": "alertRequired", "type": "BOOLEAN" },
        { "action": "ADD", "field": "lastError", "type": "TEXT" },
        { "action": "ADD", "field": "origin", "type": "TEXT" },
        { "action": "KEEP", "field": "errorCode" },
        { "action": "KEEP", "field": "errorMessage" },
        { "action": "RENAME", "old": "eventoOrigenId", "new": "sourceEventId", "visible": "eventoOrigenId", "type": "TEXT" },
        { "action": "RENAME", "old": "terceroId", "new": "thirdPartyId", "visible": "terceroId", "type": "TEXT" },
        { "action": "KEEP", "field": "traceId" }
      ]
    },
    "MovimientosInventario": {
      "changeCount": 23,
      "changes": [
        { "action": "KEEP", "field": "_id" },
        { "action": "ADD", "field": "movementToken", "type": "TEXT" },
        { "action": "ADD", "field": "productName", "type": "TEXT" },
        { "action": "ADD", "field": "quantity", "type": "NUMBER" },
        { "action": "ADD", "field": "quantityDelta", "type": "NUMBER" },
        { "action": "ADD", "field": "stockBefore", "type": "NUMBER" },
        { "action": "ADD", "field": "stockAfter", "type": "NUMBER" },
        { "action": "ADD", "field": "movementType", "type": "TEXT" },
        { "action": "ADD", "field": "reason", "type": "TEXT" },
        { "action": "ADD", "field": "referenceId", "type": "TEXT" },
        { "action": "KEEP", "field": "orderId" },
        { "action": "KEEP", "field": "refundId" },
        { "action": "ADD", "field": "actorEmail", "type": "TEXT" },
        { "action": "ADD", "field": "actorMemberId", "type": "TEXT" },
        { "action": "ADD", "field": "requiresWixReconciliation", "type": "BOOLEAN" },
        { "action": "ADD", "field": "nativeCommercialMovement", "type": "BOOLEAN" },
        { "action": "ADD", "field": "wixProductId", "type": "TEXT" },
        { "action": "ADD", "field": "wixVariantId", "type": "TEXT" },
        { "action": "RENAME", "old": "eventoOrigenId", "new": "sourceEventId", "visible": "eventoOrigenId", "type": "TEXT" },
        { "action": "RENAME", "old": "catalogoId", "new": "catalogId", "visible": "catalogoId", "type": "TEXT" },
        { "action": "RENAME", "old": "magnitud", "new": "magnitude", "visible": "magnitud", "type": "NUMBER" },
        { "action": "RENAME", "old": "terceroId", "new": "thirdPartyId", "visible": "terceroId", "type": "TEXT" },
        { "action": "KEEP", "field": "traceId" }
      ]
    },
    "RegistrosHorariosStaff": {
      "changeCount": 20,
      "changes": [
        { "action": "KEEP", "field": "_id" },
        { "action": "KEEP", "field": "_createdDate" },
        { "action": "KEEP", "field": "resourceId" },
        { "action": "ADD", "field": "displayName", "type": "TEXT" },
        { "action": "ADD", "field": "staffMemberId", "type": "TEXT" },
        { "action": "ADD", "field": "recordedAt", "type": "DATETIME" },
        { "action": "ADD", "field": "recordedTime", "type": "TEXT" },
        { "action": "ADD", "field": "dayKey", "type": "TEXT" },
        { "action": "ADD", "field": "monthKey", "type": "TEXT" },
        { "action": "ADD", "field": "clockEventType", "type": "ENUM", "values": ["ENTRADA","SALIDA","PAUSA_INICIO","PAUSA_FIN","AJUSTE"] },
        { "action": "ADD", "field": "type", "type": "ENUM", "values": ["REGULAR","AJUSTE"] },
        { "action": "ADD", "field": "employeeIdentifier", "type": "TEXT" },
        { "action": "ADD", "field": "employeeName", "type": "TEXT" },
        { "action": "ADD", "field": "registeredBy", "type": "ENUM", "values": ["SELF","ADMIN"] },
        { "action": "ADD", "field": "registeredByMemberId", "type": "TEXT" },
        { "action": "ADD", "field": "recordingName", "type": "TEXT" },
        { "action": "ADD", "field": "adjustmentReason", "type": "TEXT" },
        { "action": "ADD", "field": "deviceIp", "type": "TEXT" },
        { "action": "ADD", "field": "deviceIpAddress", "type": "TEXT" },
        { "action": "ADD", "field": "signature", "type": "TEXT" },
        { "action": "ADD", "field": "meta", "type": "OBJECT" },
        { "action": "ADD", "field": "traceId", "type": "TEXT" }
      ]
    },
    "ConfiguracionFiscal": {
      "changeCount": 10,
      "changes": [
        { "action": "KEEP", "field": "_id" },
        { "action": "RENAME", "old": "sistemaInformatico", "new": "computerSystem", "visible": "sistemaInformatico", "type": "OBJECT" },
        { "action": "RENAME", "old": "nifProductor", "new": "producerTaxId", "visible": "nifProductor", "type": "TEXT" },
        { "action": "RENAME", "old": "nombreRazonProductor", "new": "producerLegalName", "visible": "nombreRazonProductor", "type": "TEXT" },
        { "action": "RENAME", "old": "idSistemaInformatico", "new": "computerSystemId", "visible": "idSistemaInformatico", "type": "TEXT" },
        { "action": "KEEP", "field": "version" },
        { "action": "RENAME", "old": "numeroInstalacion", "new": "installationNumber", "visible": "numeroInstalacion", "type": "TEXT" },
        { "action": "RENAME", "old": "tipoUsoPosibleSoloVerifactu", "new": "possibleUseOnlyVerifactu", "visible": "tipoUsoPosibleSoloVerifactu", "type": "ENUM" },
        { "action": "RENAME", "old": "tipoUsoPosibleMultiOT", "new": "possibleUseMultiOT", "visible": "tipoUsoPosibleMultiOT", "type": "ENUM" },
        { "action": "RENAME", "old": "indicadorMultiplesOT", "new": "multipleOTIndicator", "visible": "indicadorMultiplesOT", "type": "ENUM" },
        { "action": "RENAME", "old": "fechaInicioVerifactu", "new": "verifactuStartDate", "visible": "fechaInicioVerifactu", "type": "DATE" },
        { "action": "ADD", "field": "active", "type": "BOOLEAN" },
        { "action": "ADD", "field": "businessTaxId", "type": "TEXT" }
      ]
    },
    "ProveedoresLista": {
      "changeCount": 1,
      "changes": [
        { "action": "DEPRECATE", "reason": "Datos migrados a DatosFiscales con thirdPartyType=PROVEEDOR" }
      ]
    }
  },
  "constantesJsRenombradas": [
    { "old": "TIPO_FICHAJE", "new": "TIMECLOCK_TYPE" },
    { "old": "TIPO_MOVIMIENTO", "new": "MOVEMENT_TYPE" },
    { "old": "FORMA_PAGO", "new": "PAYMENT_METHOD" },
    { "old": "CAJA_STATUS", "new": "CASH_REGISTER_STATUS" },
    { "old": "ESTADO_CITA", "new": "BOOKING_STATUS" },
    { "old": "ESTADO_PAGO", "new": "PAYMENT_STATUS" },
    { "old": "COLLAB_ROLES", "new": "COLLABORATOR_ROLES" },
    { "old": "SERVICE_CATALOG", "new": "CATALOG_CONFIG" },
    { "old": "CITA_FIELDS", "new": "BOOKING_FIELDS" },
    { "old": "MONEY", "new": "CURRENCY_CONFIG" },
    { "old": "CUENTAS_PGC", "new": "ACCOUNTING_ACCOUNT" },
    { "old": "CLAVES_AEAT", "new": "AEAT_INVOICE_TYPE" },
    { "old": "MOTIVOS_RECTIFICACION", "new": "CORRECTION_REASON" },
    { "old": "TIPOS_RETENCION_IRPF", "new": "IRPF_WITHHOLDING_RATE" },
    { "old": "ESTADO_DEVENGO_IVA", "new": "VAT_ACCRUAL_STATUS" },
    { "old": "ROL_FISCAL", "new": "FISCAL_ROLE" },
    { "old": "TIPO_EVENTO", "new": "EVENT_TYPE" },
    { "old": "NATURALEZA_ITEM", "new": "ITEM_NATURE" },
    { "old": "TIPO_TERCERO", "new": "THIRD_PARTY_TYPE" },
    { "old": "PROYECCION_ESTADO", "new": "PROJECTION_STATUS" },
    { "old": "SISTEMA_INFORMATICO", "new": "COMPUTER_SYSTEM" }
  ],
  "modulosRefactorizados": [
    { "module": "backend/internalConfig.js", "status": "GREEN", "renames": 21, "aliases": 21 },
    { "module": "backend/eventLog.js", "status": "GREEN", "renames": 135 },
    { "module": "backend/cajas.web.js", "status": "GREEN", "renames": 50 },
    { "module": "backend/events.js", "status": "GREEN", "renames": 140 },
    { "module": "backend/data.js", "status": "GREEN", "renames": 50 },
    { "module": "backend/contabilidad.js", "status": "GREEN", "renames": 45 },
    { "module": "backend/booking/bookingCore.js", "status": "GREEN", "renames": 0 },
    { "module": "backend/booking/bookingSaga.js", "status": "GREEN", "renames": 8 },
    { "module": "backend/booking/bookingUtils.js", "status": "GREEN", "renames": 0 },
    { "module": "backend/citasManager.web.js", "status": "GREEN", "renames": 8 },
    { "module": "backend/reservas.web.js", "status": "GREEN", "renames": 1 },
    { "module": "backend/bookingServiceSync.js", "status": "GREEN", "renames": 0 },
    { "module": "backend/crons.js", "status": "GREEN", "renames": 0 },
    { "module": "backend/inventario.web.js", "status": "GREEN", "renames": 4 },
    { "module": "backend/security.js", "status": "GREEN", "renames": 1 },
    { "module": "backend/security.web.js", "status": "GREEN", "renames": 0 },
    { "module": "backend/m365GraphSync.js", "status": "GREEN", "renames": 0 },
    { "module": "backend/marianAssistant.web.js", "status": "GREEN", "renames": 0 },
    { "module": "backend/mmSecrets.js", "status": "GREEN", "renames": 0 },
    { "module": "backend/staff.js", "status": "GREEN", "renames": 0 },
    { "module": "backend/audit.js", "status": "GREEN", "renames": 0 },
    { "module": "backend/fiscalAggregator.web.js", "status": "GREEN", "renames": 10 },
    { "module": "backend/fiscalDocuments.web.js", "status": "GREEN", "renames": 0 },
    { "module": "backend/horario.web.js", "status": "GREEN", "renames": 7 },
    { "module": "backend/http-functions.js", "status": "GREEN", "renames": 0 },
    { "module": "backend/securityEngine.js", "status": "GREEN", "renames": 0 },
    { "module": "backend/responseUtils.js", "status": "GREEN", "renames": 0 },
    { "module": "public/qrHelper.js", "status": "GREEN", "renames": 8 },
    { "module": "public/mmUtils.js", "status": "GREEN", "renames": 0 },
    { "module": "public/widgetBridge.js", "status": "GREEN", "renames": 0 },
    { "module": "public/marianAdministrationController.js", "status": "GREEN", "renames": 0 },
    { "module": "pages/calendario-2.js", "status": "GREEN", "renames": 0 },
    { "module": "pages/servicio-2.js", "status": "GREEN", "renames": 0 }
  ],
  "modulosPendientes": []
}
```

---

## Resumen final

| Métrica | Valor |
|---|---:|
| Colecciones | 15 |
| Cambios totales | 378 |
| Renombrados | 178 |
| Campos añadidos | 172 |
| Campos eliminados | 10 |
| Sin cambio (KEEP) | 18 |
| Deprecados | 1 |
| Constantes JS renombradas | 21 |
| Módulos refactorizados | 33 |
| Módulos pendientes | 0 |

**Estado del refactor:** 100% completado. Ambos artefactos listos para aplicar.



# Matriz de correspondencia de IDs nativas — v5009 → v5009-V20

**Uso:** refactor mecánico. Columna `old` es el ID nativa vigente en el código backend actual. Columna `new` es el ID nativa con la directriz V20 (inglés camelCase). Columna `visible` es el nombre en español que se muestra en CMS/UI.

**Leyenda tipo:** `SYS` = system auto · `TXT` = Text · `NUM` = Number · `BOOL` = Boolean · `DATE` = Date · `DT` = DateTime · `OBJ` = Object · `ARR` = Array · `URL` = URL · `ENUM` = Text con valores fijos.

---

## 1. `DatosFiscales`

| # | old (español) | new (inglés V20) | visible (español) | tipo |
|---|---|---|---|---|
| 1 | `_id` | `_id` | id | SYS |
| 2 | `_createdDate` | `_createdDate` | fechaCreacion | SYS |
| 3 | `_updatedDate` | `_updatedDate` | fechaActualizacion | SYS |
| 4 | `_owner` | `_owner` | propietario | SYS |
| 5 | `nifCif` | `taxId` | nifCif | TXT |
| 6 | `razonSocial` | `legalName` | razonSocial | TXT |
| 7 | `tipoTercero` | `thirdPartyType` | tipoTercero | ENUM |
| 8 | `datosContacto` | `contactData` | datosContacto | OBJ |
| 9 | `regimenesEspeciales` | `specialRegimes` | regimenesEspeciales | OBJ |
| 10 | `esMinoristaRecargoEquivalencia` | `isRetailerEquivalenceSurcharge` | esMinoristaRecargoEquivalencia | BOOL |
| 11 | `esEmpresarioProfesional` | `isBusinessProfessional` | esEmpresarioProfesional | BOOL |
| 12 | `resourceIdBookings` | `bookingsResourceId` | recursoIdReservas | TXT |
| 13 | `staffMemberId` | `staffMemberId` | personalMiembroId | TXT |
| 14 | `esProveedorHabitual` | `isRegularSupplier` | esProveedorHabitual | BOOL |
| 15 | `condicionesPago` | `paymentTerms` | condicionesPago | OBJ |
| 16 | `activo` | `active` | activo | BOOL |
| 17 | `traceIdAlta` | `registrationTraceId` | trazaIdAlta | TXT |
| 18 | `sistemaInformatico` | `computerSystem` | sistemaInformatico | OBJ |
| 19 | `nifProductor` | `producerTaxId` | nifProductor | TXT |
| 20 | `nombreRazonProductor` | `producerLegalName` | nombreRazonProductor | TXT |
| 21 | `idSistemaInformatico` | `computerSystemId` | idSistemaInformatico | TXT |
| 22 | `version` | `version` | version | TXT |
| 23 | `numeroInstalacion` | `installationNumber` | numeroInstalacion | TXT |
| 24 | `tipoUsoPosibleSoloVerifactu` | `possibleUseOnlyVerifactu` | tipoUsoPosibleSoloVerifactu | ENUM |
| 25 | `tipoUsoPosibleMultiOT` | `possibleUseMultiOT` | tipoUsoPosibleMultiOT | ENUM |
| 26 | `indicadorMultiplesOT` | `multipleOTIndicator` | indicadorMultiplesOT | ENUM |
| 27 | `fechaInicioVerifactu` | `verifactuStartDate` | fechaInicioVerifactu | DATE |

---

## 2. `MapaStaff`

| # | old | new | visible | tipo |
|---|---|---|---|---|
| 1 | `_id` | `_id` | id | SYS |
| 2 | `staffMemberId` | `staffMemberId` | personalMiembroId | TXT |
| 3 | `resourceId` | `resourceId` | recursoId | TXT |
| 4 | `nombre` | `name` | nombre | TXT |
| 5 | `terceroId` | `thirdPartyId` | terceroId | TXT |

---

## 3. `ServiciosCatalogo`

| # | old | new | visible | tipo |
|---|---|---|---|---|
| 1 | `_id` | `_id` | id | SYS |
| 2 | `_createdDate` | `_createdDate` | fechaCreacion | SYS |
| 3 | `_updatedDate` | `_updatedDate` | fechaActualizacion | SYS |
| 4 | `_owner` | `_owner` | propietario | SYS |
| 5 | `serviceId` | `serviceId` | servicioId | TXT |
| 6 | `slugUrl` | `slugUrl` | slugUrl | TXT |
| 7 | `title` | `title` | titulo | TXT |
| 8 | `price` | `price` | precio | NUM |
| 9 | `currency` | `currency` | moneda | TXT |
| 10 | `sku` | `sku` | sku | TXT |
| 11 | `allowCombine` | `allowCombine` | permitirCombinar | BOOL |
| 12 | `linkedPhases` | `linkedPhases` | enlazadaFases | TXT |
| 13 | `phase1Duration` | `phase1Duration` | fase1Duracion | NUM |
| 14 | `phase2Duration` | `phase2Duration` | fase2Duracion | NUM |
| 15 | `exposureDuration` | `exposureDuration` | exposicionDuracion | NUM |
| 16 | `totalDuration` | `totalDuration` | totalDuracion | NUM |
| 17 | `durationRange` | `durationRange` | duracionRango | OBJ |
| 18 | `availableStaff` | `availableStaff` | disponiblePersonal | TXT |
| 19 | `addOnOptions` | `addOnOptions` | complementoOpciones | ARR |
| 20 | `hidden` | `hidden` | oculto | BOOL |
| 21 | `taxIncluded` | `taxIncluded` | impuestoIncluido | BOOL |
| 22 | `taxRate` | `taxRate` | impuestoTasa | NUM |
| 23 | `naturalezaItem` | `itemNature` | naturalezaItem | ENUM |
| 24 | `codigoImpuesto` | `taxCode` | codigoImpuesto | ENUM |
| 25 | `claveRegimenAEAT` | `aeatRegimeKey` | claveRegimenAEAT | ENUM |
| 26 | `calificacionOperacionAEAT` | `aeatOperationClassification` | calificacionOperacionAEAT | ENUM |
| 27 | `operacionExentaAEAT` | `aeatExemptOperation` | operacionExentaAEAT | ENUM |
| 28 | `inversionSujetoPasivo` | `reverseCharge` | inversionSujetoPasivo | BOOL |
| 29 | `cuentaContableIngreso` | `incomeAccountCode` | cuentaContableIngreso | TXT |
| 30 | `cuentaContableGasto` | `expenseAccountCode` | cuentaContableGasto | TXT |
| 31 | `activo` | `active` | activo | BOOL |

---

## 4. `ComplementosCatalogo`

| # | old | new | visible | tipo |
|---|---|---|---|---|
| 1 | `_id` | `_id` | id | SYS |
| 2 | `codigoImpuesto` | `taxCode` | codigoImpuesto | ENUM |
| 3 | `claveRegimenAEAT` | `aeatRegimeKey` | claveRegimenAEAT | TXT |
| 4 | `cuentaContableIngreso` | `incomeAccountCode` | cuentaContableIngreso | TXT |
| 5 | `naturalezaItem` | `itemNature` | naturalezaItem | ENUM |

---

## 5. `MovimientosCaja`

| # | old | new | visible | tipo |
|---|---|---|---|---|
| 1 | `_id` | `_id` | id | SYS |
| 2 | `_createdDate` | `_createdDate` | fechaCreacion | SYS |
| 3 | `_updatedDate` | `_updatedDate` | fechaActualizacion | SYS |
| 4 | `_owner` | `_owner` | propietario | SYS |
| 5 | `amount` | `amount` | importeTotalLegacy | NUM |
| 6 | `importeTotal` | `totalAmount` | importeTotal | NUM |
| 7 | `paymentMethod` | `paymentMethod` | medioCobro | ENUM |
| 8 | `tipoMovimiento` | `movementType` | tipoMovimiento | ENUM |
| 9 | `concept` | `concept` | descripcionOperacionLegacy | TXT |
| 10 | `descripcionOperacion` | `operationDescription` | descripcionOperacion | TXT |
| 11 | `resourceId` | `resourceId` | recursoId | TXT |
| 12 | `staffResourceId` | `staffResourceId` | personalRecursoId | TXT |
| 13 | `channelType` | `channelType` | canalTipo | ENUM |
| 14 | `reservaIdVinculada` | `linkedBookingIds` | reservaIdVinculada | TXT |
| 15 | `transactionId` | `transactionId` | transaccionId | TXT |
| 16 | `orderId` | `orderId` | pedidoId | TXT |
| 17 | `schemaVersion` | `schemaVersion` | esquemaVersion | TXT |
| 18 | `hash` | `hash` | huellaLegacy | TXT |
| 19 | `huella` | `recordHash` | huella | TXT |
| 20 | `prevHash` | `prevHash` | huellaAnteriorLegacy | TXT |
| 21 | `huellaAnterior` | `previousRecordHash` | huellaAnterior | TXT |
| 22 | `registeredAt` | `registeredAt` | fechaHoraHusoGenRegistroLegacy | DT |
| 23 | `fechaHoraHusoGenRegistro` | `recordTimestamp` | fechaHoraHusoGenRegistro | TXT |
| 24 | `generationTimestamp` | `generationTimestamp` | generationTimestamp | OBJ |
| 25 | `numSerieFactura` | `invoiceNumber` | numSerieFactura | TXT |
| 26 | `fechaExpedicionFactura` | `invoiceIssueDate` | fechaExpedicionFactura | DATE |
| 27 | `fechaOperacion` | `operationDate` | fechaOperacion | DATE |
| 28 | `tipoFactura` | `invoiceType` | tipoFactura | ENUM |
| 29 | `tipoRectificativa` | `correctionType` | tipoRectificativa | ENUM |
| 30 | `importeRectificacion` | `correctionAmount` | importeRectificacion | OBJ |
| 31 | `baseImponibleOImporteNoSujeto` | `taxableBaseOrNonSubjectAmount` | baseImponibleOImporteNoSujeto | NUM |
| 32 | `cuotaTotal` | `taxAmount` | cuotaTotal | NUM |
| 33 | `tipoImpositivo` | `taxRate` | tipoImpositivo | NUM |
| 34 | `tipoRecargoEquivalencia` | `surchargeRate` | tipoRecargoEquivalencia | NUM |
| 35 | `cuotaRecargoEquivalencia` | `surchargeAmount` | cuotaRecargoEquivalencia | NUM |
| 36 | `importeRetencionIRPF` | `irpfWithholdingAmount` | importeRetencionIRPF | NUM |
| 37 | `tipoRetencionIRPF` | `irpfWithholdingRate` | tipoRetencionIRPF | NUM |
| 38 | `baseImponibleRetencion` | `withholdingBase` | baseImponibleRetencion | NUM |
| 39 | `nifEmisor` | `issuerTaxId` | nifEmisor | TXT |
| 40 | `nombreRazonEmisor` | `issuerLegalName` | nombreRazonEmisor | TXT |
| 41 | `nifDestinatario` | `recipientTaxId` | nifDestinatario | TXT |
| 42 | `nombreRazonDestinatario` | `recipientLegalName` | nombreRazonDestinatario | TXT |
| 43 | `domicilioDestinatario` | `recipientAddress` | domicilioDestinatario | OBJ |
| 44 | `emitidaPorTerceroODestinatario` | `issuedByThirdPartyOrRecipient` | emitidaPorTerceroODestinatario | ENUM |
| 45 | `nombreRazonTercero` | `thirdPartyLegalName` | nombreRazonTercero | TXT |
| 46 | `nifTerceroExpedidor` | `issuerThirdPartyTaxId` | nifTerceroExpedidor | TXT |
| 47 | `causaNoSujeta` | `nonSubjectReason` | causaNoSujeta | ENUM |
| 48 | `inversionSujetoPasivo` | `reverseCharge` | inversionSujetoPasivo | BOOL |
| 49 | `claveRegimen` | `regimeKey` | claveRegimen | ENUM |
| 50 | `calificacionOperacion` | `operationClassification` | calificacionOperacion | ENUM |
| 51 | `operacionExenta` | `exemptOperation` | operacionExenta | ENUM |
| 52 | `regimenEspecialCriterioCaja` | `cashBasisRegime` | regimenEspecialCriterioCaja | BOOL |
| 53 | `exentaPorArticulo20` | `article20Exempt` | exentaPorArticulo20 | BOOL |
| 54 | `desgloseDetallado` | `detailedBreakdown` | desgloseDetallado | ARR |
| 55 | `sistemaInformatico` | `computerSystem` | sistemaInformatico | OBJ |
| 56 | `idFacturaAnterior` | `previousInvoiceId` | idFacturaAnterior | TXT |
| 57 | `numSerieFacturaAnterior` | `previousInvoiceNumber` | numSerieFacturaAnterior | TXT |
| 58 | `fechaExpedicionFacturaAnterior` | `previousInvoiceIssueDate` | fechaExpedicionFacturaAnterior | DATE |
| 59 | `estadoEnvioAeat` | `aeatSubmissionStatus` | estadoEnvioAeat | ENUM |
| 60 | `csvAeat` | `aeatCsv` | csvAeat | TXT |
| 61 | `fechaEnvioAeat` | `aeatSubmissionDate` | fechaEnvioAeat | DATE |
| 62 | `tipoEvento` | `eventType` | tipoEvento | ENUM |
| 63 | `terceroId` | `thirdPartyId` | terceroId | TXT |
| 64 | `catalogoId` | `catalogId` | catalogoId | TXT |
| 65 | `pairToken` | `pairToken` | parToken | TXT |
| 66 | `payloadFiscal` | `fiscalPayload` | payloadFiscal | OBJ |
| 67 | `sequenceNumber` | `sequenceNumber` | secuenciaNumerica | NUM |
| 68 | `proyeccionEstado` | `projectionStatus` | proyeccionEstado | ENUM |
| 69 | `proyeccionDetalleIds` | `projectionDetailIds` | proyeccionDetalleIds | ARR |
| 70 | `traceId` | `traceId` | trazaId | TXT |

---

## 6. `LibroAsientosContablesDetalle`

| # | old | new | visible | tipo |
|---|---|---|---|---|
| 1 | `_id` | `_id` | id | SYS |
| 2 | `_createdDate` | `_createdDate` | fechaCreacion | SYS |
| 3 | `lineHash` | `lineHash` | lineaHuella | TXT |
| 4 | `baseImponibleOImporteNoSujeto` | `taxableBaseOrNonSubjectAmount` | baseImponibleOImporteNoSujeto | NUM |
| 5 | `tipoImpositivo` | `taxRate` | tipoImpositivo | NUM |
| 6 | `cuotaRepercutida` | `chargedTaxAmount` | cuotaRepercutida | NUM |
| 7 | `eventoOrigenId` | `sourceEventId` | eventoOrigenId | TXT |
| 8 | `numeroLinea` | `lineNumber` | numeroLinea | NUM |
| 9 | `terceroId` | `thirdPartyId` | terceroId | TXT |
| 10 | `catalogoId` | `catalogId` | catalogoId | TXT |
| 11 | `descripcionOperacion` | `operationDescription` | descripcionOperacion | TXT |
| 12 | `unidades` | `units` | unidades | NUM |
| 13 | `magnitud` | `magnitude` | magnitud | NUM |
| 14 | `importeNetoUnitario` | `netUnitAmount` | importeNetoUnitario | NUM |
| 15 | `codigoImpuesto` | `taxCode` | codigoImpuesto | ENUM |
| 16 | `claveRegimen` | `regimeKey` | claveRegimen | ENUM |
| 17 | `calificacionOperacion` | `operationClassification` | calificacionOperacion | ENUM |
| 18 | `operacionExenta` | `exemptOperation` | operacionExenta | ENUM |
| 19 | `inversionSujetoPasivo` | `reverseCharge` | inversionSujetoPasivo | BOOL |
| 20 | `cuentaContable` | `accountCode` | cuentaContable | TXT |
| 21 | `tipoRecargoEquivalencia` | `surchargeRate` | tipoRecargoEquivalencia | NUM |
| 22 | `cuotaRecargoEquivalencia` | `surchargeAmount` | cuotaRecargoEquivalencia | NUM |
| 23 | `importeRetencionIRPF` | `irpfWithholdingAmount` | importeRetencionIRPF | NUM |
| 24 | `tipoRetencionIRPF` | `irpfWithholdingRate` | tipoRetencionIRPF | NUM |

---

## 7. `AsientosContables`

| # | old | new | visible | tipo |
|---|---|---|---|---|
| 1 | `_id` | `_id` | id | SYS |
| 2 | `_createdDate` | `_createdDate` | fechaCreacion | SYS |
| 3 | `_updatedDate` | `_updatedDate` | fechaActualizacion | SYS |
| 4 | `_owner` | `_owner` | propietario | SYS |
| 5 | `sequenceNumber` | `sequenceNumber` | secuenciaNumerica | NUM |
| 6 | `operationDate` | `operationDate` | fechaOperacion | DATE |
| 7 | `fiscalPeriod` | `fiscalPeriod` | periodoFiscal | TXT |
| 8 | `entryStatus` | `entryStatus` | estadoAsiento | ENUM |
| 9 | `journalEntryId` | `journalEntryId` | idAsientoDiario | TXT |
| 10 | `previousHash` | `previousHash` | huellaAnteriorLegacy | TXT |
| 11 | `hashOrigen` | `sourceHash` | huellaOrigen | TXT |
| 12 | `invoiceNumber` | `invoiceNumber` | numSerieFactura | TXT |
| 13 | `totalDocumentAmount` | `totalDocumentAmount` | importeTotalDocumento | NUM |
| 14 | `eventoOrigenId` | `sourceEventId` | eventoOrigenId | TXT |
| 15 | `terceroId` | `thirdPartyId` | terceroId | TXT |
| 16 | `payloadFiscalSnapshot` | `fiscalPayloadSnapshot` | payloadFiscalSnapshot | OBJ |
| 17 | `desgloseDetallado` | `detailedBreakdown` | desgloseDetallado | ARR |
| 18 | `claveRegimen` | `regimeKey` | claveRegimen | TXT |
| 19 | `calificacionOperacion` | `operationClassification` | calificacionOperacion | TXT |
| 20 | `operacionExenta` | `exemptOperation` | operacionExenta | TXT |
| 21 | `inversionSujetoPasivo` | `reverseCharge` | inversionSujetoPasivo | BOOL |
| 22 | `sistemaInformatico` | `computerSystem` | sistemaInformatico | OBJ |
| 23 | `huella` | `recordHash` | huella | TXT |
| 24 | `huellaAnterior` | `previousRecordHash` | huellaAnterior | TXT |
| 25 | `idFacturaAnterior` | `previousInvoiceId` | idFacturaAnterior | TXT |
| 26 | `numSerieFacturaAnterior` | `previousInvoiceNumber` | numSerieFacturaAnterior | TXT |
| 27 | `fechaExpedicionFacturaAnterior` | `previousInvoiceIssueDate` | fechaExpedicionFacturaAnterior | DATE |

**Eliminados:** `sourceHash` (= `hashOrigen` → `sourceHash`), `externalReference` (= `invoiceNumber`).

---

## 8. `HistoricoCierresZ`

| # | old | new | visible | tipo |
|---|---|---|---|---|
| 1 | `_id` | `_id` | id | SYS |
| 2 | `_createdDate` | `_createdDate` | fechaCreacion | SYS |
| 3 | `operationDate` | `operationDate` | fechaOperacion | DATE |
| 4 | `saldosPorMetodo` | `balancesByMethod` | saldosPorMetodo | OBJ |
| 5 | `eventoOrigenId` | `sourceEventId` | eventoOrigenId | TXT |
| 6 | `desglosePorRegimen` | `breakdownByRegime` | desglosePorRegimen | ARR |
| 7 | `desglosePorTipoOperacion` | `breakdownByOperationType` | desglosePorTipoOperacion | ARR |
| 8 | `desglosePorTipoImpositivo` | `breakdownByTaxRate` | desglosePorTipoImpositivo | ARR |
| 9 | `resumenVerifactu` | `verifactuSummary` | resumenVerifactu | OBJ |
| 10 | `estadoEnvioAeat` | `aeatSubmissionStatus` | estadoEnvioAeat | ENUM |
| 11 | `fechaEnvioAeat` | `aeatSubmissionDate` | fechaEnvioAeat | DATE |
| 12 | `respuestaAeat` | `aeatResponse` | respuestaAeat | OBJ |
| 13 | `csvAeat` | `aeatCsv` | csvAeat | TXT |

---

## 9. `FacturasRecibidas`

| # | old | new | visible | tipo |
|---|---|---|---|---|
| 1 | `_id` | `_id` | id | SYS |
| 2 | `_createdDate` | `_createdDate` | fechaCreacion | SYS |
| 3 | `_updatedDate` | `_updatedDate` | fechaActualizacion | SYS |
| 4 | `numeroRecepcion` | `receptionNumber` | numeroRecepcion | TXT |
| 5 | `numSerieFactura` | `invoiceNumber` | numSerieFactura | TXT |
| 6 | `fechaExpedicionFactura` | `invoiceIssueDate` | fechaExpedicionFactura | DATE |
| 7 | `fechaOperacion` | `operationDate` | fechaOperacion | DATE |
| 8 | `fechaRecepcion` | `receptionDate` | fechaRecepcion | DATE |
| 9 | `fechaRegistroContable` | `accountingEntryDate` | fechaRegistroContable | DATE |
| 10 | `terceroId` | `thirdPartyId` | terceroId | TXT |
| 11 | `nifEmisor` | `issuerTaxId` | nifEmisor | TXT |
| 12 | `nombreRazonEmisor` | `issuerLegalName` | nombreRazonEmisor | TXT |
| 13 | `nifDestinatario` | `recipientTaxId` | nifDestinatario | TXT |
| 14 | `nombreRazonDestinatario` | `recipientLegalName` | nombreRazonDestinatario | TXT |
| 15 | `tipoFactura` | `invoiceType` | tipoFactura | ENUM |
| 16 | `descripcionOperacion` | `operationDescription` | descripcionOperacion | TXT |
| 17 | `importeTotal` | `totalAmount` | importeTotal | NUM |
| 18 | `baseImponibleTotal` | `totalTaxableBase` | baseImponibleTotal | NUM |
| 19 | `cuotaIvaTotal` | `totalVatAmount` | cuotaIvaTotal | NUM |
| 20 | `cuotaRecargoEquivalencia` | `surchargeAmount` | cuotaRecargoEquivalencia | NUM |
| 21 | `importeRetencionIRPF` | `irpfWithholdingAmount` | importeRetencionIRPF | NUM |
| 22 | `tipoRetencionIRPF` | `irpfWithholdingRate` | tipoRetencionIRPF | NUM |
| 23 | `desgloseDetallado` | `detailedBreakdown` | desgloseDetallado | ARR |
| 24 | `claveRegimen` | `regimeKey` | claveRegimen | TXT |
| 25 | `calificacionOperacion` | `operationClassification` | calificacionOperacion | TXT |
| 26 | `operacionExenta` | `exemptOperation` | operacionExenta | TXT |
| 27 | `inversionSujetoPasivo` | `reverseCharge` | inversionSujetoPasivo | BOOL |
| 28 | `regimenEspecial` | `specialRegime` | regimenEspecial | OBJ |
| 29 | `deducible` | `deductible` | deducible | BOOL |
| 30 | `porcentajeDeduccion` | `deductionPercentage` | porcentajeDeduccion | NUM |
| 31 | `cuotaDeducible` | `deductibleAmount` | cuotaDeducible | NUM |
| 32 | `estadoPago` | `paymentStatus` | estadoPago | ENUM |
| 33 | `fechaPago` | `paymentDate` | fechaPago | DATE |
| 34 | `medioPago` | `paymentMethod` | medioPago | ENUM |
| 35 | `cuentaContableGasto` | `expenseAccountCode` | cuentaContableGasto | TXT |
| 36 | `cuentaContableIva` | `vatAccountCode` | cuentaContableIva | TXT |
| 37 | `cuentaContableProveedor` | `supplierAccountCode` | cuentaContableProveedor | TXT |
| 38 | `asientoContableId` | `accountingEntryId` | asientoContableId | TXT |
| 39 | `eventoOrigenId` | `sourceEventId` | eventoOrigenId | TXT |
| 40 | `facturaRectificadaId` | `correctedInvoiceId` | facturaRectificadaId | TXT |
| 41 | `motivoRectificacion` | `correctionReason` | motivoRectificacion | TXT |
| 42 | `documentoAdjuntoUrl` | `attachmentUrl` | documentoAdjuntoUrl | URL |
| 43 | `archivoHash` | `fileHash` | archivoHash | TXT |
| 44 | `origenRecepcion` | `receptionSource` | origenRecepcion | ENUM |
| 45 | `estadoValidacion` | `validationStatus` | estadoValidacion | ENUM |
| 46 | `traceId` | `traceId` | trazaId | TXT |

---

## 10. `CitasF2`

| # | old | new | visible | tipo |
|---|---|---|---|---|
| 1 | `_id` | `_id` | id | SYS |
| 2 | `_createdDate` | `_createdDate` | fechaCreacion | SYS |
| 3 | `_updatedDate` | `_updatedDate` | fechaActualizacion | SYS |
| 4 | `bookingId` | `bookingId` | reservaId | TXT |
| 5 | `pairToken` | `pairToken` | parToken | TXT |
| 6 | `revision` | `revision` | revision | NUM |
| 7 | `serviceId` | `serviceId` | servicioId | TXT |
| 8 | `scheduleId` | `scheduleId` | horarioId | TXT |
| 9 | `resourceId` | `resourceId` | recursoId | TXT |
| 10 | `staffResourceId` | `staffResourceId` | personalRecursoId | TXT |
| 11 | `startDate` | `startDate` | inicioFecha | DT |
| 12 | `endDate` | `endDate` | finFecha | DT |
| 13 | `dateYmd` | `dateYmd` | fechaYmd | TXT |
| 14 | `bookingType` | `bookingType` | reservaTipo | ENUM |
| 15 | `status` | `status` | estado | ENUM |
| 16 | `paymentStatus` | `paymentStatus` | pagoEstado | ENUM |
| 17 | `meta` | `meta` | meta | OBJ |
| 18 | `contactDetails` | `contactDetails` | contactoDetalles | OBJ |
| 19 | `terceroId` | `thirdPartyId` | terceroId | TXT |
| 20 | `catalogoId` | `catalogId` | catalogoId | TXT |
| 21 | `eventoOrigenId` | `sourceEventId` | eventoOrigenId | TXT |
| 22 | `datosFiscales` | `fiscalData` | datosFiscales | OBJ |
| 23 | `movimientoCajaId` | `cashMovementId` | movimientoCajaId | TXT |
| 24 | `fechaFacturacion` | `invoicingDate` | fechaFacturacion | DATE |
| 25 | `traceId` | `traceId` | trazaId | TXT |

---

## 11. `MovimientosInventario`

| # | old | new | visible | tipo |
|---|---|---|---|---|
| 1 | `_id` | `_id` | id | SYS |
| 2 | `wixProductId` | `wixProductId` | wixProductoId | TXT |
| 3 | `sku` | `sku` | sku | TXT |
| 4 | `orderId` | `orderId` | pedidoId | TXT |
| 5 | `refundId` | `refundId` | reembolsoId | TXT |
| 6 | `eventoOrigenId` | `sourceEventId` | eventoOrigenId | TXT |
| 7 | `catalogoId` | `catalogId` | catalogoId | TXT |
| 8 | `magnitud` | `magnitude` | magnitud | NUM |
| 9 | `terceroId` | `thirdPartyId` | terceroId | TXT |
| 10 | `traceId` | `traceId` | trazaId | TXT |

---

## 12. `RegistrosHorariosStaff`

| # | old | new | visible | tipo |
|---|---|---|---|---|
| 1 | `_id` | `_id` | id | SYS |
| 2 | `resourceId` | `resourceId` | recursoId | TXT |
| 3 | `fecha` | `date` | fecha | DATE |
| 4 | `horas` | `hours` | horas | NUM |
| 5 | `eventoOrigenId` | `sourceEventId` | eventoOrigenId | TXT |
| 6 | `terceroId` | `thirdPartyId` | terceroId | TXT |
| 7 | `traceId` | `traceId` | trazaId | TXT |

---

## 13. `CompensacionesPendientes`

| # | old | new | visible | tipo |
|---|---|---|---|---|
| 1 | `_id` | `_id` | id | SYS |
| 2 | `kind` | `kind` | tipo | ENUM |
| 3 | `status` | `status` | estado | ENUM |
| 4 | `attempts` | `attempts` | intentos | NUM |
| 5 | `errorCode` | `errorCode` | errorCodigo | TXT |
| 6 | `errorMessage` | `errorMessage` | errorMensaje | TXT |
| 7 | `eventoOrigenId` | `sourceEventId` | eventoOrigenId | TXT |
| 8 | `terceroId` | `thirdPartyId` | terceroId | TXT |
| 9 | `traceId` | `traceId` | trazaId | TXT |

---

## 14. `ConfiguracionFiscal`

| # | old | new | visible | tipo |
|---|---|---|---|---|
| 1 | `_id` | `_id` | id | SYS |
| 2 | `sistemaInformatico` | `computerSystem` | sistemaInformatico | OBJ |
| 3 | `nifProductor` | `producerTaxId` | nifProductor | TXT |
| 4 | `nombreRazonProductor` | `producerLegalName` | nombreRazonProductor | TXT |
| 5 | `idSistemaInformatico` | `computerSystemId` | idSistemaInformatico | TXT |
| 6 | `version` | `version` | version | TXT |
| 7 | `numeroInstalacion` | `installationNumber` | numeroInstalacion | TXT |
| 8 | `tipoUsoPosibleSoloVerifactu` | `possibleUseOnlyVerifactu` | tipoUsoPosibleSoloVerifactu | ENUM |
| 9 | `tipoUsoPosibleMultiOT` | `possibleUseMultiOT` | tipoUsoPosibleMultiOT | ENUM |
| 10 | `indicadorMultiplesOT` | `multipleOTIndicator` | indicadorMultiplesOT | ENUM |
| 11 | `fechaInicioVerifactu` | `verifactuStartDate` | fechaInicioVerifactu | DATE |

---

## Resumen cuantitativo

| Colección | Total campos | Renombrados old→new | Sin cambio |
|---|---:|---:|---:|
| `DatosFiscales` | 27 | 22 | 5 |
| `MapaStaff` | 5 | 2 | 3 |
| `ServiciosCatalogo` | 31 | 12 | 19 |
| `ComplementosCatalogo` | 5 | 4 | 1 |
| `MovimientosCaja` | 70 | 45 | 25 |
| `LibroAsientosContablesDetalle` | 24 | 17 | 7 |
| `AsientosContables` | 27 | 13 | 14 |
| `HistoricoCierresZ` | 13 | 7 | 6 |
| `FacturasRecibidas` | 46 | 30 | 16 |
| `CitasF2` | 25 | 8 | 17 |
| `MovimientosInventario` | 10 | 5 | 5 |
| `RegistrosHorariosStaff` | 7 | 4 | 3 |
| `CompensacionesPendientes` | 9 | 3 | 6 |
| `ConfiguracionFiscal` | 11 | 6 | 5 |
| **TOTAL** | **310** | **178** | **132** |

---

## Patrones de traducción aplicados (referencia)

| Patrón español | Patrón inglés | Ejemplo |
|---|---|---|
| `nif*` | `*taxId` | `nifEmisor` → `issuerTaxId` |
| `nombreRazon*` | `*legalName` | `nombreRazonEmisor` → `issuerLegalName` |
| `fecha*` (como emisión) | `*Date` | `fechaExpedicionFactura` → `invoiceIssueDate` |
| `importe*` | `*Amount` | `importeTotal` → `totalAmount` |
| `cuota*` | `*Amount` / `*TaxAmount` | `cuotaTotal` → `taxAmount` |
| `tipo*` (categoría) | `*Type` | `tipoFactura` → `invoiceType` |
| `*Tasa` (ratio) | `*Rate` | `impuestoTasa` → `taxRate` |
| `claveRegimen` | `regimeKey` | — |
| `numero*` | `*Number` | `numeroLinea` → `lineNumber` |
| `*Id` (FK) | `*Id` (sin cambio) | `terceroId` → `thirdPartyId` |
| `*Vinculada` | `*Linked` | `reservaIdVinculada` → `linkedBookingIds` |
| `*Origen` | `source*` | `eventoOrigenId` → `sourceEventId` |
| `descripcion*` | `*Description` | `descripcionOperacion` → `operationDescription` |
| `*Aeat` | `aeat*` | `estadoEnvioAeat` → `aeatSubmissionStatus` |

---

## Excepciones (ID permanece en español por obligación AEAT)

Solo el **contenido** de estos objetos mantiene nombres AEAT oficiales en español, no sus claves de colección:

- `MovimientosCaja.fiscalPayload` — cuerpo JSON con nombres AEAT (`IDEmisorFactura`, `NumSerieFactura`, etc.)
- `MovimientosCaja.computerSystem` — snapshot que replica estructura oficial
- `AsientosContables.fiscalPayloadSnapshot` — copia del anterior
- `ConfiguracionFiscal.computerSystem` — idem
- `LibroAsientosContablesDetalle.detailedBreakdown[]` — cada línea contiene nombres AEAT dentro del objeto

**Razón:** AEAT exige esos nombres literales en el JSON firmado y enviado. La directriz V20 se aplica a los **IDs de colección**, no al payload normativo.

---

**Uso recomendado:** esta matriz es el input directo de un script de migración/refactor mecánico. Los patrones de traducción permiten auditar que no falte ningún campo. Los anexos indican dónde NO aplicar la traducción.
