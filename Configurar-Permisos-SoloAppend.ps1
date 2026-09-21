# ==============================================================================
# SCRIPT: Configurar-Permisos-SoloAppend.ps1
# SSOT v5002.6 | G10 ASCII Strict | Marian Madrid Peluqueria y Estetica
# Rompe herencia y asigna permisos granulares en las 7 listas + biblioteca
# EJECUTAR DESPUES de Crear-Listas-SharePoint.ps1
# Normativa: RGPD (acceso minimo) | SIF (inmutabilidad replica)
# ==============================================================================

$SiteUrl        = "https://marianmadrid.sharepoint.com/sites/marianmadrid_intranet"
$PropietariaUPN = "marian@marianmadrid.onmicrosoft.com"
$AdminUPN       = "admin@marianmadrid.es"

# UPN del gestor/asesoria externa: ajustar antes de ejecutar
$GestorUPN      = "gestor@asesoria.es"

$Listas = @(
    "Fiscal_MovimientosCaja",
    "Fiscal_CierresZ",
    "Fiscal_EventosSIF",
    "Laboral_Horarios",
    "Contable_Asientos",
    "Contable_LibroIVA",
    "RGPD_Consentimientos"
)

try {
    Connect-PnPOnline -Url $SiteUrl -Interactive
    Write-Host "[OK] Conexion establecida." -ForegroundColor Green
} catch {
    Write-Host "[ERROR FATAL] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

foreach ($lista in $Listas) {
    Write-Host "`n>>> Configurando permisos: $lista" -ForegroundColor Magenta
    try {
        # 1. Romper herencia de permisos (sin copiar los del sitio padre)
        Set-PnPListPermission -Identity $lista -InheritPermissions $false -ErrorAction Stop | Out-Null
        Write-Host "  [OK] Herencia rota." -ForegroundColor Green

        # 2. Propietaria: Control total
        Set-PnPListPermission -Identity $lista -User $PropietariaUPN -AddRole "Full Control" -ErrorAction SilentlyContinue | Out-Null
        Set-PnPListPermission -Identity $lista -User $AdminUPN       -AddRole "Full Control" -ErrorAction SilentlyContinue | Out-Null
        Write-Host "  [OK] Control total: $PropietariaUPN + $AdminUPN" -ForegroundColor Green

        # 3. Gestor/Asesoria: Solo lectura
        Set-PnPListPermission -Identity $lista -User $GestorUPN -AddRole "Read" -ErrorAction SilentlyContinue | Out-Null
        Write-Host "  [OK] Solo lectura: $GestorUPN" -ForegroundColor Green

        Write-Host "  [INFO] Service Principal Wix (solo-append) configurar manualmente" -ForegroundColor Yellow
        Write-Host "         en Azure AD: Aplicar nivel de permiso personalizado 'Append'" -ForegroundColor Yellow

    } catch {
        Write-Host "  [ERROR] $lista : $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "[INFO] PASO MANUAL REQUERIDO - Service Principal Wix:" -ForegroundColor Cyan
Write-Host "  1. Azure AD > Registros de aplicaciones > Nueva: WixM365SyncApp"
Write-Host "  2. API Permissions: Sites.Selected (SharePoint) - tipo Application"
Write-Host "  3. En cada lista SharePoint: conceder permiso 'Contribute' al SP"
Write-Host "     pero con nivel personalizado que QUITE 'Eliminar elementos'"
Write-Host "  4. Guardar Client ID + Secret en Wix Secrets Manager:"
Write-Host "     SECRET_M365_CLIENT_ID, SECRET_M365_CLIENT_SECRET, SECRET_M365_TENANT_ID"
Write-Host ""
Write-Host "NORMA AS-07: Validacion legal corresponde a asesoria externa." -ForegroundColor DarkYellow

Disconnect-PnPOnline
