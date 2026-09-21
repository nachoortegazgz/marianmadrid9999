# ==============================================================================
# SCRIPT: Crear-Listas-SharePoint.ps1
# SSOT v5002.6 | G10 ASCII Strict | Marian Madrid Peluqueria y Estetica
# Crea las 7 SharePoint Lists con todas las columnas tipadas
# Sitio: https://marianmadrid.sharepoint.com/sites/marianmadrid_intranet
# Normativa: SIF/Verifactu (RD 1007/2023) | Art.34.9 ET | PGC | RGPD/LOPDGDD
# Retenciones: 4 anos fiscal/laboral | 6 anos contable
# ATENCION: Ejecutar como archivo .ps1, nunca pegar en consola directamente
# ==============================================================================

$SiteUrl   = "https://marianmadrid.sharepoint.com/sites/marianmadrid_intranet"
$CreatedOk = 0
$SkippedOk = 0
$ErrorCount = 0

# --- CONEXION --------------------------------------------------------------
try {
    Connect-PnPOnline -Url $SiteUrl -Interactive
    Write-Host "[OK] Conexion establecida." -ForegroundColor Green
} catch {
    Write-Host "[ERROR FATAL] No se pudo conectar: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# ==========================================================================
# FUNCION AUXILIAR: Crear lista si no existe
# ==========================================================================
function Ensure-List {
    param([string]$ListName, [string]$Description)
    $existing = Get-PnPList -Identity $ListName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "[SKIP] Lista ya existe: $ListName" -ForegroundColor Yellow
        $script:SkippedOk++
        return $false
    }
    try {
        New-PnPList -Title $ListName -Template GenericList -Url "Lists/$ListName" -ErrorAction Stop | Out-Null
        Set-PnPList -Identity $ListName -Description $Description -ErrorAction SilentlyContinue | Out-Null
        Write-Host "[OK] Lista creada: $ListName" -ForegroundColor Green
        $script:CreatedOk++
        return $true
    } catch {
        Write-Host "[ERROR] No se pudo crear lista $ListName : $($_.Exception.Message)" -ForegroundColor Red
        $script:ErrorCount++
        return $false
    }
}

# ==========================================================================
# FUNCION AUXILIAR: Agregar campo con idempotencia
# ==========================================================================
function Ensure-Field {
    param(
        [string]$ListName,
        [string]$FieldName,
        [string]$FieldType,       # Text | Number | DateTime | Boolean | Choice | Note
        [bool]$Required = $false,
        [bool]$Indexed  = $false,
        [string]$Choices = "",    # Separado por | para tipo Choice
        [int]$MaxLength  = 255,
        [int]$Decimals   = -1
    )
    $existing = Get-PnPField -List $ListName -Identity $FieldName -ErrorAction SilentlyContinue
    if ($existing) { return }

    try {
        switch ($FieldType) {
            "Text" {
                $f = Add-PnPField -List $ListName -DisplayName $FieldName -InternalName $FieldName `
                     -Type Text -AddToDefaultView -ErrorAction Stop
                if ($MaxLength -ne 255) {
                    Set-PnPField -List $ListName -Identity $FieldName -Values @{MaxLength=$MaxLength} -ErrorAction SilentlyContinue | Out-Null
                }
            }
            "Note" {
                $f = Add-PnPField -List $ListName -DisplayName $FieldName -InternalName $FieldName `
                     -Type Note -AddToDefaultView -ErrorAction Stop
            }
            "Number" {
                $f = Add-PnPField -List $ListName -DisplayName $FieldName -InternalName $FieldName `
                     -Type Number -AddToDefaultView -ErrorAction Stop
                if ($Decimals -ge 0) {
                    Set-PnPField -List $ListName -Identity $FieldName -Values @{DisplayFormat=$Decimals} -ErrorAction SilentlyContinue | Out-Null
                }
            }
            "DateTime" {
                $f = Add-PnPField -List $ListName -DisplayName $FieldName -InternalName $FieldName `
                     -Type DateTime -AddToDefaultView -ErrorAction Stop
            }
            "Boolean" {
                $f = Add-PnPField -List $ListName -DisplayName $FieldName -InternalName $FieldName `
                     -Type Boolean -AddToDefaultView -ErrorAction Stop
            }
            "Choice" {
                $choiceArray = $Choices -split "\|"
                $f = Add-PnPField -List $ListName -DisplayName $FieldName -InternalName $FieldName `
                     -Type Choice -Choices $choiceArray -AddToDefaultView -ErrorAction Stop
            }
        }

        if ($Required) {
            Set-PnPField -List $ListName -Identity $FieldName -Values @{Required=$true} -ErrorAction SilentlyContinue | Out-Null
        }
        if ($Indexed) {
            Set-PnPField -List $ListName -Identity $FieldName -Values @{Indexed=$true} -ErrorAction SilentlyContinue | Out-Null
        }
        Write-Host "  [CAMPO OK] $ListName.$FieldName ($FieldType)" -ForegroundColor Cyan

    } catch {
        Write-Host "  [CAMPO ERROR] $ListName.$FieldName : $($_.Exception.Message)" -ForegroundColor Red
        $script:ErrorCount++
    }
}


# ==========================================================================
# LISTA 1: Fiscal_MovimientosCaja
# Origen Wix: MovimientosCaja | Normativa: SIF/Verifactu | Retencion: 4 anos
# ==========================================================================
Write-Host "`n>>> Lista 1/7: Fiscal_MovimientosCaja" -ForegroundColor Magenta
Ensure-List "Fiscal_MovimientosCaja" "Replica SIF de MovimientosCaja Wix. Retencion 4 anos. RD 1007/2023."

Ensure-Field "Fiscal_MovimientosCaja" "wixItemId"          "Text"    $true  $true  "" 255
Ensure-Field "Fiscal_MovimientosCaja" "secuenciaNumero"    "Number"  $true  $false "" -1 0
Ensure-Field "Fiscal_MovimientosCaja" "facturaNumero"      "Text"    $true  $true  "" 100
Ensure-Field "Fiscal_MovimientosCaja" "operacionFecha"     "Text"    $true  $true  "" 20
Ensure-Field "Fiscal_MovimientosCaja" "fiscalPeriodo"      "Text"    $true  $true  "" 10
Ensure-Field "Fiscal_MovimientosCaja" "movimientoTipo"     "Choice"  $true  $true  "VENTA_EFECTIVO|VENTA_TARJETA|VENTA_BIZUM|VENTA_ONLINE|DEVOLUCION|AJUSTE"
Ensure-Field "Fiscal_MovimientosCaja" "pagoMetodo"         "Choice"  $true  $true  "EFECTIVO|TARJETA|BIZUM|ONLINE|OTRO"
Ensure-Field "Fiscal_MovimientosCaja" "totalCantidad"      "Number"  $true  $false "" 2
Ensure-Field "Fiscal_MovimientosCaja" "gravableCantidad"   "Number"  $true  $false "" 2
Ensure-Field "Fiscal_MovimientosCaja" "impuestoCantidad"   "Number"  $true  $false "" 2
Ensure-Field "Fiscal_MovimientosCaja" "impuestoTasa"       "Number"  $true  $false "" 4
Ensure-Field "Fiscal_MovimientosCaja" "previousRecordHash" "Text"    $true  $false "" 255
Ensure-Field "Fiscal_MovimientosCaja" "currentRecordHash"  "Text"    $true  $false "" 255
Ensure-Field "Fiscal_MovimientosCaja" "digitalSignature"   "Text"    $true  $false "" 255
Ensure-Field "Fiscal_MovimientosCaja" "clienteNif"         "Text"    $false $false "" 20
Ensure-Field "Fiscal_MovimientosCaja" "clienteNombre"      "Text"    $false $false "" 100
Ensure-Field "Fiscal_MovimientosCaja" "linkedBookingId"    "Text"    $false $true  "" 100
Ensure-Field "Fiscal_MovimientosCaja" "resourceId"         "Text"    $false $true  "" 100
Ensure-Field "Fiscal_MovimientosCaja" "trazaId"            "Text"    $true  $true  "" 100


# ==========================================================================
# LISTA 2: Fiscal_CierresZ
# Origen Wix: HistoricoCierresZ | Normativa: SIF/Verifactu | Retencion: 4 anos
# ==========================================================================
Write-Host "`n>>> Lista 2/7: Fiscal_CierresZ" -ForegroundColor Magenta
Ensure-List "Fiscal_CierresZ" "Replica cierres Z diarios de Wix. Retencion 4 anos. RD 1007/2023."

Ensure-Field "Fiscal_CierresZ" "wixItemId"                 "Text"    $true  $true  "" 255
Ensure-Field "Fiscal_CierresZ" "operacionFecha"            "Text"    $true  $true  "" 20
Ensure-Field "Fiscal_CierresZ" "cierreEstado"              "Choice"  $true  $false "CERRADO|PARCIAL|ERROR"
Ensure-Field "Fiscal_CierresZ" "consolidadoTotalCantidad"  "Number"  $true  $false "" 2
Ensure-Field "Fiscal_CierresZ" "brutasVentasTotal"         "Number"  $true  $false "" 2
Ensure-Field "Fiscal_CierresZ" "netaGravableCantidad"      "Number"  $true  $false "" 2
Ensure-Field "Fiscal_CierresZ" "netaImpuestoCantidad"      "Number"  $true  $false "" 2
Ensure-Field "Fiscal_CierresZ" "totalEfectivo"             "Number"  $true  $false "" 2
Ensure-Field "Fiscal_CierresZ" "totalTarjeta"              "Number"  $true  $false "" 2
Ensure-Field "Fiscal_CierresZ" "totalBizum"                "Number"  $true  $false "" 2
Ensure-Field "Fiscal_CierresZ" "totalOnline"               "Number"  $true  $false "" 2
Ensure-Field "Fiscal_CierresZ" "totalDevoluciones"         "Number"  $true  $false "" 2
Ensure-Field "Fiscal_CierresZ" "totalOperaciones"          "Number"  $true  $false "" 0
Ensure-Field "Fiscal_CierresZ" "inicioRegistroHash"        "Text"    $true  $false "" 255
Ensure-Field "Fiscal_CierresZ" "finRegistroHash"           "Text"    $true  $false "" 255
Ensure-Field "Fiscal_CierresZ" "cierreHash"                "Text"    $true  $false "" 255
Ensure-Field "Fiscal_CierresZ" "cierreFirma"               "Text"    $true  $false "" 255
Ensure-Field "Fiscal_CierresZ" "rutaPdfSharePoint"         "Text"    $false $false "" 500
Ensure-Field "Fiscal_CierresZ" "trazaId"                   "Text"    $true  $true  "" 100


# ==========================================================================
# LISTA 3: Fiscal_EventosSIF
# Origen Wix: EventosSistemaFacturacion | Normativa: RD 1007/2023 | Retencion: 4 anos
# ==========================================================================
Write-Host "`n>>> Lista 3/7: Fiscal_EventosSIF" -ForegroundColor Magenta
Ensure-List "Fiscal_EventosSIF" "Auditoria de eventos SIF de Wix. Retencion 4 anos. RD 1007/2023."

Ensure-Field "Fiscal_EventosSIF" "wixItemId"          "Text"     $true  $true  "" 255
Ensure-Field "Fiscal_EventosSIF" "sistemaEventoId"    "Text"     $true  $true  "" 100
Ensure-Field "Fiscal_EventosSIF" "eventoFechaHora"    "DateTime" $true  $true
Ensure-Field "Fiscal_EventosSIF" "eventoTipo"         "Choice"   $true  $true  "INVOICE_ISSUED|INVOICE_VOIDED|Z_CLOSING_COMPLETED|SYSTEM_ERROR|HASH_CHAIN_BROKEN|CASH_OPENING|REFUND_ISSUED|STOCK_MOVEMENT|STOCK_ADJUSTMENT"
Ensure-Field "Fiscal_EventosSIF" "severidadEvento"    "Choice"   $true  $false "INFO|WARNING|ERROR|CRITICO"
Ensure-Field "Fiscal_EventosSIF" "resultadoEvento"    "Choice"   $true  $false "OK|FAIL|PENDING"
Ensure-Field "Fiscal_EventosSIF" "eventoOrigen"       "Text"     $false $false "" 100
Ensure-Field "Fiscal_EventosSIF" "responsableUsuarioId" "Text"   $false $false "" 100
Ensure-Field "Fiscal_EventosSIF" "responsableMiembroId" "Text"   $false $false "" 100
Ensure-Field "Fiscal_EventosSIF" "previoEventoHash"   "Text"     $false $false "" 255
Ensure-Field "Fiscal_EventosSIF" "eventoHash"         "Text"     $true  $false "" 255
Ensure-Field "Fiscal_EventosSIF" "eventoFirma"        "Text"     $true  $false "" 255
Ensure-Field "Fiscal_EventosSIF" "trazaId"            "Text"     $true  $true  "" 100


# ==========================================================================
# LISTA 4: Laboral_Horarios
# Origen Wix: RegistrosHorariosStaff | Normativa: Art.34.9 ET | Retencion: 4 anos
# ==========================================================================
Write-Host "`n>>> Lista 4/7: Laboral_Horarios" -ForegroundColor Magenta
Ensure-List "Laboral_Horarios" "Registro jornada laboral staff. Retencion 4 anos. Art.34.9 ET."

Ensure-Field "Laboral_Horarios" "wixItemId"              "Text"     $true  $true  "" 255
Ensure-Field "Laboral_Horarios" "recursoId"              "Text"     $true  $true  "" 100
Ensure-Field "Laboral_Horarios" "nombreStaff"            "Text"     $true  $true  "" 100
Ensure-Field "Laboral_Horarios" "staffMiembroId"         "Text"     $false $false "" 100
Ensure-Field "Laboral_Horarios" "registradoFecha"        "DateTime" $true  $true
Ensure-Field "Laboral_Horarios" "diaClave"               "Text"     $true  $true  "" 20
Ensure-Field "Laboral_Horarios" "mesClave"               "Text"     $true  $true  "" 10
Ensure-Field "Laboral_Horarios" "fichajeEventoTipo"      "Choice"   $true  $true  "ENTRADA|SALIDA|PAUSA_INICIO|PAUSA_FIN|AJUSTE"
Ensure-Field "Laboral_Horarios" "registradoPor"         "Choice"   $true  $false "SELF|ADMIN|SISTEMA|AJUSTE_MANUAL"
Ensure-Field "Laboral_Horarios" "registradoPorMiembroId" "Text"    $false $false "" 100
Ensure-Field "Laboral_Horarios" "ajusteMotivo"           "Note"    $false $false
Ensure-Field "Laboral_Horarios" "firmaHorario"           "Text"    $true  $false "" 255
Ensure-Field "Laboral_Horarios" "rutaPdfMensual"         "Text"    $false $false "" 500
Ensure-Field "Laboral_Horarios" "trazaId"                "Text"    $true  $true  "" 100


# ==========================================================================
# LISTA 5: Contable_Asientos
# Origen Wix: AsientosContables | Normativa: PGC / Codigo Comercio | Retencion: 6 anos
# ==========================================================================
Write-Host "`n>>> Lista 5/7: Contable_Asientos" -ForegroundColor Magenta
Ensure-List "Contable_Asientos" "Replica asientos contables partida doble. Retencion 6 anos. PGC."

Ensure-Field "Contable_Asientos" "wixItemId"       "Text"     $true  $true  "" 255
Ensure-Field "Contable_Asientos" "asientoNumero"   "Text"     $true  $true  "" 50
Ensure-Field "Contable_Asientos" "asientoFecha"    "DateTime" $true  $true
Ensure-Field "Contable_Asientos" "asientoEstado"   "Choice"   $true  $true  "DRAFT|POSTED|LOCKED|ANULADO"
Ensure-Field "Contable_Asientos" "asientoConcepto" "Note"     $true  $false
Ensure-Field "Contable_Asientos" "totalDebe"       "Number"   $true  $false "" 2
Ensure-Field "Contable_Asientos" "totalHaber"      "Number"   $true  $false "" 2
Ensure-Field "Contable_Asientos" "semanaKey"       "Text"     $false $true  "" 10
Ensure-Field "Contable_Asientos" "trimestreKey"    "Text"     $false $true  "" 10
Ensure-Field "Contable_Asientos" "asientoHash"     "Text"     $true  $false "" 255
Ensure-Field "Contable_Asientos" "asientoFirma"    "Text"     $true  $false "" 255
Ensure-Field "Contable_Asientos" "trazaId"         "Text"     $true  $true  "" 100


# ==========================================================================
# LISTA 6: Contable_LibroIVA
# Origen Wix: LibroIVAFacturasExpedidas + LibroIVAFacturasRecibidas
# Normativa: Ley 37/1992 IVA | Retencion: 4 anos
# ==========================================================================
Write-Host "`n>>> Lista 6/7: Contable_LibroIVA" -ForegroundColor Magenta
Ensure-List "Contable_LibroIVA" "Libros registro IVA expedidas y recibidas. Retencion 4 anos. Ley 37/1992."

Ensure-Field "Contable_LibroIVA" "wixItemId"         "Text"     $true  $true  "" 255
Ensure-Field "Contable_LibroIVA" "libroTipo"         "Choice"   $true  $true  "EXPEDIDA|RECIBIDA"
Ensure-Field "Contable_LibroIVA" "facturaNumero"     "Text"     $true  $true  "" 100
Ensure-Field "Contable_LibroIVA" "operacionFecha"    "DateTime" $true  $true
Ensure-Field "Contable_LibroIVA" "fiscalPeriodo"     "Text"     $true  $true  "" 10
Ensure-Field "Contable_LibroIVA" "contraparteNif"    "Text"     $false $true  "" 20
Ensure-Field "Contable_LibroIVA" "contraparteNombre" "Text"     $false $false "" 150
Ensure-Field "Contable_LibroIVA" "baseImponible"     "Number"   $true  $false "" 2
Ensure-Field "Contable_LibroIVA" "cuotaIVA"          "Number"   $true  $false "" 2
Ensure-Field "Contable_LibroIVA" "ivaTipo"           "Choice"   $true  $false "0.21|0.10|0.04|0.00"
Ensure-Field "Contable_LibroIVA" "trazaId"           "Text"     $true  $true  "" 100


# ==========================================================================
# LISTA 7: RGPD_Consentimientos
# Origen Wix: ConsentimientosRGPD (NUEVA) | Normativa: RGPD Art.7 / LOPDGDD
# Retencion: Vigencia del consentimiento + 5 anos tras revocacion
# ==========================================================================
Write-Host "`n>>> Lista 7/7: RGPD_Consentimientos" -ForegroundColor Magenta
Ensure-List "RGPD_Consentimientos" "Registro consentimientos explicitos RGPD. RGPD Art.7 / LOPDGDD."

Ensure-Field "RGPD_Consentimientos" "wixItemId"           "Text"     $true  $true  "" 255
Ensure-Field "RGPD_Consentimientos" "contactoId"          "Text"     $true  $true  "" 100
Ensure-Field "RGPD_Consentimientos" "finalidad"           "Choice"   $true  $true  "MARKETING|SALUD|RECORDATORIOS|COMUNICACIONES|CESION_DATOS"
Ensure-Field "RGPD_Consentimientos" "consentimientoDado"  "Boolean"  $true  $false
Ensure-Field "RGPD_Consentimientos" "fechaConsentimiento" "DateTime" $true  $true
Ensure-Field "RGPD_Consentimientos" "ipConsentimiento"    "Text"     $false $false "" 50
Ensure-Field "RGPD_Consentimientos" "textoLegalVersion"   "Text"     $true  $false "" 20
Ensure-Field "RGPD_Consentimientos" "revocado"            "Boolean"  $false $false
Ensure-Field "RGPD_Consentimientos" "fechaRevocacion"     "DateTime" $false $false
Ensure-Field "RGPD_Consentimientos" "rutaPdfSharePoint"   "Text"     $false $false "" 500
Ensure-Field "RGPD_Consentimientos" "trazaId"             "Text"     $true  $true  "" 100


# ==========================================================================
# CONFIGURAR VISTA POR DEFECTO: hacer Title invisible (no tiene sentido semantico)
# y activar versionado en todas las listas para inmutabilidad
# ==========================================================================
Write-Host "`n>>> Configurando versionado en las 7 listas..." -ForegroundColor Magenta
$listas = @(
    "Fiscal_MovimientosCaja",
    "Fiscal_CierresZ",
    "Fiscal_EventosSIF",
    "Laboral_Horarios",
    "Contable_Asientos",
    "Contable_LibroIVA",
    "RGPD_Consentimientos"
)

foreach ($lista in $listas) {
    try {
        Set-PnPList -Identity $lista -EnableVersioning $true -ErrorAction Stop | Out-Null
        Write-Host "  [VERSIONADO OK] $lista" -ForegroundColor Cyan
    } catch {
        Write-Host "  [VERSIONADO WARN] $lista : $($_.Exception.Message)" -ForegroundColor Yellow
    }
}


# ==========================================================================
# RESUMEN FINAL
# ==========================================================================
Write-Host ""
Write-Host "=============================================" -ForegroundColor White
Write-Host "  RESUMEN FINAL - Crear-Listas-SharePoint   " -ForegroundColor White
Write-Host "=============================================" -ForegroundColor White
Write-Host "  Listas/campos creados : $CreatedOk"  -ForegroundColor Green
Write-Host "  Listas/campos omitidos: $SkippedOk"  -ForegroundColor Yellow
Write-Host "  Errores               : $ErrorCount"  -ForegroundColor Red
Write-Host ""
Write-Host "PROXIMOS PASOS OBLIGATORIOS:" -ForegroundColor Cyan
Write-Host "  1. Ejecutar Configurar-Permisos-SoloAppend.ps1"
Write-Host "  2. Configurar retenciones en Microsoft Purview:"
Write-Host "     - 4 anos: Fiscal_MovimientosCaja, Fiscal_CierresZ,"
Write-Host "               Fiscal_EventosSIF, Laboral_Horarios, Contable_LibroIVA"
Write-Host "     - 6 anos: Contable_Asientos"
Write-Host "     - Vigencia+5a: RGPD_Consentimientos"
Write-Host "  3. Crear Service Principal Wix en Azure AD con permiso solo-append"
Write-Host "  4. Configurar Power Automate flows (5 flujos de sincronizacion)"
Write-Host ""
Write-Host "NORMA AS-07: Este script no certifica cumplimiento legal." -ForegroundColor DarkYellow
Write-Host "Validacion final: asesoria fiscal + laboral + DPO externo." -ForegroundColor DarkYellow

Disconnect-PnPOnline
