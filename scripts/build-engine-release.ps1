# 엔진 릴리스 패키징: PyInstaller 빌드 → ffmpeg 포함 스테이징 → zip → 파트 분할 + SHA256 매니페스트
# 사용: powershell -ExecutionPolicy Bypass -File scripts\build-engine-release.ps1 [-SkipBuild]
param(
  [int]$EngineVersion = 3,
  [ValidateRange(1MB, 100GB)][long]$PartSize = 1900MB,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root 'python'

Write-Host '=== 사전 검증 ==='
$free = (Get-Item $root).PSDrive.Free
if ($null -ne $free -and $free -lt 25GB) { throw '디스크 여유 공간 부족 (최소 25GB 필요)' }
foreach ($f in 'ffmpeg.exe', 'ffprobe.exe') {
  if (-not (Test-Path (Join-Path $root "bin\$f"))) { throw "bin\$f 없음 — ffmpeg 바이너리를 bin\ 에 배치하세요" }
}
$tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path $tarExe)) { throw 'tar.exe 없음 (Windows 10 17063+ / 64비트 PowerShell에서 실행하세요)' }
$pyinstaller = Join-Path $py '.venv\Scripts\pyinstaller.exe'
if (-not $SkipBuild -and -not (Test-Path $pyinstaller)) {
  throw "pyinstaller.exe 없음: $pyinstaller — scripts\setup.bat으로 venv를 준비하세요"
}

if (-not $SkipBuild) {
  Write-Host '=== PyInstaller 빌드 ==='
  Push-Location $py
  try {
    & $pyinstaller --noconfirm process_video.spec
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  if ($code -ne 0) { throw "PyInstaller 실패 (exit $code)" }
}

$dist = Join-Path $py 'dist\process_video'
if (-not (Test-Path (Join-Path $dist 'process_video.exe'))) { throw '빌드 산출물 없음: python\dist\process_video' }

Write-Host '=== 페이로드 검증 ==='
foreach ($m in 'crisperwhisper', 'transformers', 'whisper', '_soundfile_data', 'nvidia\cublas', 'nvidia\cudnn') {
  if (-not (Test-Path (Join-Path $dist "_internal\$m"))) {
    throw "엔진 v$EngineVersion 페이로드 누락: _internal\$m — 스테일 빌드이거나 spec 수집 실패. -SkipBuild 없이 재빌드하세요."
  }
}

Write-Host '=== 스테이징 (ffmpeg 포함) ==='
$staging = Join-Path $root "dist-engine\engine-v$EngineVersion-staging"
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force $staging | Out-Null
Copy-Item -Recurse (Join-Path $dist '*') $staging
Copy-Item (Join-Path $root 'bin\ffmpeg.exe') $staging
Copy-Item (Join-Path $root 'bin\ffprobe.exe') $staging

Write-Host '=== 압축 (tar) ==='
$outDir = Join-Path $root "dist-engine\engine-v$EngineVersion-release"
if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
New-Item -ItemType Directory -Force $outDir | Out-Null
$zip = Join-Path $outDir 'engine.zip'
Push-Location $staging
try {
  & $tarExe -a -c -f $zip *
  $code = $LASTEXITCODE
} finally { Pop-Location }
if ($code -ne 0) { throw "tar 압축 실패 (exit $code)" }
Remove-Item -Recurse -Force $staging

Write-Host '=== 파트 분할 + SHA256 매니페스트 ==='
$zipHash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
$zipSize = (Get-Item $zip).Length
$parts = @()
$in = [System.IO.File]::OpenRead($zip)
try {
  $buf = New-Object byte[] (8MB)
  $idx = 0
  while ($in.Position -lt $in.Length) {
    $idx++
    $name = 'engine.zip.{0:d3}' -f $idx
    $dest = Join-Path $outDir $name
    $out = [System.IO.File]::Create($dest)
    try {
      $written = 0L
      while ($written -lt $PartSize -and $in.Position -lt $in.Length) {
        $toRead = [int][Math]::Min([long]$buf.Length, $PartSize - $written)
        $n = $in.Read($buf, 0, $toRead)
        if ($n -le 0) { break }
        $out.Write($buf, 0, $n)
        $written += $n
      }
    } finally { $out.Close() }
    $item = [ordered]@{
      name   = $name
      size   = (Get-Item $dest).Length
      sha256 = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLower()
    }
    $parts += [pscustomobject]$item
    Write-Host ("  {0}: {1:N0} bytes" -f $name, (Get-Item $dest).Length)
  }
} finally { $in.Close() }
Remove-Item $zip

$manifest = [ordered]@{
  version   = $EngineVersion
  totalSize = $zipSize
  zipSha256 = $zipHash
  parts     = $parts
}
$manifestPath = Join-Path $outDir 'engine-manifest.json'
$manifest | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 $manifestPath

Write-Host ''
Write-Host "완료: $outDir"
Write-Host "업로드: GitHub Release 태그 engine-v$EngineVersion 에 engine-manifest.json + engine.zip.* 업로드"
Write-Host '주의: 앱 릴리스(v1.8.0)보다 엔진 릴리스 업로드가 먼저여야 합니다.'
