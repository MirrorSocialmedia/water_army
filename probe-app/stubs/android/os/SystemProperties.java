// Compile-time stub for the hidden framework API android.os.SystemProperties.
// At runtime the real framework class is loaded by the boot class loader
// (parent delegation), so this stub is compile-time only and shadowed in-app.
package android.os;

public class SystemProperties {
    public static String get(String key) { throw new RuntimeException("stub"); }
    public static String get(String key, String def) { throw new RuntimeException("stub"); }
    public static int getInt(String key, int def) { throw new RuntimeException("stub"); }
    public static boolean getBoolean(String key, boolean def) { throw new RuntimeException("stub"); }
    public static void set(String key, String val) { throw new RuntimeException("stub"); }
}
