package com.gloria.broker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.CookieHandler;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.zip.GZIPInputStream;

/**
 * Comprobación en segundo plano (cada ~2 horas, aunque la app esté cerrada).
 * Lee los precios de Yahoo y el resumen diario del repositorio, y avisa solo de lo importante
 * que la persona ha elegido en Ajustes, con un máximo de avisos al día.
 */
public class AlertJob extends JobService {
    static final int JOB_PERIODIC = 41, JOB_NOW = 42;
    static final String CHANNEL = "avisos";
    static final String UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

    // ---------- Programación ----------
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("notif", MODE_PRIVATE); }

    static JSONObject cfg(Context c) {
        try { return new JSONObject(prefs(c).getString("cfg", "{}")); } catch (Exception e) { return new JSONObject(); }
    }

    static void schedule(Context c) {
        JobScheduler js = (JobScheduler) c.getSystemService(JOB_SCHEDULER_SERVICE);
        if (js == null) return;
        if (!cfg(c).optBoolean("on", false)) { js.cancel(JOB_PERIODIC); return; }
        for (JobInfo j : js.getAllPendingJobs()) if (j.getId() == JOB_PERIODIC) return; // ya está programado
        JobInfo.Builder b = new JobInfo.Builder(JOB_PERIODIC, new ComponentName(c, AlertJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true);
        if (Build.VERSION.SDK_INT >= 24) b.setPeriodic(2 * 3600_000L, 30 * 60_000L); else b.setPeriodic(2 * 3600_000L);
        js.schedule(b.build());
    }

    static void runNow(Context c) {
        JobScheduler js = (JobScheduler) c.getSystemService(JOB_SCHEDULER_SERVICE);
        if (js == null) return;
        js.schedule(new JobInfo.Builder(JOB_NOW, new ComponentName(c, AlertJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setOverrideDeadline(10_000).build());
    }

    static boolean allowed(Context c) {
        return Build.VERSION.SDK_INT < 33 || c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
    }

    // ---------- Trabajo ----------
    @Override
    public boolean onStartJob(final JobParameters p) {
        new Thread(() -> {
            try { check(getApplicationContext(), p.getJobId() == JOB_NOW); } catch (Exception e) { log(getApplicationContext(), "error: " + e.getMessage()); }
            jobFinished(p, false);
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters p) { return true; }

    static final class Alert {
        final int prio; final String key, title, text, asset;
        Alert(int prio, String key, String title, String text, String asset) { this.prio = prio; this.key = key; this.title = title; this.text = text; this.asset = asset; }
    }

    static void check(Context c, boolean manual) throws Exception {
        JSONObject cfg = cfg(c);
        if (!cfg.optBoolean("on", false) && !manual) return;
        if (CookieHandler.getDefault() == null) CookieHandler.setDefault(new CookieManager(null, CookiePolicy.ACCEPT_ALL));
        TimeZone tz = TimeZone.getDefault();
        Calendar now = Calendar.getInstance(tz);
        int hour = now.get(Calendar.HOUR_OF_DAY);
        SimpleDateFormat df = new SimpleDateFormat("yyyy-MM-dd", Locale.US); df.setTimeZone(tz);
        String today = df.format(now.getTime());
        boolean quiet = cfg.optBoolean("quiet", true) && (hour < 8 || hour >= 22);
        if (quiet && !manual) { log(c, "horas de silencio"); return; }

        SharedPreferences sp = prefs(c);
        JSONObject st; try { st = new JSONObject(sp.getString("st", "{}")); } catch (Exception e) { st = new JSONObject(); }
        if (!today.equals(st.optString("day"))) { st.put("day", today); st.put("count", 0); st.put("sent", new JSONObject()); }
        JSONObject sent = st.getJSONObject("sent");
        JSONObject lvl = st.optJSONObject("lvl"); if (lvl == null) { lvl = new JSONObject(); st.put("lvl", lvl); }
        List<Alert> out = new ArrayList<>();
        JSONArray assets = cfg.optJSONArray("assets"); if (assets == null) assets = new JSONArray();
        double th = cfg.optDouble("moveTh", 0.08);
        int prices = 0;
        Map<String, Object[]> qc = new HashMap<>();

        // 1) Precios: movimientos fuertes del día y tus precios de aviso.
        if (cfg.optBoolean("move", true) || cfg.optBoolean("levels", true)) {
            for (int i = 0; i < assets.length(); i++) {
                JSONObject a = assets.getJSONObject(i);
                String id = a.getString("id"), name = a.optString("name", id), sym = a.optString("sym");
                if (sym.isEmpty()) continue;
                Object[] q;
                try { q = quote(sym); } catch (Exception e) { continue; }
                if (q == null) continue;
                qc.put(sym, q);
                prices++;
                double px = (Double) q[0], prev = (Double) q[1];
                String ccy = (String) q[2];
                if (cfg.optBoolean("move", true) && prev > 0) {
                    double ch = px / prev - 1, lim = a.optBoolean("crypto") ? th * 1.5 : th;
                    String k = "mv:" + id + (ch > 0 ? "+" : "-");
                    if (Math.abs(ch) >= lim && !sent.has(k))
                        out.add(new Alert(2, k, name + (ch > 0 ? " sube " : " cae ") + pct(ch) + " hoy",
                                "Precio " + fmt(px) + " " + ccy + ". Mira el análisis antes de decidir nada.", id));
                }
                if (cfg.optBoolean("levels", true)) {
                    level(out, lvl, id, name, "stop", a.optDouble("stop", 0), px, ccy, true,
                            "ha bajado de tu precio de salida", "Es el nivel que marcaste para salir. Decide con calma si lo mantienes.");
                    level(out, lvl, id, name, "buy", a.optDouble("buy", 0), px, ccy, true,
                            "ha bajado de tu precio para comprar más", "Es el precio que marcaste para comprar más.");
                    level(out, lvl, id, name, "sell", a.optDouble("sell", 0), px, ccy, false,
                            "ha llegado a tu precio objetivo", "Es el precio que marcaste para vender.");
                }
            }
        }

        // 1b) Avisos de precio puestos desde Oportunidades (entrada recomendada, caída fuerte...).
        JSONArray pa = cfg.optJSONArray("palerts");
        JSONObject paSt = st.optJSONObject("pa"); if (paSt == null) { paSt = new JSONObject(); st.put("pa", paSt); }
        JSONArray paHit = st.optJSONArray("paHit"); if (paHit == null) paHit = new JSONArray();
        if (pa != null && cfg.optBoolean("levels", true)) {
            JSONArray keep = new JSONArray();
            for (int i = 0; i < pa.length(); i++) {
                JSONObject x = pa.getJSONObject(i);
                String k = x.optString("k"), sym = x.optString("sym"), name = x.optString("name", sym), what = x.optString("what");
                double v = x.optDouble("v", 0), eur = x.optDouble("eur", 0); boolean below = x.optBoolean("below", true);
                if (k.isEmpty() || sym.isEmpty() || !(v > 0)) continue;
                for (int j = 0; j < paHit.length(); j++) if (paHit.optString(j).equals(k)) keep.put(k);
                Object[] q = qc.get(sym);
                if (q == null) { try { q = quote(sym); } catch (Exception e) { q = null; } if (q != null) { qc.put(sym, q); prices++; } }
                if (q == null) continue;
                double px = (Double) q[0]; String ccy = (String) q[2];
                boolean hit = below ? px <= v : px >= v;
                String asset = x.isNull("id") ? null : x.optString("id", null);
                if (asset != null && asset.isEmpty()) asset = null;
                if (hit && paSt.optDouble(k, 0) != v) {
                    String t = what.equals("entrada") ? name + " ha llegado a tu precio de entrada (≈" + fmt(eur) + " €)"
                            : what.equals("stop") ? name + " ha caído fuerte (≈" + fmt(eur) + " €)"
                            : name + (below ? " ha bajado a " : " ha subido a ") + "≈" + fmt(eur) + " €";
                    String tx = "Precio ahora " + fmt(px) + " " + ccy + ". " + (what.equals("stop")
                            ? "Es una bajada fuera de lo normal en un mes. Mira las noticias y el análisis antes de decidir; no vendas por impulso."
                            : "Mira el análisis en la app antes de comprar: la señal puede haber cambiado.");
                    out.add(new Alert(1, "pa:" + k, t, tx, asset));
                    paSt.put(k, v);
                    boolean seen = false; for (int j = 0; j < keep.length(); j++) if (keep.optString(j).equals(k)) seen = true;
                    if (!seen) keep.put(k);
                } else if (!hit && (below ? px > v * 1.02 : px < v * 0.98)) paSt.remove(k); // se vuelve a activar si se aleja
            }
            st.put("paHit", keep);
        }

        // 1c) Eventos: el día antes (o el mismo día, si no dio tiempo) de resultados y eventos de impacto alto.
        JSONArray evs = cfg.optJSONArray("events");
        JSONObject evSt = st.optJSONObject("evs"); if (evSt == null) { evSt = new JSONObject(); st.put("evs", evSt); }
        if (evs != null && cfg.optBoolean("ev", true)) {
            Calendar tm = (Calendar) now.clone(); tm.add(Calendar.DAY_OF_MONTH, 1);
            String tomorrow = df.format(tm.getTime());
            for (int i = 0; i < evs.length(); i++) {
                JSONObject e = evs.getJSONObject(i);
                String k = e.optString("k"), date = e.optString("date");
                if (k.isEmpty() || evSt.has(k)) continue;
                boolean tmw = date.equals(tomorrow), tdy = date.equals(today) && hour < 15;
                if (!tmw && !tdy) continue;
                String asset = e.isNull("id") ? null : e.optString("id", null);
                if (asset != null && asset.isEmpty()) asset = null;
                out.add(new Alert(2, "ev:" + k, (tmw ? "Mañana: " : "Hoy: ") + e.optString("title"), e.optString("text"), asset));
                evSt.put(k, date);
            }
        }
        // Olvida eventos ya pasados.
        List<String> old = new ArrayList<>();
        for (Iterator<String> it = evSt.keys(); it.hasNext(); ) { String k = it.next(); if (evSt.optString(k).compareTo(today) < 0) old.add(k); }
        for (String k : old) evSt.remove(k);

        // 2) Resumen diario del servidor: señal de la app, miedo y codicia, compras de directivos.
        String repo = cfg.optString("repo", "gloriaruano5/broker-app"), branch = cfg.optString("branch", "main");
        try {
            JSONObject row = new JSONObject(get("https://raw.githubusercontent.com/" + repo + "/" + branch + "/data/diario/ultimo.json"));
            String date = row.optString("date");
            if (!date.equals(st.optString("diaryDate"))) {
                JSONObject ra = row.optJSONObject("assets"); if (ra == null) ra = new JSONObject();
                JSONObject b = st.optJSONObject("b"), ins = st.optJSONObject("ins");
                boolean first = b == null;
                if (b == null) b = new JSONObject(); if (ins == null) ins = new JSONObject();
                for (int i = 0; i < assets.length(); i++) {
                    JSONObject a = assets.getJSONObject(i); String id = a.getString("id"), name = a.optString("name", id);
                    JSONObject r = ra.optJSONObject(id); if (r == null) continue;
                    String nb = r.optString("b", ""), ob = b.optString(id, "");
                    if (!nb.isEmpty()) {
                        if (!first && cfg.optBoolean("signal", true) && !ob.isEmpty() && !ob.equals(nb) && important(ob, nb))
                            out.add(new Alert(4, "sg:" + id + nb, "Señal de " + name + ": " + label(nb),
                                    "Antes: " + label(ob) + ". Es orientativa; mira el porqué en la app.", id));
                        b.put(id, nb);
                    }
                    JSONObject in = r.optJSONObject("ins");
                    if (in != null) {
                        int buys = in.optInt("buys", 0), was = ins.optInt(id, -1);
                        if (!first && cfg.optBoolean("ins", true) && was >= 0 && buys > was)
                            out.add(new Alert(3, "in:" + id + buys, name + ": un directivo ha comprado acciones",
                                    "Compras de directivos con su dinero (últimos 4 meses): " + buys + ". Suele ser buena señal, no una garantía.", id));
                        ins.put(id, buys);
                    }
                }
                st.put("b", b); st.put("ins", ins);
                JSONObject fg = row.optJSONObject("fg");
                if (fg != null && cfg.optBoolean("fg", true)) {
                    fgAlert(out, st, "fgS", "bolsa", fg.optDouble("stocks", Double.NaN), first);
                    fgAlert(out, st, "fgC", "cripto", fg.optDouble("crypto", Double.NaN), first);
                }
                st.put("diaryDate", date);
            }
        } catch (Exception e) { /* sin resumen hoy */ }

        // 3) Enviar, como mucho "max" al día. Si hay más de los que caben, se juntan en uno.
        out.sort((x, y) -> x.prio - y.prio);
        int max = cfg.optInt("max", 3), count = st.optInt("count", 0), left = Math.max(0, max - count);
        for (Alert a : out) sent.put(a.key, 1);
        if (!out.isEmpty() && left > 0 && allowed(c)) {
            ensureChannel(c);
            if (out.size() <= left) { for (Alert a : out) notify(c, a.key.hashCode(), a.title, a.text, a.asset, null); count += out.size(); }
            else {
                List<String> lines = new ArrayList<>(); for (Alert a : out) lines.add(a.title);
                notify(c, ("grupo" + today + count).hashCode(), out.size() + " avisos de tu cartera", out.get(0).title + " y " + (out.size() - 1) + " más", out.get(0).asset, lines);
                count++;
            }
        }
        if (manual && out.isEmpty() && allowed(c)) { ensureChannel(c); notify(c, 7, "Todo tranquilo", "He revisado " + prices + " precios y el resumen diario: nada importante ahora.", null, null); }
        st.put("count", count);
        st.put("last", System.currentTimeMillis()); st.put("lastPrices", prices); st.put("lastAlerts", out.size());
        sp.edit().putString("st", st.toString()).apply();
        log(c, "ok " + prices + " precios, " + out.size() + " avisos");
    }

    static void level(List<Alert> out, JSONObject lvl, String id, String name, String kind, double v, double px, String ccy, boolean below, String what, String text) throws Exception {
        String k = kind + ":" + id;
        if (!(v > 0)) { lvl.remove(k); return; }
        boolean hit = below ? px <= v : px >= v;
        if (hit && lvl.optDouble(k, 0) != v) { out.add(new Alert(1, k + v, name + " " + what + " (" + fmt(v) + " " + ccy + ")", "Precio ahora " + fmt(px) + " " + ccy + ". " + text, id)); lvl.put(k, v); }
        else if (!hit && (below ? px > v * 1.02 : px < v * 0.98)) lvl.remove(k); // se vuelve a activar si se aleja
    }

    static void fgAlert(List<Alert> out, JSONObject st, String key, String what, double v, boolean first) throws Exception {
        if (Double.isNaN(v)) return;
        String zone = v <= 15 ? "miedo" : v >= 85 ? "codicia" : "";
        String was = st.optString(key, "");
        if (!first && !zone.isEmpty() && !zone.equals(was))
            out.add(new Alert(5, key + zone, (zone.equals("miedo") ? "Miedo extremo" : "Codicia extrema") + " en " + what + " (" + Math.round(v) + ")",
                    zone.equals("miedo") ? "Históricamente, comprar con miedo ha ido mejor que vender con miedo." : "Con codicia extrema conviene ser prudente con compras nuevas.", null));
        st.put(key, zone);
    }

    static final String[] ORDER = {"sell", "caut", "hold", "acc", "buy"};
    static int rank(String b) { for (int i = 0; i < ORDER.length; i++) if (ORDER[i].equals(b)) return i; return 2; }
    /** Solo cambios que importan: llegar a Comprar o Reducir, pasar a Precaución desde arriba o salir de la zona de riesgo. */
    static boolean important(String ob, String nb) {
        int o = rank(ob), n = rank(nb);
        return n == 0 || n == 4 || (n == 1 && o >= 2) || (o <= 1 && n >= 3);
    }
    static String label(String b) {
        switch (b) { case "buy": return "Comprar"; case "acc": return "Acumular"; case "hold": return "Mantener"; case "caut": return "Precaución"; case "sell": return "Reducir"; default: return b; }
    }

    // ---------- Notificaciones ----------
    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Avisos de la cartera", NotificationManager.IMPORTANCE_DEFAULT);
                ch.setDescription("Movimientos fuertes, tus precios de aviso y cambios de señal");
                nm.createNotificationChannel(ch);
            }
        }
    }

    static void notify(Context c, int id, String title, String text, String asset, List<String> lines) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (asset != null) i.putExtra("asset", asset);
        PendingIntent pi = PendingIntent.getActivity(c, id, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_notif).setContentTitle(title).setContentText(text).setContentIntent(pi).setAutoCancel(true);
        if (lines != null) { Notification.InboxStyle s = new Notification.InboxStyle(); for (String l : lines) s.addLine(l); b.setStyle(s); }
        else b.setStyle(new Notification.BigTextStyle().bigText(text));
        c.getSystemService(NotificationManager.class).notify(id, b.build());
    }

    // ---------- Red ----------
    /** [precio, cierre del día anterior] desde Yahoo. */
    static Object[] quote(String sym) throws Exception {
        JSONObject res = new JSONObject(get("https://query1.finance.yahoo.com/v8/finance/chart/" + java.net.URLEncoder.encode(sym, "UTF-8") + "?range=5d&interval=1d"))
                .getJSONObject("chart").getJSONArray("result").getJSONObject(0);
        JSONObject meta = res.getJSONObject("meta");
        double px = meta.optDouble("regularMarketPrice", Double.NaN);
        if (Double.isNaN(px)) return null;
        JSONArray t = res.optJSONArray("timestamp");
        JSONArray cl = res.getJSONObject("indicators").getJSONArray("quote").getJSONObject(0).optJSONArray("close");
        double prev = 0;
        if (t != null && cl != null) {
            SimpleDateFormat d = new SimpleDateFormat("yyyy-MM-dd", Locale.US); d.setTimeZone(TimeZone.getTimeZone("UTC"));
            String cur = d.format(new Date(meta.optLong("regularMarketTime", t.getLong(t.length() - 1)) * 1000));
            for (int i = t.length() - 1; i >= 0; i--) {
                if (d.format(new Date(t.getLong(i) * 1000)).compareTo(cur) < 0 && !cl.isNull(i)) { prev = cl.getDouble(i); break; }
            }
        }
        return new Object[]{px, prev, meta.optString("currency", "")};
    }

    static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(20000);
        c.setRequestProperty("User-Agent", UA); c.setRequestProperty("Accept", "*/*"); c.setRequestProperty("Accept-Encoding", "gzip");
        int status = c.getResponseCode();
        if (status >= 400) { c.disconnect(); throw new Exception("HTTP " + status); }
        InputStream in = c.getInputStream();
        if ("gzip".equalsIgnoreCase(c.getContentEncoding())) in = new GZIPInputStream(in);
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buf = new byte[16384]; int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close(); c.disconnect();
        return out.toString("UTF-8");
    }

    static String pct(double x) { return (x > 0 ? "+" : "") + String.format(new Locale("es", "ES"), "%.1f%%", x * 100); }
    static String fmt(double x) { return String.format(new Locale("es", "ES"), x >= 1000 ? "%,.0f" : x >= 1 ? "%.2f" : "%.4f", x); }

    static void log(Context c, String s) {
        SimpleDateFormat f = new SimpleDateFormat("dd/MM HH:mm", Locale.US); f.setTimeZone(TimeZone.getDefault());
        prefs(c).edit().putString("log", f.format(new Date()) + " " + s).apply();
    }

    static String status(Context c) {
        try {
            JSONObject st = new JSONObject(prefs(c).getString("st", "{}")), o = new JSONObject();
            o.put("perm", allowed(c)); o.put("last", st.optLong("last", 0)); o.put("today", st.optInt("count", 0));
            o.put("log", prefs(c).getString("log", "")); o.put("lastAlerts", st.optInt("lastAlerts", 0)); o.put("lastPrices", st.optInt("lastPrices", 0));
            JSONArray ph = st.optJSONArray("paHit"); o.put("paHit", ph == null ? new JSONArray() : ph);
            return o.toString();
        } catch (Exception e) { return "{}"; }
    }
}
