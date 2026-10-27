// water_army T7 — Android-side probe EXTENSION skeleton (not built here).
//
// Gap list vs existing W1b probe-app (probe-app/src/com/waterarmy/probe/ProbeActivity.java):
// the W1b probe reads property area + 3 settings + 5 telephony basics. Surfaces it does
// NOT read (all requested by docs/exposure-surfaces.md collection items):
//   X1  full Settings dump (Global/System/Secure)         -> settingsFullDump()
//   X2  SensorManager device list (D8)                    -> sensorList()
//   X3  BatteryManager + /sys/class/power_supply (D9)     -> battery()
//   X4  storage StatFs totals (D10)                       -> storage()
//   X5  /proc/meminfo + /proc/cpuinfo + uname (D5/D10/D11, B2 root cause)
//                                                       -> procSurfaces()
//   X6  telephony deep fields (S6: signal/cell/simState)  -> telephonyDeep()
//   X7  full getprop dump + propCount parity (D3)         -> reuse W1b allPropCount() + full raw dump
//   X8  bluetooth presence (S7)                           -> bluetooth()
//
// Merge target = same dump JSON as W1b probe (schema wa-probe/2, additive keys),
// so probe-assert.mjs keeps working and J2 evidence stays comparable.
// Zero-permission where possible; every read null-guarded (container may lack the service).
package com.waterarmy.probe;

import android.app.Activity;
import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorManager;
import android.media.AudioManager;
import android.os.BatteryManager;
import android.os.Environment;
import android.os.StatFs;
import android.os.SystemProperties;
import android.provider.Settings;
import android.telephony.SignalStrength;
import android.telephony.TelephonyManager;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class ProbeSurfacesExt {

    // ---- X1: full settings dump. Farm vs real-device divergence table (S1).
    // Key list strategy: dump ALL keys via Settings.Global.NAME_VALUE_SEPARATOR iteration is
    // not available API-side; pragmatic route = `settings list global|system|secure` via exec
    // (shell user context; app context may only see a subset — record which channel answered).
    static Map<String, Object> settingsFullDump(Context ctx) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (String ns : new String[]{"global", "system", "secure"}) {
            out.put(ns, execLines(new String[]{"settings", "list", ns}));
        }
        return out;
    }

    // ---- X2: sensors (D8). Names matter: a real Pixel lists 15-40 sensors incl.
    // accelerometer/gyro/proximity; empty list = instant container tell.
    static List<Map<String, Object>> sensorList(Context ctx) {
        List<Map<String, Object>> list = new ArrayList<>();
        try {
            SensorManager sm = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
            List<Sensor> all = sm.getSensorList(Sensor.TYPE_ALL);
            for (Sensor s : all) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("name", s.getName()); m.put("type", s.getType());
                m.put("vendor", s.getVendor()); m.put("power", s.getPower());
                list.add(m);
            }
        } catch (Throwable t) { /* record error string in caller */ }
        return list;
    }

    // ---- X3: battery (D9). Sticky-broadcast read = zero permission.
    static Map<String, Object> battery(Context ctx) {
        Map<String, Object> m = new LinkedHashMap<>();
        try {
            android.content.Intent i = ctx.registerReceiver(
                    null, new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED));
            if (i != null) {
                m.put("level", i.getIntExtra("level", -1));
                m.put("scale", i.getIntExtra("scale", -1));
                m.put("status", i.getIntExtra("status", -1));       // charging semantics
                m.put("plugged", i.getIntExtra("plugged", -1));
                m.put("technology", i.getStringExtra("technology"));
                m.put("temperature", i.getIntExtra("temperature", -1));
                m.put("voltage", i.getIntExtra("voltage", -1));
            }
            File ps = new File("/sys/class/power_supply");
            String[] entries = ps.list();
            m.put("powerSupplyNodes", entries == null ? null : java.util.Arrays.asList(entries));
        } catch (Throwable t) { m.put("error", String.valueOf(t)); }
        return m;
    }

    // ---- X4: storage totals (D10). Real device: /data ≈ device SKU size; container: host disk.
    static Map<String, Object> storage() {
        Map<String, Object> m = new LinkedHashMap<>();
        try {
            StatFs data = new StatFs(Environment.getDataDirectory().getPath());
            m.put("dataTotalBytes", data.getTotalBytes());
            m.put("dataAvailBytes", data.getAvailableBytes());
            StatFs root = new StatFs("/");
            m.put("rootTotalBytes", root.getTotalBytes());
        } catch (Throwable t) { m.put("error", String.valueOf(t)); }
        return m;
    }

    // ---- X5: kernel-visible host leakage (D5/D10/D11 — the B2 root cause).
    // meminfo: MemTotal ≈ host RAM. cpuinfo: Intel model string + core count.
    // uname: host distro kernel. All via cheap reads; cap sizes, record only
    // summary fields into the dump (zero PII, small JSON).
    static Map<String, Object> procSurfaces() {
        Map<String, Object> m = new LinkedHashMap<>();
        try {
            BufferedReader r = new BufferedReader(new FileReader("/proc/meminfo"));
            String line;
            while ((line = r.readLine()) != null)
                if (line.startsWith("MemTotal")) { m.put("meminfoMemTotal", line.trim()); break; }
            r.close();
        } catch (Throwable t) { m.put("meminfoError", String.valueOf(t)); }
        try {
            List<String> cpu = execLines(new String[]{"cat", "/proc/cpuinfo"});
            int processors = 0; String model = null; String vendor = null;
            for (String l : cpu) {
                if (l.startsWith("processor")) processors++;
                else if (l.startsWith("model name") && model == null) model = l.split(":", 2)[1].trim();
                else if (l.startsWith("vendor_id") && vendor == null) vendor = l.split(":", 2)[1].trim();
            }
            m.put("cpuinfo", "host-kernel: vendor=" + vendor + " model=" + model + " processors=" + processors);
        } catch (Throwable t) { m.put("cpuinfoError", String.valueOf(t)); }
        m.put("uname", firstOf(execLines(new String[]{"uname", "-a"})));
        return m;
    }

    // ---- X6: telephony deep fields (S6). Null-guarded; permission-free subset only.
    static Map<String, Object> telephonyDeep(Context ctx) {
        Map<String, Object> m = new LinkedHashMap<>();
        try {
            TelephonyManager tm = (TelephonyManager) ctx.getSystemService(Context.TELEPHONY_SERVICE);
            m.put("simState", tm.getSimState());
            m.put("dataNetworkType", tm.getDataNetworkType());
            m.put("callState", tm.getCallState());
            SignalStrength ss = tm.getSignalStrength();
            m.put("signalLevel", ss == null ? null : ss.getLevel());
            m.put("voiceReg", tm.isNetworkRoaming() ? "roaming" : "home");
        } catch (Throwable t) { m.put("error", String.valueOf(t)); }
        return m;
    }

    // ---- X8: bluetooth presence (S7)
    static Map<String, Object> bluetooth(Context ctx) {
        Map<String, Object> m = new LinkedHashMap<>();
        try {
            android.bluetooth.BluetoothAdapter a =
                ((android.bluetooth.BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE)).getAdapter();
            m.put("adapterPresent", a != null);
            m.put("enabled", a != null && a.isEnabled());
            m.put("nameSet", a != null && a.getName() != null);
        } catch (Throwable t) { m.put("error", String.valueOf(t)); }
        return m;
    }

    // helpers -------------------------------------------------------------
    static List<String> execLines(String[] argv) {
        List<String> out = new ArrayList<>();
        try {
            Process p = new ProcessBuilder(argv).redirectErrorStream(true).start();
            BufferedReader r = new BufferedReader(new java.io.InputStreamReader(p.getInputStream()));
            String line; int n = 0;
            while ((line = r.readLine()) != null && n++ < 2000) out.add(line);
            p.waitFor();
        } catch (Throwable ignored) {}
        return out;
    }
    static String firstOf(List<String> l) { return l.isEmpty() ? null : l.get(0); }

}
