param(
  [ValidateSet('status', 'apply')]
  [string]$Action,
  [ValidateSet('stream_only', 'stream_and_media', 'media_only')]
  [string]$Mode = 'stream_and_media',
  [string]$DllPath = '',
  [ValidatePattern('^Strip\[\d+\]$')]
  [string]$InputStrip = 'Strip[0]'
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-VoiceMeeterResult([hashtable]$Result) {
  $Result | ConvertTo-Json -Compress
}

function Resolve-VoiceMeeterDllPath([string]$ConfiguredPath) {
  if (-not [string]::IsNullOrWhiteSpace($ConfiguredPath)) {
    return $ConfiguredPath.Trim()
  }

  $candidates = @()
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not [string]::IsNullOrWhiteSpace($root)) {
      $candidates += (Join-Path $root 'VB\Voicemeeter\VoicemeeterRemote64.dll')
    }
  }
  $candidates += 'D:\2-2-Other\VoiceMeeter\VoicemeeterRemote64.dll'

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  return ''
}

$resolvedDllPath = Resolve-VoiceMeeterDllPath $DllPath
if ([string]::IsNullOrWhiteSpace($resolvedDllPath) -or -not (Test-Path -LiteralPath $resolvedDllPath -PathType Leaf)) {
  Write-VoiceMeeterResult @{ ok = $false; A1 = 0; B1 = 0; inputStrip = $InputStrip; error = 'VoiceMeeter Remote DLL not found.' }
  exit 0
}
if ([System.IO.Path]::GetExtension($resolvedDllPath) -ne '.dll') {
  Write-VoiceMeeterResult @{ ok = $false; A1 = 0; B1 = 0; inputStrip = $InputStrip; error = 'VoiceMeeter Remote path must be a DLL.' }
  exit 0
}

$escapedDllPath = $resolvedDllPath.Replace('"', '""')
$source = @"
using System;
using System.Runtime.InteropServices;
public static class VoiceMeeterRemote {
  [DllImport(@"$escapedDllPath", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
  public static extern int VBVMR_Login();
  [DllImport(@"$escapedDllPath", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
  public static extern int VBVMR_Logout();
  [DllImport(@"$escapedDllPath", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
  public static extern int VBVMR_SetParameterFloat(string name, float value);
  [DllImport(@"$escapedDllPath", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
  public static extern int VBVMR_GetParameterFloat(string name, out float value);
}
"@

$loggedIn = $false
$result = @{ ok = $false; A1 = 0; B1 = 0; inputStrip = $InputStrip; error = '' }
try {
  Add-Type -TypeDefinition $source -ErrorAction Stop
  $loginCode = [VoiceMeeterRemote]::VBVMR_Login()
  if ($loginCode -ne 0) {
    $result.error = "VoiceMeeter login failed ($loginCode)."
  } else {
    $loggedIn = $true
    $routes = @{
      stream_only = @{ A1 = 0; B1 = 1 }
      stream_and_media = @{ A1 = 1; B1 = 1 }
      media_only = @{ A1 = 1; B1 = 0 }
    }
    if ($Action -eq 'apply') {
      $route = $routes[$Mode]
      $a1SetCode = [VoiceMeeterRemote]::VBVMR_SetParameterFloat("$InputStrip.A1", [single]$route.A1)
      $b1SetCode = [VoiceMeeterRemote]::VBVMR_SetParameterFloat("$InputStrip.B1", [single]$route.B1)
      if ($a1SetCode -ne 0 -or $b1SetCode -ne 0) {
        $result.error = "VoiceMeeter route update failed ($a1SetCode, $b1SetCode)."
      }
    }

    if ([string]::IsNullOrWhiteSpace($result.error)) {
      [single]$a1 = 0
      [single]$b1 = 0
      $a1GetCode = [VoiceMeeterRemote]::VBVMR_GetParameterFloat("$InputStrip.A1", [ref]$a1)
      $b1GetCode = [VoiceMeeterRemote]::VBVMR_GetParameterFloat("$InputStrip.B1", [ref]$b1)
      if ($a1GetCode -ne 0 -or $b1GetCode -ne 0) {
        $result.error = "VoiceMeeter route read failed ($a1GetCode, $b1GetCode)."
      } else {
        $result.ok = $true
        $result.A1 = if ($a1 -ge 0.5) { 1 } else { 0 }
        $result.B1 = if ($b1 -ge 0.5) { 1 } else { 0 }
      }
    }
  }
} catch {
  $result.error = $_.Exception.Message
} finally {
  if ($loggedIn) {
    [void][VoiceMeeterRemote]::VBVMR_Logout()
  }
}

Write-VoiceMeeterResult $result
