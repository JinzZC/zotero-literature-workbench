$ErrorActionPreference = "Stop"
$targetDirectory = Join-Path $PSScriptRoot "data"
$targetFile = Join-Path $targetDirectory "openai-key.dpapi"

New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
Clear-Host
Write-Host "文献工作台 · OpenAI API 密钥配置" -ForegroundColor Cyan
Write-Host ""
Write-Host "密钥输入时不会显示，也不会写入命令历史。"
Write-Host "保存文件使用 Windows DPAPI 加密，仅当前 Windows 用户可以解密。"
Write-Host ""

$secureKey = Read-Host "请输入 OpenAI Project API Key" -AsSecureString
if ($secureKey.Length -lt 20) {
  throw "输入内容过短，未保存。"
}

$secureKey | ConvertFrom-SecureString | Set-Content -LiteralPath $targetFile -Encoding ASCII
Write-Host ""
Write-Host "配置完成。可以关闭此窗口。" -ForegroundColor Green
Write-Host "密钥文件：data/openai-key.dpapi（DPAPI 密文）"
Read-Host "按 Enter 关闭"
