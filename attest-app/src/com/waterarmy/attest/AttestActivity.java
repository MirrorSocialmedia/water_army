package com.waterarmy.attest;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.ResolveInfo;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;

import com.google.android.gms.safetynet.SafetyNet;
import com.google.android.gms.safetynet.SafetyNetApi;
import com.google.android.gms.tasks.Task;
import com.google.android.play.core.integrity.IntegrityManager;
import com.google.android.play.core.integrity.IntegrityManagerFactory;
import com.google.android.play.core.integrity.IntegrityTokenRequest;
import com.google.android.play.core.integrity.IntegrityTokenResponse;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

/**
 * EXP-3 raw Integrity/SafetyNet verdict collector (docs/l3-play-integrity.md §3.1).
 *
 * Emits one JSON object per probe to logcat tag WA-INTEGRITY plus a final
 * summary line; also mirrors everything to /data/local/tmp/wa-attest-result.json.
 *
 * Probe matrix (each failure path must RECORD, never crash):
 *   gms      — installed GMS/vending package facts (version expectations vs device reality)
 *   bind     — resolveService() for Integrity (atom.attest.BIND) + legacy bindings
 *   safety   — legacy SafetyNet.attest (client bundled; service side may be dead 2025-05+)
 *   integrity— Play Integrity requestIntegrityToken (client bundled; MTG 22.21.16 has no
 *              atom.attest.BIND service => expected connection failure = raw signal)
 *   legacyapi— reflection for the 2022-beta IntegrityApi/requestStandardIntegrityRequest
 *              classes (not bundled; presence would mean a GMS-borne client) +
 *              StandardIntegrityManager (bundled, exercised via reflection)
 */
public class AttestActivity extends Activity {

    private static final String TAG = "WA-INTEGRITY";
    private static final String OUT_PATH = "/data/local/tmp/wa-attest-result.json";
    private static final long TASK_AWAIT_MS = 45_000L;

    private final JSONArray results = new JSONArray();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Thread t = new Thread(this::runAll, "wa-attest");
        t.setDaemon(false);
        t.start();
    }

    private void runAll() {
        long t0 = System.currentTimeMillis();
        JSONObject gms = probeGms();
        JSONObject bind = probeBindings();
        JSONObject legacy = probeLegacyApiReflection();
        JSONObject safety = probeSafetyNet();
        JSONObject integrity = probeIntegrity();

        emit(gms); emit(bind); emit(legacy); emit(safety); emit(integrity);

        JSONObject summary = new JSONObject();
        try {
            summary.put("probe", "summary")
                   .put("ts", System.currentTimeMillis())
                   .put("elapsed_ms", System.currentTimeMillis() - t0)
                   .put("gms", gms.optString("status", "?"))
                   .put("bind", bind.optString("status", "?"))
                   .put("legacyapi", legacy.optString("status", "?"))
                   .put("safety", safety.optString("status", "?"))
                   .put("integrity", integrity.optString("status", "?"));
        } catch (Exception ignored) { }
        emit(summary);

        try (FileOutputStream fos = new FileOutputStream(OUT_PATH)) {
            fos.write(results.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.i(TAG, json("file", null, "error", String.valueOf(e)));
        }
        finish();
    }

    // ---- probes -------------------------------------------------------------

    private JSONObject probeGms() {
        JSONObject o = new JSONObject();
        try {
            o.put("probe", "gms");
            pkgInfo(o, "com.google.android.gms");
            pkgInfo(o, "com.android.vending");
            pkgInfo(o, "com.google.android.gsf");
            o.put("status", "ok");
        } catch (Exception e) { return fail(o, e); }
        return o;
    }

    private void pkgInfo(JSONObject o, String pkg) {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(pkg, 0);
            o.put(pkg, pi.versionName + "+" + pi.getLongVersionCode());
        } catch (Exception e) {
            try { o.put(pkg, "absent"); } catch (Exception ignored) { }
        }
    }

    private JSONObject probeBindings() {
        JSONObject o = new JSONObject();
        try {
            o.put("probe", "bind");
            String[] actions = {
                "com.google.android.gms.atom.attest.BIND",   // Integrity (ZinZi) service
                "com.google.android.gms.safetynet.BIND",     // legacy SafetyNet (informational)
                "com.google.android.gms.auth.api.zinzi.BIND" // legacy name variant
            };
            for (String a : actions) {
                ResolveInfo ri = getPackageManager().resolveService(new Intent(a), 0);
                o.put(a, ri == null ? "NO_RESOLVER"
                    : new ComponentName(ri.serviceInfo.packageName, ri.serviceInfo.name).flattenToShortString());
            }
            o.put("status", "ok");
        } catch (Exception e) { return fail(o, e); }
        return o;
    }

    private JSONObject probeSafetyNet() {
        JSONObject o = new JSONObject();
        try {
            o.put("probe", "safety");
            byte[] nonce = new byte[16];
            new SecureRandom().nextBytes(nonce);
            // empty API key: server-side verdict needs one; connection/binding behaviour does not.
            Task<SafetyNetApi.AttestationResponse> task = SafetyNet.getClient(this).attest(nonce, "");
            SafetyNetApi.AttestationResponse r = awaitMs(task);
            o.put("nonce", Base64.encodeToString(nonce, Base64.NO_WRAP | Base64.NO_PADDING)
                    .replace("\n", "").replace("\r", ""));
            if (r == null) {
                o.put("status", "task_error");
                describeThrowable(o, task.getException());
            } else {
                // Raw-verdict collection: read the JWS directly (getResult() is protected
                // in the shipped jar) and surface the decoded payload claims verbatim.
                o.put("status", "response");
                String jws = r.getJwsResult();
                o.put("jwsLen", jws == null ? 0 : jws.length());
                if (jws != null && jws.split("\\.").length >= 2) {
                    String payload = jws.split("\\.")[1];
                    byte[] dec = Base64.decode(payload, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
                    o.put("jws_payload", trim(new String(dec, StandardCharsets.UTF_8), 600));
                }
            }
        } catch (Throwable e) { return fail(o, e); }
        return o;
    }

    private JSONObject probeIntegrity() {
        JSONObject o = new JSONObject();
        try {
            o.put("probe", "integrity");
            IntegrityManager im = IntegrityManagerFactory.create(getApplicationContext());
            String nonce = randNonce();
            IntegrityTokenRequest req = IntegrityTokenRequest.builder()
                    .setNonce(nonce)
                    .build();
            Task<IntegrityTokenResponse> task = im.requestIntegrityToken(req);
            IntegrityTokenResponse r = awaitMs(task);
            o.put("nonce", nonce);
            if (r == null) {
                o.put("status", "task_error");
                describeThrowable(o, task.getException());
            } else {
                o.put("status", "token");
                String tok = r.token();
                o.put("tokenLen", tok == null ? 0 : tok.length());
                o.put("tokenPrefix", trim(tok, 64));
            }
        } catch (Throwable e) { return fail(o, e); }
        return o;
    }

    /** Reflection-only: classes NOT bundled must be recorded as absent, and
     *  StandardIntegrityManager (bundled) is exercised without compile coupling. */
    private JSONObject probeLegacyApiReflection() {
        JSONObject o = new JSONObject();
        try {
            o.put("probe", "legacyapi");
            String[] cls = {
                "com.google.android.gms.integrity.IntegrityApi",              // 2022-beta client
                "com.google.android.gms.integrity.IntegrityStatusCodes",
                "com.google.android.play.core.integrity.StandardIntegrityManager" // bundled
            };
            for (String c : cls) {
                try {
                    Class<?> k = Class.forName(c);
                    List<String> ms = new ArrayList<>();
                    java.lang.reflect.Method[] all = k.getMethods();
                    for (java.lang.reflect.Method m : all) {
                        if (m.getName().matches("request.*|prepare.*")) ms.add(m.getName());
                    }
                    o.put(c, "present:" + new JSONArray(ms));
                } catch (Throwable e) {
                    o.put(c, "absent");
                }
            }
            // exercise Standard prepare flow reflectively (needs cloudProjectNumber we
            // don't own -> its error code is itself a valid raw signal).
            try {
                Object sim = IntegrityManagerFactory.createStandard(getApplicationContext());
                Class<?> prepCls = Class.forName(
                    "com.google.android.play.core.integrity.StandardIntegrityManager$PrepareIntegrityTokenRequest");
                Object builder = prepCls.getMethod("builder").invoke(null);
                long cpn = Long.getLong("wa.cloud_project_number", 0L); // 0 = no project
                builder = builder.getClass().getMethod("setCloudProjectNumber", long.class)
                                  .invoke(builder, cpn);
                Object prepReq = builder.getClass().getMethod("build").invoke(builder);
                Task<?> task = (Task<?>) sim.getClass()
                    .getMethod("prepareIntegrityToken", prepCls).invoke(sim, prepReq);
                Object provider = awaitMs(task);
                if (provider == null) {
                    o.put("standard_prepare", "task_error");
                    JSONObject err = new JSONObject();
                    describeThrowable(err, task.getException());
                    o.put("standard_prepare_err", err);
                } else {
                    o.put("standard_prepare", "provider_ready");
                }
            } catch (Throwable e) {
                o.put("standard_prepare", "error");
                o.put("standard_prepare_msg", trim(String.valueOf(e), 300));
            }
            o.put("status", "ok");
        } catch (Throwable e) { return fail(o, e); }
        return o;
    }

    // ---- helpers -------------------------------------------------------------

    private static String randNonce() {
        byte[] n = new byte[24];
        new SecureRandom().nextBytes(n);
        return Base64.encodeToString(n, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    @SuppressWarnings("unchecked")
    private static <T> T awaitMs(Task<T> task) {
        try {
            return com.google.android.gms.tasks.Tasks.await(task, TASK_AWAIT_MS, java.util.concurrent.TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            return task.isComplete() && task.isSuccessful() ? task.getResult() : null;
        }
    }

    private static void describeThrowable(JSONObject o, Throwable e) {
        try {
            if (e == null) { o.put("err", "unknown/incomplete"); return; }
            o.put("err_class", e.getClass().getName());
            o.put("err_msg", trim(String.valueOf(e.getMessage()), 300));
            // ApiException-style status code when present
            try {
                java.lang.reflect.Method m = e.getClass().getMethod("getStatusCode");
                o.put("err_status", m.invoke(e));
            } catch (Exception ignored2) { }
            if (e.getCause() != null) {
                o.put("err_cause", e.getCause().getClass().getName() + ": " + trim(String.valueOf(e.getCause().getMessage()), 200));
            }
        } catch (Exception ignored) { }
    }

    private static String trim(String s, int n) {
        if (s == null) return null;
        return s.length() <= n ? s : s.substring(0, n) + "...";
    }

    private JSONObject fail(JSONObject o, Throwable e) {
        try { o.put("status", "exception"); } catch (Exception ignored) { }
        describeThrowable(o, e);
        return o;
    }

    private String json(String k, Object v, String k2, Object v2) {
        try { return new JSONObject().put(k, v).put(k2, v2).toString(); }
        catch (Exception e) { return "{}"; }
    }

    private void emit(JSONObject o) {
        Log.i(TAG, o.toString());
        results.put(o);
    }
}
