package com.promptstudio.app;

import android.annotation.SuppressLint;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {
    private static final int FILE_CHOOSER_REQUEST_CODE = 1001;
    private static final String LOCAL_STUDIO_URL = "file:///android_asset/index.html";

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;

    public class PromptStudioBridge {
        @JavascriptInterface
        public void showToast(String message) {
            if (message == null) return;
            runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void copyText(String text) {
            if (text == null) return;
            runOnUiThread(() -> {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = ClipData.newPlainText("PromptStudio", text);
                if (clipboard != null) {
                    clipboard.setPrimaryClip(clip);
                    Toast.makeText(MainActivity.this, "已复制到剪贴板", Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void loadComfy(String url) {
            if (url == null || url.trim().isEmpty()) return;
            runOnUiThread(() -> {
                String target = url.trim();
                if (!target.startsWith("http://") && !target.startsWith("https://")) {
                    target = "http://" + target;
                }
                webView.loadUrl(target);
            });
        }

        @JavascriptInterface
        public void loadLocalStudio() {
            runOnUiThread(() -> webView.loadUrl(LOCAL_STUDIO_URL));
        }

        @JavascriptInterface
        public boolean isNativeApp() {
            return true;
        }
    }

    @SuppressLint({"SetJavaScriptEnabled"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        webView.addJavascriptInterface(new PromptStudioBridge(), "PromptStudioBridge");

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;

                Intent intent = params.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST_CODE);
                } catch (Exception e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "无法启动文件选择器: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame()) {
                    String url = request.getUrl().toString();
                    if (!url.startsWith("file:///android_asset/")) {
                        runOnUiThread(() -> {
                            Toast.makeText(MainActivity.this, "连接远程服务失败，已切换至独立工作台", Toast.LENGTH_LONG).show();
                            view.loadUrl(LOCAL_STUDIO_URL + "?error=comfy_unreachable");
                        });
                    }
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme) || "file".equalsIgnoreCase(scheme)) {
                    return false;
                }
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                    startActivity(intent);
                    return true;
                } catch (Exception ignored) {
                    return false;
                }
            }
        });

        // Always load standalone local asset by default
        webView.loadUrl(LOCAL_STUDIO_URL);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK && data != null) {
                    String dataString = data.getDataString();
                    ClipData clipData = data.getClipData();
                    if (clipData != null) {
                        results = new Uri[clipData.getItemCount()];
                        for (int i = 0; i < clipData.getItemCount(); i++) {
                            results[i] = clipData.getItemAt(i).getUri();
                        }
                    } else if (dataString != null) {
                        results = new Uri[]{Uri.parse(dataString)};
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            String url = webView.getUrl();
            if (url != null && !url.startsWith("file:///android_asset/")) {
                // If user is inside remote ComfyUI, return to local studio
                webView.loadUrl(LOCAL_STUDIO_URL);
                return;
            } else if (webView.canGoBack()) {
                webView.goBack();
                return;
            }
        }
        super.onBackPressed();
    }
}
