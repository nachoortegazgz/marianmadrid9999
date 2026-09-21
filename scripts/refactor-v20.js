/**
 * SCRIPT DE REFACTORIZACIÓN V20
 * Aplica la Matriz de Cambio v5009 → v5009-V20 a todos los módulos backend
 */

import fs from 'fs';
import path from 'path';

// Matriz de Cambio completa (old → new)
const CHANGE_MATRIX = {
  // DatosFiscales
  'nifCif': 'taxId',
  'razonSocial': 'legalName',
  'tipoTercero': 'thirdPartyType',
  'datosContacto': 'contactData',
  'regimenesEspeciales': 'specialRegimes',
  'esMinoristaRecargoEquivalencia': 'isRetailerEquivalenceSurcharge',
  'esEmpresarioProfesional': 'isBusinessProfessional',
  'resourceIdBookings': 'bookingsResourceId',
  'esProveedorHabitual': 'isRegularSupplier',
  'condicionesPago': 'paymentTerms',
  'activo': 'active',
  'traceIdAlta': 'registrationTraceId',
  'sistemaInformatico': 'computerSystem',
  'nifProductor': 'producerTaxId',
  'nombreRazonProductor': 'producerLegalName',
  'idSistemaInformatico': 'computerSystemId',
  'numeroInstalacion': 'installationNumber',
  'tipoUsoPosibleSoloVerifactu': 'possibleUseOnlyVerifactu',
  'tipoUsoPosibleMultiOT': 'possibleUseMultiOT',
  'indicadorMultiplesOT': 'multipleOTIndicator',
  'fechaInicioVerifactu': 'verifactuStartDate',
  
  // MapaStaff
  'nombre': 'name',
  'terceroId': 'thirdPartyId',
  
  // ServiciosCatalogo
  'naturalezaItem': 'itemNature',
  'codigoImpuesto': 'taxCode',
  'claveRegimenAEAT': 'aeatRegimeKey',
  'calificacionOperacionAEAT': 'aeatOperationClassification',
  'operacionExentaAEAT': 'aeatExemptOperation',
  'inversionSujetoPasivo': 'reverseCharge',
  'cuentaContableIngreso': 'incomeAccountCode',
  'cuentaContableGasto': 'expenseAccountCode',
  
  // MovimientosCaja - Campos fiscales CRÍTICOS
  'importeTotal': 'totalAmount',
  'tipoMovimiento': 'movementType',
  'descripcionOperacion': 'operationDescription',
  'reservaIdVinculada': 'linkedBookingIds',
  'huella': 'recordHash',
  'huellaAnterior': 'previousRecordHash',
  'fechaHoraHusoGenRegistro': 'recordTimestamp',
  'numSerieFactura': 'invoiceNumber',
  'fechaExpedicionFactura': 'invoiceIssueDate',
  'fechaOperacion': 'operationDate',
  'tipoFactura': 'invoiceType',
  'tipoRectificativa': 'correctionType',
  'importeRectificacion': 'correctionAmount',
  'baseImponibleOImporteNoSujeto': 'taxableBaseOrNonSubjectAmount',
  'cuotaTotal': 'taxAmount',
  'tipoImpositivo': 'taxRate',
  'tipoRecargoEquivalencia': 'surchargeRate',
  'cuotaRecargoEquivalencia': 'surchargeAmount',
  'importeRetencionIRPF': 'irpfWithholdingAmount',
  'tipoRetencionIRPF': 'irpfWithholdingRate',
  'baseImponibleRetencion': 'withholdingBase',
  'nifEmisor': 'issuerTaxId',
  'nombreRazonEmisor': 'issuerLegalName',
  'nifDestinatario': 'recipientTaxId',
  'nombreRazonDestinatario': 'recipientLegalName',
  'domicilioDestinatario': 'recipientAddress',
  'emitidaPorTerceroODestinatario': 'issuedByThirdPartyOrRecipient',
  'nombreRazonTercero': 'thirdPartyLegalName',
  'nifTerceroExpedidor': 'issuerThirdPartyTaxId',
  'causaNoSujeta': 'nonSubjectReason',
  'claveRegimen': 'regimeKey',
  'calificacionOperacion': 'operationClassification',
  'operacionExenta': 'exemptOperation',
  'regimenEspecialCriterioCaja': 'cashBasisRegime',
  'exentaPorArticulo20': 'article20Exempt',
  'desgloseDetallado': 'detailedBreakdown',
  'idFacturaAnterior': 'previousInvoiceId',
  'numSerieFacturaAnterior': 'previousInvoiceNumber',
  'fechaExpedicionFacturaAnterior': 'previousInvoiceIssueDate',
  'estadoEnvioAeat': 'aeatSubmissionStatus',
  'csvAeat': 'aeatCsv',
  'fechaEnvioAeat': 'aeatSubmissionDate',
  'tipoEvento': 'eventType',
  'payloadFiscal': 'fiscalPayload',
  'proyeccionEstado': 'projectionStatus',
  'proyeccionDetalleIds': 'projectionDetailIds',
  
  // LibroAsientosContablesDetalle
  'cuotaRepercutida': 'chargedTaxAmount',
  'eventoOrigenId': 'sourceEventId',
  'numeroLinea': 'lineNumber',
  'unidades': 'units',
  'magnitud': 'magnitude',
  'importeNetoUnitario': 'netUnitAmount',
  'cuentaContable': 'accountCode',
  
  // AsientosContables
  'fiscalPeriod': 'fiscalPeriod',
  'entryStatus': 'entryStatus',
  'journalEntryId': 'journalEntryId',
  'previousHash': 'previousHash',
  'hashOrigen': 'sourceHash',
  'totalDocumentAmount': 'totalDocumentAmount',
  'payloadFiscalSnapshot': 'fiscalPayloadSnapshot',
  
  // HistoricoCierresZ
  'saldosPorMetodo': 'balancesByMethod',
  'desglosePorRegimen': 'breakdownByRegime',
  'desglosePorTipoOperacion': 'breakdownByOperationType',
  'desglosePorTipoImpositivo': 'breakdownByTaxRate',
  'resumenVerifactu': 'verifactuSummary',
  'respuestaAeat': 'aeatResponse',
  
  // FacturasRecibidas
  'numeroRecepcion': 'receptionNumber',
  'fechaRecepcion': 'receptionDate',
  'fechaRegistroContable': 'accountingEntryDate',
  'baseImponibleTotal': 'totalTaxableBase',
  'cuotaIvaTotal': 'totalVatAmount',
  'regimenEspecial': 'specialRegime',
  'deducible': 'deductible',
  'porcentajeDeduccion': 'deductionPercentage',
  'cuotaDeducible': 'deductibleAmount',
  'estadoPago': 'paymentStatus',
  'fechaPago': 'paymentDate',
  'medioPago': 'paymentMethod',
  'cuentaContableIva': 'vatAccountCode',
  'cuentaContableProveedor': 'supplierAccountCode',
  'asientoContableId': 'accountingEntryId',
  'facturaRectificadaId': 'correctedInvoiceId',
  'motivoRectificacion': 'correctionReason',
  'documentoAdjuntoUrl': 'attachmentUrl',
  'archivoHash': 'fileHash',
  'origenRecepcion': 'receptionSource',
  'estadoValidacion': 'validationStatus',
  
  // CitasF2
  'datosFiscales': 'fiscalData',
  'movimientoCajaId': 'cashMovementId',
  'fechaFacturacion': 'invoicingDate',
  
  // MovimientosInventario
  'refundId': 'refundId',
  
  // RegistrosHorariosStaff
  'fecha': 'date',
  'horas': 'hours',
  
  // CompensacionesPendientes
  'kind': 'kind',
  'attempts': 'attempts',
  'errorCode': 'errorCode',
  'errorMessage': 'errorMessage',
  
  // ConfiguracionFiscal
  'version': 'version',
  'installationNumber': 'installationNumber'
};

function refactorFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let changesCount = 0;
  let changesLog = [];
  
  const sortedKeys = Object.keys(CHANGE_MATRIX).sort((a, b) => b.length - a.length);
  
  sortedKeys.forEach(oldField => {
    const newField = CHANGE_MATRIX[oldField];
    if (oldField === newField) return;
    
    const patterns = [
      {
        regex: new RegExp(`\\.${oldField}\\b`, 'g'),
        replace: `.${newField}`,
        context: 'property access'
      },
      {
        regex: new RegExp(`['"]${oldField}['"]`, 'g'),
        replace: `'${newField}'`,
        context: 'query parameter'
      }
    ];
    
    patterns.forEach(({ regex, replace, context }) => {
      const matches = content.match(regex);
      if (matches && matches.length > 0) {
        content = content.replace(regex, replace);
        changesCount += matches.length;
        changesLog.push(`  ${oldField} → ${newField} (${context}): ${matches.length}`);
      }
    });
  });
  
  if (changesCount > 0) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`\n✅ ${path.basename(filePath)}: ${changesCount} cambios`);
    changesLog.slice(0, 5).forEach(log => console.log(`    ${log}`));
    if (changesLog.length > 5) console.log(`    ... y ${changesLog.length - 5} más`);
  } else {
    console.log(`⚪ ${path.basename(filePath)}: sin cambios`);
  }
  
  return { file: filePath, changes: changesCount };
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  REFACTORIZACIÓN V20 — Aplicando Matriz de Cambio');
console.log('═══════════════════════════════════════════════════════════\n');

const backendDir = '/workspace/src/backend';
const jsFiles = fs.readdirSync(backendDir)
  .filter(file => file.endsWith('.js'))
  .map(file => path.join(backendDir, file));

const results = jsFiles.map(refactorFile);
const totalChanges = results.reduce((sum, r) => sum + r.changes, 0);

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  RESUMEN: ${results.filter(r => r.changes > 0).length}/${results.length} archivos modificados`);
console.log(`  Total cambios: ${totalChanges}`);
console.log('═══════════════════════════════════════════════════════════');

fs.writeFileSync('/workspace/refactor-log.json', JSON.stringify(results, null, 2));
console.log('\n📄 Log en /workspace/refactor-log.json');
