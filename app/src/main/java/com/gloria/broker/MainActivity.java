package com.gloria.broker;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.app.job.JobScheduler;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.CookieHandler;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;

public class MainActivity extends Activity {

    private static final String HOME = "https://appassets.androidplatform.net/assets/www/index.html";
    private static final String UA =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

    private WebView webView;
    private String pendingAsset;
    private boolean loaded;
    private final ExecutorService pool = Executors.newFixedThreadPool(6);
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Guarda las cookies entre peticiones (Yahoo las necesita para algunos datos).
        if (CookieHandler.getDefault() == null) {
            CookieHandler.setDefault(new CookieManager(null, CookiePolicy.ACCEPT_ALL));
        }
        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                loaded = true;
                openPending();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                // Los enlaces externos (noticias, documentos SEC) se abren en el navegador.
                startActivity(new Intent(Intent.ACTION_VIEW, u));
                return true;
            }
        });

        webView.addJavascriptInterface(new Bridge(), "NativeHttp");
        webView.addJavascriptInterface(new Notif(), "NativeNotif");
        pendingAsset = getIntent().getStringExtra("asset");
        webView.loadUrl(HOME);
        AlertJob.schedule(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        pendingAsset = intent.getStringExtra("asset");
        if (loaded) openPending();
    }

    /** Al tocar una notificación, abre ese activo. */
    private void openPending() {
        if (pendingAsset == null) return;
        String js = "window.openAsset && window.openAsset(" + JSONObject.quote(pendingAsset) + ")";
        pendingAsset = null;
        webView.evaluateJavascript(js, null);
    }

    /** Ajustes de notificaciones desde la página. */
    private class Notif {
        @JavascriptInterface
        public void setConfig(String json) {
            AlertJob.prefs(MainActivity.this).edit().putString("cfg", json).apply();
            JobScheduler js = (JobScheduler) getSystemService(JOB_SCHEDULER_SERVICE);
            try { if (!new JSONObject(json).optBoolean("on", false) && js != null) js.cancel(AlertJob.JOB_PERIODIC); } catch (Exception e) {}
            AlertJob.schedule(MainActivity.this);
        }

        @JavascriptInterface
        public String status() { return AlertJob.status(MainActivity.this); }

        @JavascriptInterface
        public void askPermission() {
            if (Build.VERSION.SDK_INT >= 33 && !AlertJob.allowed(MainActivity.this))
                main.post(() -> requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 7));
        }

        @JavascriptInterface
        public void runNow() { AlertJob.runNow(MainActivity.this); }

        @JavascriptInterface
        public void test() {
            AlertJob.ensureChannel(MainActivity.this);
            AlertJob.notify(MainActivity.this, 8, "Prueba de Mi Cartera", "Así te llegarán los avisos. Tócalo para abrir la app.", null, null);
        }
    }

    @Override
    public void onBackPressed() {
        webView.evaluateJavascript("window.appBack && window.appBack()", value -> {
            if (!"true".equals(value)) MainActivity.super.onBackPressed();
        });
    }

    /** Peticiones HTTP hechas desde Java para evitar las restricciones CORS del navegador. */
    private class Bridge {
        @JavascriptInterface
        public void request(final String id, final String url, final String headersJson) {
            pool.execute(() -> {
                int status = 0;
                String body;
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(25000);
                    c.setInstanceFollowRedirects(true);
                    c.setRequestProperty("User-Agent", UA);
                    c.setRequestProperty("Accept", "*/*");
                    c.setRequestProperty("Accept-Encoding", "gzip");
                    if (headersJson != null && !headersJson.isEmpty()) {
                        JSONObject h = new JSONObject(headersJson);
                        Iterator<String> keys = h.keys();
                        while (keys.hasNext()) {
                            String k = keys.next();
                            c.setRequestProperty(k, h.getString(k));
                        }
                    }
                    status = c.getResponseCode();
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    if (in != null && "gzip".equalsIgnoreCase(c.getContentEncoding())) {
                        in = new GZIPInputStream(in);
                    }
                    body = in == null ? "" : readAll(in);
                    c.disconnect();
                } catch (Exception e) {
                    body = "ERROR: " + e.getMessage();
                }
                final String js = "window.__nativeResolve(" + JSONObject.quote(id) + "," + status + ","
                        + JSONObject.quote(body) + ")";
                main.post(() -> webView.evaluateJavascript(js, null));
            });
        }
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }
}
