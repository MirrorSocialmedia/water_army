package com.waterarmy.probe;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemProperties;
import android.provider.Settings;
import android.telephony.TelephonyManager;
import android.util.Log;

import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * W1b ground-truth probe (ADR-028) — reports the DEVICE-SIDE truth for every
 * identity prop the platform injected, plus self-consistency context fields.
 *
 * Contract with packages/shared/src/w1b-consistency.js (probe-assert.mjs):
 *   dump JSON = { schema: "wa-probe/1", props: { <name>: <value> },
 *                 settings: {...}, telephony: {...}, expected: {...}|absent }
 *
 * Ground truth = SystemProperties (bionic property area read — exactly what
 * a detection platform's own reads hit). No permission required.
 *
 * Dump lands at /data/local/tmp/wa-probe-dump.json AND logcat (tag WA_PROBE,
 * base64 single line for lossless adb logcat extraction).
 *
 * Intent extra "expected_json": platform may embed its expected profile
 * (optional; device-side assertions then need no DB access).
 */
public class ProbeActivity extends Activity {

    private static final String TAG = "WA_PROBE";
    private static final String OUT_PATH = "/data/local/tmp/wa-probe-dump.json";

    // the 9 carrier-mapped identity props (mirror of PROFILE_PROP_MAP)
    private static final String[] PROPS = {
        "ro.product.brand", "ro.product.manufacturer", "ro.product.model",
        "ro.product.device", "ro.product.name",
        "ro.build.id", "ro.build.display.id", "ro.build.fingerprint", "ro.serialno",
    };
    // context fields the validator cross-joins + L2 inventory seeds
    private static final String[] CONTEXT_PROPS = {
        "ro.build.type", "ro.build.tags", "ro.build.version.release", "ro.build.version.sdk",
        "ro.build.version.security_patch", "ro.build.description",
        "ro.product.build.fingerprint", "ro.system.build.fingerprint", "ro.vendor.build.fingerprint",
        "ro.product.cpu.abi", "ro.kernel.qemu",
        "init.svc.zygote", "ro.debuggable", "ro.adb.secure", "ro.hardware", "ro.boot.hardware",
    };
    // multi-partition product namespaces (Android 14 splits these; a partial
    // mapping across partitions is a fingerprinting surface — dump raw)
    private static final String[] PARTITIONED = {
        "ro.product.brand", "ro.product.device", "ro.product.name", "ro.product.model", "ro.product.manufacturer",
    };
    private static final String[] PARTITION_TAGS = { "system", "vendor", "product", "odm" };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String json = buildDumpJson(getIntent());
        try (FileOutputStream fos = new FileOutputStream(OUT_PATH)) {
            fos.write(json.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.e(TAG, "dump-write-failed: " + e);
        }
        // lossless single-line channel for `adb logcat -d -s WA_PROBE`
        Log.i(TAG, "DUMP_B64=" + android.util.Base64.encodeToString(
                json.getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP));
        Log.i(TAG, "probe done, dump at " + OUT_PATH);
        finish();
    }

    private String buildDumpJson(Intent intent) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"schema\":\"wa-probe/1\"");
        sb.append(",\"props\":{");
        boolean first = true;
        for (String p : PROPS) {
            if (!first) sb.append(',');
            first = false;
            sb.append(q(p)).append(':').append(q(SystemProperties.get(p, "")));
        }
        sb.append("},\"context\":{");
        first = true;
        for (String p : CONTEXT_PROPS) {
            String v = SystemProperties.get(p, "");
            if (v.isEmpty()) continue;
            if (!first) sb.append(',');
            first = false;
            sb.append(q(p)).append(':').append(q(v));
        }
        for (String base : PARTITIONED) {
            for (String part : PARTITION_TAGS) {
                String key = base + "." + part;
                String v = SystemProperties.get(key, "");
                if (v.isEmpty()) continue;
                sb.append(',').append(q(key)).append(':').append(q(v));
            }
        }
        sb.append("},\"settings\":{");
        sb.append(q("locale")).append(':').append(q(java.util.Locale.getDefault().toLanguageTag()));
        sb.append(',').append(q("timezone")).append(':').append(q(java.util.TimeZone.getDefault().getID()));
        String deviceName = Settings.Global.getString(getContentResolver(), "device_name");
        sb.append(',').append(q("deviceName")).append(':').append(q(deviceName == null ? "" : deviceName));
        sb.append("},\"telephony\":{");
        try {
            TelephonyManager tm = (TelephonyManager) getSystemService(TELEPHONY_SERVICE);
            sb.append(q("networkOperator")).append(':').append(q(nullToEmpty(tm.getNetworkOperator()))); // MCC+MNC
            sb.append(',').append(q("networkOperatorName")).append(':').append(q(nullToEmpty(tm.getNetworkOperatorName())));
            sb.append(',').append(q("simOperator")).append(':').append(q(nullToEmpty(tm.getSimOperator())));
            sb.append(',').append(q("simOperatorName")).append(':').append(q(nullToEmpty(tm.getSimOperatorName())));
            sb.append(',').append(q("phoneType")).append(':').append(String.valueOf(tm.getPhoneType()));
        } catch (Exception e) {
            sb.append(q("error")).append(':').append(q(String.valueOf(e)));
        }
        sb.append('}');
        String expected = intent == null ? null : intent.getStringExtra("expected_json");
        if (expected != null && expected.startsWith("{")) {
            sb.append(",\"expected\":").append(expected); // embedded verbatim (platform-trusted)
        }
        sb.append(",\"propCount\":").append(allPropCount());
        sb.append('}');
        return sb.toString();
    }

    /** Total property count in the area (L2 inventory tell: farms often have
     *  an unnaturally small prop count vs a real firmware). */
    private int allPropCount() {
        try {
            Process p = Runtime.getRuntime().exec(new String[] { "getprop" });
            java.io.BufferedReader r = new java.io.BufferedReader(
                    new java.io.InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
            int n = 0;
            while (r.readLine() != null) n++;
            p.waitFor();
            return n;
        } catch (Exception e) {
            return -1;
        }
    }

    private static String nullToEmpty(String s) { return s == null ? "" : s; }

    private static String q(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }
}
