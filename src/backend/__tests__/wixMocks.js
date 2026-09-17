/**
 * MOCK DE MÓDULOS WIX PARA TESTING EN ENTORNO NODE.JS
 * 
 * PROPÓSITO: Simular APIs de wix-data, wix-secrets, etc. para permitir
 * ejecución de tests estáticos y dinámicos fuera del entorno Velo.
 * 
 * NOTA: Este archivo NO se despliega en producción Wix.
 */

// Mock de wix-data
export const wixDataMock = {
  async query(collectionName) {
    return {
      eq: (field, value) => this,
      ne: (field, value) => this,
      gt: (field, value) => this,
      lt: (field, value) => this,
      ge: (field, value) => this,
      le: (field, value) => this,
      in: (field, arr) => this,
      hasSome: (field, arr) => this,
      contains: (field, value) => this,
      startsWith: (field, value) => this,
      orderBy: (field, order) => this,
      skip: (n) => this,
      limit: (n) => this,
      find: async () => ({ items: [] }),
      single: async () => null
    };
  },
  
  async get(collectionName, id) {
    return null; // Por defecto no existe
  },
  
  async insert(collectionName, item) {
    // Simular inserción con _id generado
    return { ...item, _id: item._id || `mock_${Date.now()}` };
  },
  
  async update(collectionName, item) {
    // Para tests de inmutabilidad, lanzar error si es colección fiscal
    if (collectionName === 'MovimientosCaja' || collectionName === 'RegistrosHorariosStaff') {
      const error = new Error(`FISCAL_IMMUTABILITY_VIOLATION: No se permite update en ${collectionName}`);
      error.code = 'IMMUTABILITY_VIOLATION';
      throw error;
    }
    return { ...item };
  },
  
  async remove(collectionName, id) {
    // Para tests de inmutabilidad laboral/fiscal
    if (collectionName === 'MovimientosCaja' || collectionName === 'RegistrosHorariosStaff' || collectionName === 'HistoricoCierresZ') {
      const error = new Error(`LABORAL_IMMUTABILITY_VIOLATION: No se permite remove en ${collectionName}`);
      error.code = 'IMMUTABILITY_VIOLATION';
      throw error;
    }
    return { deletedAt: new Date() };
  },
  
  async save(collectionName, item) {
    return { ...item };
  },
  
  async bulkInsert(collectionName, items) {
    return { inserted: items.length, ids: items.map(i => i._id || `mock_${Date.now()}`) };
  }
};

// Mock de wix-secrets
export const wixSecretsMock = {
  async get(secretName) {
    // Devolver valores mock para testing
    const mockSecrets = {
      'FISCAL_KEY': 'mock_hmac_key_for_testing_only',
      'FISCAL_NIF_EMISOR': 'B12345678',
      'WIX_BOOKINGS_API_KEY': 'mock_bookings_key',
      'M365_CLIENT_SECRET': 'mock_m365_secret'
    };
    return { value: mockSecrets[secretName] || 'mock_value' };
  }
};

// Mock de wix-conceal (para PII masking)
export const wixConcealMock = {
  maskPII: (data) => data, // No-op en testing
  revealPII: (data) => data
};

// Mock de wix-cron
export const wixCronMock = {
  schedule: async (name, config) => ({ id: 'mock_cron_id' }),
  unschedule: async (name) => ({})
};

// Mock de wix-notifications
export const wixNotificationsMock = {
  send: async (config) => ({ messageId: 'mock_msg_id' })
};

// Exportar todos los mocks como objeto único
export default {
  'wix-data': wixDataMock,
  'wix-secrets': wixSecretsMock,
  'wix-conceal': wixConcealMock,
  'wix-cron': wixCronMock,
  'wix-notifications': wixNotificationsMock
};
