# ProGuard rules for ComfyUI-AI-Prompt-Studio
# Keep WebView and JavaScript interfaces intact
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
