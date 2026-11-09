<#
.SYNOPSIS
  一键构建或配置 ComfyUI AI Prompt Studio Android APK。

.DESCRIPTION
  1. 允许指定 ComfyUI 运行端口或远程服务器 URL。
  2. 自动注入 AndroidManifest.xml 的 comfy_url 配置。
  3. 检测本地 Java 17+ 及 Gradle/Android 环境。
  4. 若具备 Gradle 环境，自动编译出 debug APK；若缺少，提供指引并支持在 Android Studio 直接打开构建。

.PARAMETER ComfyPort
  本地 ComfyUI 运行端口，默认为 8188。

.PARAMETER ServerUrl
  自定义服务地址（例如局域网 IP "http://192.168.1.100:8188/" 或模拟器地址 "http://10.0.2.2:8188/"）。
#>

param(
    [int]$ComfyPort = 8188,
    [string]$ServerUrl = ""
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " 📱 ComfyUI AI Prompt Studio APK Builder " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$androidDir = Join-Path $PSScriptRoot "android"
$manifestPath = Join-Path $androidDir "app\src\main\AndroidManifest.xml"

if (-not (Test-Path $manifestPath)) {
    Write-Error "未找到 AndroidManifest.xml: $manifestPath"
    exit 1
}

# 1. 确定服务 URL
if (-not $ServerUrl) {
    # 默认使用 Android 模拟器访问宿主机的回环地址 10.0.2.2
    $ServerUrl = "http://10.0.2.2:$ComfyPort/"
}
Write-Host "`n[1/4] 配置目标 ComfyUI 地址: $ServerUrl" -ForegroundColor Yellow

$manifest = Get-Content $manifestPath -Raw -Encoding utf8
$regex = '(?s)<meta-data\s+android:name="comfy_url".*?/>'
$replacement = "<meta-data`n            android:name=`"comfy_url`"`n            android:value=`"$ServerUrl`" />"
$manifest = [regex]::Replace($manifest, $regex, $replacement)
Set-Content -Path $manifestPath -Value $manifest -Encoding utf8
Write-Host "  -> 已成功写入 AndroidManifest.xml" -ForegroundColor Green

# 2. 检查 Java 环境
Write-Host "`n[2/4] 检查 Java 环境..." -ForegroundColor Yellow
$javaCmd = Get-Command java -ErrorAction SilentlyContinue
if ($javaCmd) {
    $javaVer = & java -version 2>&1 | Out-String
    Write-Host "  -> Java 已就绪: $($javaVer.Split([Environment]::NewLine)[0])" -ForegroundColor Green
} else {
    Write-Host "  [!] 未检测到系统 PATH 中的 Java，构建 APK 需要 Java 17 或以上版本。" -ForegroundColor DarkYellow
}

# 3. 检查构建工具并尝试构建
Write-Host "`n[3/4] 编译 APK..." -ForegroundColor Yellow
$gradlewBat = Join-Path $androidDir "gradlew.bat"
$gradleCmd = Get-Command gradle -ErrorAction SilentlyContinue

$builtSuccess = $false
if (Test-Path $gradlewBat) {
    Push-Location $androidDir
    try {
        & .\gradlew.bat assembleDebug
        if ($LASTEXITCODE -eq 0) { $builtSuccess = $true }
    } finally {
        Pop-Location
    }
} elseif ($gradleCmd) {
    Push-Location $androidDir
    try {
        & gradle assembleDebug
        if ($LASTEXITCODE -eq 0) { $builtSuccess = $true }
    } finally {
        Pop-Location
    }
} else {
    Write-Host "  提示: 本机暂无全局 gradle 命令或 gradlew.bat。" -ForegroundColor DarkCyan
}

# 4. 结果汇报与后续操作
Write-Host "`n[4/4] 结果指引" -ForegroundColor Yellow
$outApk = Join-Path $androidDir "app\build\outputs\apk\debug\app-debug.apk"
if ($builtSuccess -and (Test-Path $outApk)) {
    Write-Host "🎉 恭喜！APK 编译成功：" -ForegroundColor Green
    Write-Host "  路径: $outApk" -ForegroundColor White
    Write-Host "`n若手机已开启 USB 调试或模拟器已开启，运行以下命令即可安装：" -ForegroundColor Cyan
    Write-Host "  adb install -r `"$outApk`"" -ForegroundColor White
} else {
    Write-Host "📱 Android 项目模板已配置完毕！" -ForegroundColor Green
    Write-Host "您可以通过以下任一方式生成安装包：" -ForegroundColor Cyan
    Write-Host "  方式一：在 Android Studio 中直接打开项目目录即可一键 Run 或 Build APK：" -ForegroundColor White
    Write-Host "          $androidDir" -ForegroundColor Gray
    Write-Host "  方式二：安装 Android SDK 后在 android 目录运行: gradle assembleDebug" -ForegroundColor White
}
Write-Host "`n完成！" -ForegroundColor Cyan
