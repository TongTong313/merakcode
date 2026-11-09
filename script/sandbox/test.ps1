[CmdletBinding()]
param([switch]$External, [string]$OutputDirectory = '.cache/sandbox-ci')
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$output = Join-Path $root $OutputDirectory
[IO.Directory]::CreateDirectory($output) | Out-Null
$env:CGO_ENABLED = '0'
$env:MERAKCODE_SANDBOX_REQUIRED = '1'
$suffix = if ($IsWindows) { '.exe' } else { '' }
$packages = @(
    @{ Name = 'sandbox'; Path = './internal/platform/sandbox'; Tests = '.' },
    @{ Name = 'worker'; Path = './engine/worker'; Tests = 'Test(Windows|SandboxExternalWorker|ExternalWorkersRestore)' },
    @{ Name = 'tool'; Path = './engine/tool'; Tests = 'TestBash.*(Sandbox|Protect)' },
    @{ Name = 'engine'; Path = './engine'; Tests = 'Test(Windows|EngineSandbox|EngineBuiltinPreservesProtection|EngineRestoresMemberChanges)' }
)
if ($External) { $packages = @($packages[0]); $packages[0].Tests = '^TestSandboxExternalNetwork$' }
$tags = if ($External) { 'sandbox_integration,sandbox_external' } else { 'sandbox_integration' }
Push-Location (Join-Path $root 'merak')
try {
    foreach ($package in $packages) {
        $binary = Join-Path $output ($package.Name + '.test' + $suffix)
        & go test -c -tags $tags -o $binary $package.Path
        if ($LASTEXITCODE -ne 0) { throw "Build failed: $($package.Path)" }
        Push-Location $package.Path
        try {
            & $binary '-test.v' ('-test.run=' + $package.Tests) '-test.timeout=5m'
            if ($LASTEXITCODE -ne 0) { throw "Sandbox tests failed: $($package.Path)" }
        } finally { Pop-Location }
    }
} finally { Pop-Location }
