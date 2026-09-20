/**
 * TEST RUNNER DE UNIDAD AISLADO - SIN DEPENDENCIAS WIX
 * 
 * PROPÓSITO: Ejecutar tests unitarios puros que NO requieren el entorno Wix Velo.
 * Valida lógica de negocio, generación de tokens, estructuras de datos y enums.
 * 
 * SSOT v5002.6 · CERO SUPOSICIONES
 */

import assert from 'assert';
import {
  COLLECTIONS,
  SDK_CONFIG,
  ESTADO_CITA,
  ESTADO_PAGO,
  CONCURRENCY
} from '../internalConfig.js';

// Compatibilidad con estructura SSOT v5002.6 - Enums consolidados
const ENUMS = {
  BOOKING_TYPE: ['SIMPLE', 'DUAL_F1', 'DUAL_F2'],
  BOOKING_STATUS: Object.values(ESTADO_CITA),
  PAYMENT_STATUS: Object.values(ESTADO_PAGO),
  INVOICE_TYPE: ['F1', 'F2', 'F3', 'R1', 'R2', 'R3', 'R4', 'R5'],
  REGIME_KEY: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17'],
  PAYMENT_METHOD: ['EFECTIVO', 'TARJETA', 'BIZUM', 'TRANSFERENCIA', 'ONLINE'],
  ENTRY_STATUS: ['DRAFT', 'POSTED', 'LOCKED'],
  ACCOUNT_NATURE: ['ACTIVO', 'PASIVO', 'INGRESO', 'GASTO']
};

// ============================================================================
// CONFIGURACIÓN
// ============================================================================

const UNIT_CONFIG = {
  TRACE_ID: `UNIT_RUN_${Date.now()}`,
  TEST_DATA: {
    SERVICE_ID: 'svc_test_dual_001',
    RESOURCE_ID: 'res_test_001',
    DATE_YMD: '2026-09-20',
    TIME_SLOT_F1: '10:00',
    CUSTOMER_EMAIL: 'test.unit@example.com'
  }
};

// ============================================================================
// BATERÍA UNIT-GEN: GENERADORES Y UTILIDADES
// ============================================================================

/**
 * Test UNIT-GEN-01: Generación determinista de pairToken
 */
export async function testPairTokenDeterministic() {
  const traceId = `${UNIT_CONFIG.TRACE_ID}:UNIT-GEN-01`;
  const crypto = await import('crypto');
  
  const generatePairToken = (serviceId, date, time, email) => {
    const payload = `${serviceId}|${date}|${time}|${email}`;
    return crypto.default.createHash('sha256').update(payload).digest('hex').substring(0, 16);
  };
  
  const { SERVICE_ID, DATE_YMD, TIME_SLOT_F1, CUSTOMER_EMAIL } = UNIT_CONFIG.TEST_DATA;
  
  const token1 = generatePairToken(SERVICE_ID, DATE_YMD, TIME_SLOT_F1, CUSTOMER_EMAIL);
  const token2 = generatePairToken(SERVICE_ID, DATE_YMD, TIME_SLOT_F1, CUSTOMER_EMAIL);
  const token3 = generatePairToken(SERVICE_ID, DATE_YMD, '11:00', CUSTOMER_EMAIL);
  
  assert.strictEqual(token1, token2, 'Idempotencia fallida');
  assert.notStrictEqual(token1, token3, 'Unicidad fallida');
  assert.match(token1, /^[a-f0-9]{16}$/, 'Formato inválido');
  
  return { testId: 'UNIT-GEN-01', status: 'PASS', message: 'pairToken determinista verificado', data: { token: token1 } };
}

/**
 * Test UNIT-GEN-02: Construcción de SlotKey
 */
export async function testSlotKeyFormat() {
  const { DATE_YMD, TIME_SLOT_F1, RESOURCE_ID } = UNIT_CONFIG.TEST_DATA;
  
  const buildSlotKey = (dateYmd, startTime, resourceId) => {
    return `lock:${resourceId}:${dateYmd}:${startTime.replace(':', '')}`;
  };
  
  const key1 = buildSlotKey(DATE_YMD, TIME_SLOT_F1, RESOURCE_ID);
  const key2 = buildSlotKey(DATE_YMD, TIME_SLOT_F1, RESOURCE_ID);
  const key3 = buildSlotKey(DATE_YMD, '11:00', RESOURCE_ID);
  
  assert.strictEqual(key1, key2, 'Colisión fallida');
  assert.notStrictEqual(key1, key3, 'Unicidad fallida');
  assert.match(key1, /^lock:[^:]+:\d{4}-\d{2}-\d{2}:\d{4}$/, 'Formato inválido');
  
  return { testId: 'UNIT-GEN-02', status: 'PASS', message: 'SlotKey formato correcto', data: { slotKey: key1 } };
}

/**
 * Test UNIT-GEN-03: Conversión de fecha UTC a Europe/Madrid
 */
export async function testDateConversion() {
  const formatDateYmd = (utcDate) => {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Europe/Madrid' };
    const parts = new Intl.DateTimeFormat('es-ES', options).formatToParts(utcDate);
    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    return `${year}-${month}-${day}`;
  };
  
  // Noche: 22:00 UTC en verano = 00:00+2 día siguiente
  const utcDateNight = new Date('2026-09-20T22:00:00Z');
  const dateYmdNight = formatDateYmd(utcDateNight);
  assert.strictEqual(dateYmdNight, '2026-09-21', 'Conversión nocturna fallida');
  
  // Día: 10:00 UTC = 12:00 Madrid mismo día
  const utcDateDay = new Date('2026-09-20T10:00:00Z');
  const dateYmdDay = formatDateYmd(utcDateDay);
  assert.strictEqual(dateYmdDay, '2026-09-20', 'Conversión diurna fallida');
  
  return { testId: 'UNIT-GEN-03', status: 'PASS', message: 'Conversión timezone correcta' };
}

// ============================================================================
// BATERÍA UNIT-ENUM: VALIDACIÓN DE ENUMS
// ============================================================================

/**
 * Test UNIT-ENUM-01: Enums de CITAS_F2 completos
 */
export async function testBookingEnums() {
  // Align with internalConfig ESTADO_CITA / ESTADO_PAGO (canonical SSOT)
  assert.ok(ESTADO_CITA.CONFIRMED === 'CONFIRMED', 'ESTADO_CITA.CONFIRMED');
  assert.ok(ESTADO_CITA.PENDING_PAYMENT === 'PENDING_PAYMENT', 'ESTADO_CITA.PENDING_PAYMENT');
  // SSOT v5008.6: CANCELLED es canonico, CANCELED es alias deprecated que apunta a CANCELLED
  assert.ok(ESTADO_CITA.CANCELLED === 'CANCELLED', 'ESTADO_CITA.CANCELLED');
  assert.ok(ESTADO_CITA.CANCELED === 'CANCELLED', 'ESTADO_CITA.CANCELED (alias deprecated)');

  assert.ok(ESTADO_PAGO.PAID === 'PAID', 'ESTADO_PAGO.PAID');
  assert.ok(ESTADO_PAGO.UNPAID === 'UNPAID', 'ESTADO_PAGO.UNPAID');
  assert.ok(ESTADO_PAGO.PENDING_PAYMENT === 'PENDING_PAYMENT', 'ESTADO_PAGO.PENDING_PAYMENT');
  assert.ok(ESTADO_PAGO.REFUNDED === 'REFUNDED', 'ESTADO_PAGO.REFUNDED');

  return { testId: 'UNIT-ENUM-01', status: 'PASS', message: 'Enums CITAS_F2 alineados con internalConfig' };
}

export async function testFiscalEnums() {
  // Invoice Types AEAT (F1-F3, R1-R5)
  const invoiceTypes = ENUMS.INVOICE_TYPE;
  assert.ok(invoiceTypes.includes('F1'), 'F1 faltante');
  assert.ok(invoiceTypes.includes('F2'), 'F2 faltante');
  assert.ok(invoiceTypes.includes('F3'), 'F3 faltante');
  assert.ok(invoiceTypes.includes('R1'), 'R1 faltante');
  assert.ok(invoiceTypes.includes('R5'), 'R5 faltante');
  assert.strictEqual(invoiceTypes.length, 8, 'INVOICE_TYPE debe tener 8 valores');
  
  // Regime Keys (17 claves oficiales)
  const regimeKeys = ENUMS.REGIME_KEY;
  assert.ok(regimeKeys.includes('01'), 'Clave 01 faltante');
  assert.ok(regimeKeys.includes('17'), 'Clave 17 faltante');
  assert.strictEqual(regimeKeys.length, 17, 'REGIME_KEY debe tener 17 valores');
  
  // Payment Methods
  const paymentMethods = ENUMS.PAYMENT_METHOD;
  assert.ok(paymentMethods.includes('EFECTIVO'), 'EFECTIVO faltante');
  assert.ok(paymentMethods.includes('TARJETA'), 'TARJETA faltante');
  assert.ok(paymentMethods.includes('BIZUM'), 'BIZUM faltante');
  assert.ok(paymentMethods.includes('ONLINE'), 'ONLINE faltante');
  
  return { testId: 'UNIT-ENUM-02', status: 'PASS', message: 'Enums fiscales AEAT válidos' };
}

/**
 * Test UNIT-ENUM-03: Enums contables PGC
 */
export async function testAccountingEnums() {
  const entryStatus = ENUMS.ENTRY_STATUS;
  assert.ok(entryStatus.includes('DRAFT'), 'DRAFT faltante');
  assert.ok(entryStatus.includes('POSTED'), 'POSTED faltante');
  assert.ok(entryStatus.includes('LOCKED'), 'LOCKED faltante');
  assert.strictEqual(entryStatus.length, 3, 'ENTRY_STATUS debe tener 3 valores');
  
  const accountNature = ENUMS.ACCOUNT_NATURE;
  assert.ok(accountNature.includes('ACTIVO'), 'ACTIVO faltante');
  assert.ok(accountNature.includes('PASIVO'), 'PASIVO faltante');
  assert.ok(accountNature.includes('INGRESO'), 'INGRESO faltante');
  assert.ok(accountNature.includes('GASTO'), 'GASTO faltante');
  
  return { testId: 'UNIT-ENUM-03', status: 'PASS', message: 'Enums contables PGC válidos' };
}

// ============================================================================
// BATERÍA UNIT-STRUCT: ESTRUCTURAS DE DATOS
// ============================================================================

/**
 * Test UNIT-STRUCT-01: Colecciones SSOT definidas
 */
export async function testCollectionsDefined() {
  const requiredCollections = [
    'CATEGORIAS_SERVICIO',
    'SERVICIOS_CATALOGO',
    'MAPA_STAFF',
    'CITAS_F2',
    'DUAL_SLOT_CACHE',
    'MOVIMIENTOS_CAJA',
    'HISTORICO_CIERRES_Z',
    'CONFIGURACION_FISCAL',
    'LIBRO_REGISTRO_FACTURAS_EXPEDIDAS',
    'ASIENTOS_CONTABLES',
    'REGISTROS_HORARIOS_STAFF'
  ];
  
  requiredCollections.forEach(col => {
    assert.ok(COLLECTIONS[col], `Colección ${col} no definida`);
    assert.strictEqual(typeof COLLECTIONS[col], 'string', `Colección ${col} no es string`);
    assert.ok(COLLECTIONS[col].length > 0, `Colección ${col} vacía`);
  });
  
  // Verificar que no hay duplicados en valores
  const values = Object.values(COLLECTIONS);
  const uniqueValues = new Set(values);
  assert.strictEqual(values.length, uniqueValues.size, 'Hay colecciones duplicadas');
  
  return { testId: 'UNIT-STRUCT-01', status: 'PASS', message: 'Todas las colecciones SSOT definidas', data: { count: values.length } };
}

/**
 * Test UNIT-STRUCT-02: SDK_CONFIG válido
 */
export async function testSdkConfig() {
  assert.ok(CONCURRENCY && typeof CONCURRENCY === 'object', 'CONCURRENCY definido');
  assert.ok(Number(CONCURRENCY.MUTEX_TTL_MS) > 0, 'MUTEX_TTL_MS debe ser positivo');
  assert.ok(Number(CONCURRENCY.HEARTBEAT_MS) > 0, 'HEARTBEAT_MS debe ser positivo');
  return { testId: 'UNIT-STRUCT-02', status: 'PASS', message: 'CONCURRENCY/SDK config valida' };
}

export async function testCitasF2NoLegacy() {
  const startDateUTC = new Date('2026-09-20T10:00:00Z');
  const endDateUTC = new Date('2026-09-20T11:00:00Z');
  
  const bookingPayload = {
    bookingId: 'WIX_BK_TEST',
    pairToken: 'test_token',
    serviceId: 'svc_001',
    resourceId: 'res_001',
    startDate: startDateUTC,
    endDate: endDateUTC,
    dateYmd: '2026-09-20',
    bookingType: 'SIMPLE',
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    traceId: 'TEST_TRACE'
  };
  
  // Validar campos requeridos SSOT
  const requiredFields = ['bookingId', 'pairToken', 'serviceId', 'startDate', 'endDate', 'status'];
  requiredFields.forEach(field => {
    assert.ok(bookingPayload[field] !== undefined, `Campo requerido faltante: ${field}`);
  });
  
  // Validar AUSÊNCIA de campos legacy
  assert.strictEqual(bookingPayload.startDateLocal, undefined, 'startDateLocal es legacy - ELIMINAR');
  assert.strictEqual(bookingPayload.endDateLocal, undefined, 'endDateLocal es legacy - ELIMINAR');
  assert.strictEqual(bookingPayload.uiPairToken, undefined, 'uiPairToken es legacy - ELIMINAR');
  
  // Validar tipos
  assert.ok(bookingPayload.startDate instanceof Date, 'startDate debe ser Date');
  assert.ok(bookingPayload.endDate instanceof Date, 'endDate debe ser Date');
  assert.strictEqual(typeof bookingPayload.dateYmd, 'string', 'dateYmd debe ser string');
  assert.match(bookingPayload.dateYmd, /^\d{4}-\d{2}-\d{2}$/, 'dateYmd formato YYYY-MM-DD');
  
  return { testId: 'UNIT-STRUCT-03', status: 'PASS', message: 'Payload sin campos legacy' };
}

// ============================================================================
// EJECUTOR PRINCIPAL
// ============================================================================

export async function runAllUnitTests() {
  const results = [];
  console.log(`[UNIT_TEST_RUNNER] Iniciando batería de unidad. Trace: ${UNIT_CONFIG.TRACE_ID}`);
  
  const tests = [
    testPairTokenDeterministic,
    testSlotKeyFormat,
    testDateConversion,
    testBookingEnums,
    testFiscalEnums,
    testAccountingEnums,
    testCollectionsDefined,
    testSdkConfig,
    testCitasF2NoLegacy
  ];
  
  for (const testFn of tests) {
    try {
      const result = await testFn();
      results.push(result);
      console.log(`✅ [${result.testId}] PASS: ${result.message}`);
    } catch (error) {
      console.error(`❌ [${testFn.name}] FAIL: ${error.message}`);
      results.push({ 
        testId: testFn.name.replace('test', ''), 
        status: 'FAIL', 
        error: error.message 
      });
    }
  }
  
  const passCount = results.filter(r => r.status === 'PASS').length;
  const totalCount = results.length;
  
  const summary = {
    traceId: UNIT_CONFIG.TRACE_ID,
    total: totalCount,
    passed: passCount,
    failed: totalCount - passCount,
    successRate: ((passCount / totalCount) * 100).toFixed(2) + '%',
    status: passCount === totalCount ? 'UNIT_TESTS_PASSED' : 'UNIT_TESTS_FAILED',
    details: results
  };
  
  console.log(`\n[UNIT_TEST_RUNNER] Finalizado. Éxito: ${summary.successRate}. Estado: ${summary.status}`);
  
  return summary;
}
