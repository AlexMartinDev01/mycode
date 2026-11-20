package com.lexics.academic;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.webkit.ValueCallback;

import androidx.webkit.WebViewAssetLoader;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends Activity implements TextToSpeech.OnInitListener {
    private static final int FILE_PICKER_REQUEST = 301;
    private static final int SAVE_BACKUP_REQUEST = 302;
    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private ValueCallback<Uri[]> pendingFileCallback;
    private String pendingExportJson;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(24,37,62));
        getWindow().setNavigationBarColor(Color.rgb(24,37,62));
        tts = new TextToSpeech(getApplicationContext(), this);
        assetLoader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(246,247,251));
        setContentView(webView);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setSupportZoom(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "无法打开该链接", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFileCallback != null) pendingFileCallback.onReceiveValue(null);
                pendingFileCallback = callback;
                try {
                    Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    picker.setType("application/json");
                    picker.addCategory(Intent.CATEGORY_OPENABLE);
                    picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivityForResult(picker, FILE_PICKER_REQUEST);
                } catch (ActivityNotFoundException ex) {
                    pendingFileCallback.onReceiveValue(null);
                    pendingFileCallback = null;
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
        });
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html");
    }

    private class AndroidBridge {
        @JavascriptInterface
        public void exportBackup(String json) {
            if (json == null || json.length() > 5000000) return;
            runOnUiThread(() -> {
                pendingExportJson = json;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.setType("application/json");
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                String stamp = new SimpleDateFormat("yyyyMMdd", Locale.US).format(new Date());
                intent.putExtra(Intent.EXTRA_TITLE, "LexiCS-backup-" + stamp + ".json");
                try {
                    startActivityForResult(intent, SAVE_BACKUP_REQUEST);
                } catch (Exception ex) {
                    pendingExportJson = null;
                    Toast.makeText(MainActivity.this, "无法打开保存对话框", Toast.LENGTH_SHORT).show();
                }
            });
        }
        @JavascriptInterface
        public void speak(String phrase) {
            if (phrase == null || phrase.length() > 3000) return;
            runOnUiThread(() -> {
                if (ttsReady && tts != null) {
                    tts.speak(phrase, TextToSpeech.QUEUE_FLUSH, null, "lexics-pronounce");
                } else {
                    Toast.makeText(MainActivity.this, "语音引擎尚未就绪", Toast.LENGTH_SHORT).show();
                }
            });
        }
    }

    @Override
    public void onInit(int status) {
        if (status == TextToSpeech.SUCCESS && tts != null) {
            ttsReady = tts.setLanguage(Locale.US) >= TextToSpeech.LANG_AVAILABLE;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_PICKER_REQUEST) {
            if (pendingFileCallback != null) {
                Uri[] selection = resultCode == RESULT_OK && data != null && data.getData() != null
                    ? new Uri[]{data.getData()} : null;
                pendingFileCallback.onReceiveValue(selection);
                pendingFileCallback = null;
            }
        } else if (requestCode == SAVE_BACKUP_REQUEST) {
            boolean saved = false;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingExportJson != null) {
                try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                    if (out != null) {
                        out.write(pendingExportJson.getBytes(StandardCharsets.UTF_8));
                        out.flush();
                        saved = true;
                    }
                } catch (Exception ignored) {
                    saved = false;
                }
            }
            pendingExportJson = null;
            if (resultCode == RESULT_OK) {
                Toast.makeText(this, saved ? "LexiCS 备份已保存" : "备份保存失败", Toast.LENGTH_SHORT).show();
            }
        }
    }

    @Override
    public void onBackPressed() {
        // This is a single-page offline application; the system back button closes it.
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (pendingFileCallback != null) {
            pendingFileCallback.onReceiveValue(null);
            pendingFileCallback = null;
        }
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
