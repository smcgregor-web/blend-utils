# deploy_chain_link.ps1 - one link in an oracle-adapter delegation chain.
# Deploys a fresh instance of the proven oracle-adapter wasm, initializes it
# to delegate to $HeadAddr and price $TokenAddr locally at par ($1.00), then
# verifies via no-JSON reads (admin/glc_token/glc_mark). Paced + retried:
# testnet RPC lag after a fresh deploy is the established failure mode
# tonight, not a real failure - never trust "not found" without retrying.
#
# CORRECTED 2026-08-17 (bd osre-6ve, independent-review finding #1): this
# script used to hardcode $WASM_HASH to a specific, already-uploaded wasm
# (7d26d05...) and deploy+initialize as TWO SEPARATE transactions -- the
# exact front-runnable gap the osre-6ve fix closes everywhere else.
# Confirmed live against testnet that hash's interface was the PRE-FIX
# oracle-adapter (plain `initialize`, no `__constructor`) -- this script was
# still fully armed after every contract-source fix landed, and was
# documented in this directory's own OSRE_SCRIPTS.md as the PREFERRED tool
# over the (already-fixed) deploy_solo_adapter.mjs/deploy_note_adapter.mjs.
# Now deploys from the freshly-built, constructor-based wasm by PATH (same
# convention as deploy_property.ps1's $WASM_DIR) instead of a stale hash,
# with all four constructor args folded into the deploy call itself so
# deploy+construct is one atomic transaction, exactly like every other fixed
# deploy path in this repo.
#
# Usage: powershell -File deploy_chain_link.ps1 -HeadAddr <ADDR> -TokenAddr <ADDR> -Label <NAME> [-ExistingAdapter <ADDR>]
param(
  [Parameter(Mandatory=$true)][string]$HeadAddr,
  [Parameter(Mandatory=$true)][string]$TokenAddr,
  [Parameter(Mandatory=$true)][string]$Label,
  [string]$ExistingAdapter = ''
)

$WASM_PATH = "../Open Source Real Estate - Stellar/target/wasm32v1-none/release/osre_oracle_adapter.wasm"
if (-not (Test-Path $WASM_PATH)) {
  throw "$Label : oracle-adapter wasm not found at $WASM_PATH -- build it first: cargo build --release --target wasm32v1-none -p osre-oracle-adapter (from the OSRE repo root)"
}
$ADMIN_PUB = 'GDDUKD2REIFWTBM6BX2B2DAHASNJJYXHWGM3XHOSWA4OU76XDELYTXRL'
$STALENESS = '31536000'

function Invoke-WithRetry([string]$cmd, [int]$tries = 6, [int]$waitSec = 12) {
  for ($i = 1; $i -le $tries; $i++) {
    $out = cmd /c "$cmd 2>&1"
    $text = $out -join "`n"
    if ($text -match 'Transaction submitted successfully' -or $text -match '✅' -or $text -match '"price"' -or $text -match '"C[A-Z2-7]{55}"') { return $text }
    if ($text -match 'Contract not found' -or $text -match 'MissingValue' -or $text -match 'transaction submission timeout' `
        -or $text -match 'TxBadSeq' -or $text -match 'ResourceLimitExceeded' -or $text -match 'Error\(Contract, #2\)') {
      Write-Host "  (attempt $i/$tries transient: $($text.Substring(0, [Math]::Min(80,$text.Length))) - waiting ${waitSec}s)" -ForegroundColor DarkYellow
      Start-Sleep -Seconds $waitSec
      continue
    }
    return $text  # a real error (not a known-transient one) - surface immediately
  }
  return $text
}

if ($ExistingAdapter -ne '') {
  $adapter = $ExistingAdapter
  Write-Host "=== $Label : resuming existing adapter $adapter ===" -ForegroundColor Cyan
} else {
  Write-Host "=== $Label : deploy+construct (atomic) ===" -ForegroundColor Cyan
  $adapter = $null
  for ($d = 1; $d -le 5; $d++) {
    $deployOut = cmd /c "stellar contract deploy --wasm ""$WASM_PATH"" --source credit-admin --network testnet -- --admin $ADMIN_PUB --delegate $HeadAddr --glc_token $TokenAddr --max_staleness $STALENESS 2>&1"
    $deployOut | ForEach-Object { Write-Host $_ }
    $adapter = ($deployOut | Select-String -Pattern '^C[A-Z2-7]{55}$' | Select-Object -Last 1)
    if ($adapter) { $adapter = $adapter.ToString().Trim(); break }
    $joined = $deployOut -join "`n"
    if ($joined -match 'TxBadSeq' -or $joined -match 'transaction submission timeout' -or $joined -match 'ResourceLimitExceeded') {
      Write-Host "  (deploy attempt $d/5 transient - waiting 12s)" -ForegroundColor DarkYellow
      Start-Sleep -Seconds 12
      continue
    }
    break
  }
  if (-not $adapter) { throw "$Label : could not parse deployed contract id from output" }
  Write-Host "$Label ADAPTER: $adapter (deployed AND constructed in one call)" -ForegroundColor Green
  Write-Host "  settling 20s for RPC propagation..." -ForegroundColor DarkGray
  Start-Sleep -Seconds 20
}

Write-Host "=== $Label : set_max_change_bps ===" -ForegroundColor Cyan
$clampOut = Invoke-WithRetry "stellar contract invoke --id $adapter --source credit-admin --network testnet --send=yes -- set_max_change_bps --max_change_bps 0"
Write-Host $clampOut
Start-Sleep -Seconds 10

Write-Host "=== $Label : set_glc_price (par, `$1.00) ===" -ForegroundColor Cyan
$priceOut = Invoke-WithRetry "stellar contract invoke --id $adapter --source credit-admin --network testnet --send=yes -- set_glc_price --price 10000000"
Write-Host $priceOut

Start-Sleep -Seconds 15

Write-Host "=== $Label : verify (no-JSON reads) ===" -ForegroundColor Cyan
$adminOut = Invoke-WithRetry "stellar contract invoke --id $adapter --source credit-admin --network testnet -- admin" 5 12
$tokenOut = Invoke-WithRetry "stellar contract invoke --id $adapter --source credit-admin --network testnet -- glc_token" 5 12
$markOut  = Invoke-WithRetry "stellar contract invoke --id $adapter --source credit-admin --network testnet -- glc_mark" 5 12
Write-Host "admin: $adminOut"
Write-Host "glc_token: $tokenOut"
Write-Host "glc_mark: $markOut"

$adminOk = $adminOut -match [regex]::Escape($ADMIN_PUB)
$tokenOk = $tokenOut -match [regex]::Escape($TokenAddr)
$priceOk = $markOut -match '"price":"10000000"'

if ($adminOk -and $tokenOk -and $priceOk) {
  Write-Host "CHAIN LINK READY - $Label adapter = $adapter" -ForegroundColor Green
} else {
  Write-Host "CHECK OUTPUT - $Label adapter = $adapter (admin=$adminOk token=$tokenOk price=$priceOk)" -ForegroundColor Red
}
