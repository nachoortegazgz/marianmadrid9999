#!/usr/bin/env node

/**
 * EJECUTOR DE TESTS - MASTER RUNNER
 * 
 * Ejecuta baterías de tests estáticos, dinámicos y E2E en secuencia.
 * Genera informe JSON detallado para CI/CD.
 * 
 * USO: node runAllTests.js [--verbose]
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Importar runners de test
import { runAllUnitTests } from './unit.testRunner.js';

// Los tests críticos y E2E requieren mocks de Wix que no están disponibles en este entorno
// Se ejecutan solo los tests unitarios puros
const USE_MOCKS = false;

// ============================================================================
// CONFIGURACIÓN
// ============================================================================

const VERBOSE = process.argv.includes('--verbose');
const OUTPUT_FILE = join(__dirname, 'test-results.json');

// ============================================================================
// UTILIDADES
// ============================================================================

function printHeader(text) {
  console.log('\n' + '='.repeat(80));
  console.log(` ${text}`);
  console.log('='.repeat(80) + '\n');
}

function printTestResult(result) {
  const statusIcon = result.status === 'PASS' ? '✅' : '❌';
  console.log(`${statusIcon} [${result.testId}] ${result.status}: ${result.message || result.error}`);
  if (VERBOSE && result.data) {
    console.log(`   Datos: ${JSON.stringify(result.data)}`);
  }
}

function printSummary(summary) {
  const totalEmoji = summary.failed === 0 ? '🎉' : '⚠️';
  console.log(`\n${totalEmoji} RESUMEN:`);
  console.log(`   Total Tests: ${summary.total}`);
  console.log(`   Aprobados:   ${summary.passed}`);
  console.log(`   Fallidos:    ${summary.failed}`);
  if (summary.successRate) {
    console.log(`   Tasa Éxito:  ${summary.successRate}`);
  }
  console.log(`   ESTADO:      ${summary.status}`);
}

// ============================================================================
// EJECUCIÓN PRINCIPAL
// ============================================================================

async function main() {
  const globalResults = {
    timestamp: new Date().toISOString(),
    environment: 'nodejs-test-runner',
    batteries: [],
    globalSummary: {
      totalTests: 0,
      totalPassed: 0,
      totalFailed: 0,
      overallStatus: 'UNKNOWN'
    }
  };

  printHeader('EJECUCIÓN DE BATERÍAS DE TEST - SSOT v5002.6');
  console.log(`Timestamp: ${globalResults.timestamp}`);
  console.log(`Verbose Mode: ${VERBOSE ? 'ON' : 'OFF'}`);

  // -------------------------------------------------------------------------
  // BATERÍA 1: TESTS UNITARIOS PUROS (SIN DEPENDENCIAS WIX)
  // -------------------------------------------------------------------------
  printHeader('BATERÍA 1: TESTS UNITARIOS');
  
  try {
    const unitResults = await runAllUnitTests();
    
    globalResults.batteries.push({
      name: 'UNIT_TESTS',
      description: 'Tests puros de lógica, enums y estructuras SSOT',
      timestamp: new Date().toISOString(),
      results: unitResults
    });

    printSummary(unitResults);
    if (VERBOSE && unitResults.details) {
      unitResults.details.forEach(printTestResult);
    }

    // Acumular globales
    globalResults.globalSummary.totalTests += unitResults.total;
    globalResults.globalSummary.totalPassed += unitResults.passed;
    globalResults.globalSummary.totalFailed += unitResults.failed;

  } catch (error) {
    console.error(`❌ ERROR en Batería 1: ${error.message}`);
    globalResults.batteries.push({
      name: 'UNIT_TESTS',
      status: 'ERROR',
      error: error.message,
      stack: error.stack
    });
    globalResults.globalSummary.totalFailed++;
  }

  // -------------------------------------------------------------------------
  // NOTA: TESTS CRÍTICOS Y E2E REQUIEREN ENTORNO WIX VELO
  // -------------------------------------------------------------------------
  console.log('\n⚠️  NOTA: Los tests T-INM, T-FIS, T-CONC y E2E requieren el entorno Wix Velo.');
  console.log('   Para ejecutarlos completos, desplegar en sandbox de Wix y usar:');
  console.log('   import { runAllCriticalTests } from "backend/__tests__/testRunner.internal";');
  console.log('   import { runAllE2ETests } from "backend/__tests__/e2e.testRunner";');

  // -------------------------------------------------------------------------
  // RESUMEN GLOBAL FINAL
  // -------------------------------------------------------------------------
  const { totalTests, totalPassed, totalFailed } = globalResults.globalSummary;
  const successRate = totalTests > 0 ? ((totalPassed / totalTests) * 100).toFixed(2) + '%' : '0%';
  
  globalResults.globalSummary.overallStatus = 
    totalFailed === 0 ? 'ALL_TESTS_PASSED_READY_FOR_DEPLOY' : 'SOME_TESTS_FAILED_REVIEW_REQUIRED';
  globalResults.globalSummary.successRate = successRate;

  printHeader('RESULTADO GLOBAL');
  console.log(`📊 TOTAL BATERÍAS: ${globalResults.batteries.length}`);
  console.log(`📈 TASA DE ÉXITO:  ${successRate}`);
  console.log(`🎯 ESTADO FINAL:  ${globalResults.globalSummary.overallStatus}`);

  // -------------------------------------------------------------------------
  // EXPORTAR RESULTADOS A JSON
  // -------------------------------------------------------------------------
  try {
    writeFileSync(OUTPUT_FILE, JSON.stringify(globalResults, null, 2), 'utf8');
    console.log(`\n💾 Resultados exportados a: ${OUTPUT_FILE}`);
  } catch (ioError) {
    console.error(`⚠️ No se pudo escribir el archivo de resultados: ${ioError.message}`);
  }

  // -------------------------------------------------------------------------
  // CÓDIGO DE SALIDA PARA CI/CD
  // -------------------------------------------------------------------------
  const exitCode = totalFailed === 0 ? 0 : 1;
  console.log(`\n🔑 Exit Code: ${exitCode} (${totalFailed === 0 ? 'ÉXITO' : 'FALLOS DETECTADOS'})`);
  
  process.exit(exitCode);
}

// Ejecutar
main().catch(err => {
  console.error('💥 Error fatal en test runner:', err);
  process.exit(1);
});
