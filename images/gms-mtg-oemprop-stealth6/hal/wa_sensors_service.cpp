/*
 * WA-STEALTH6 T2 — wa-sensors: minimal userland AIDL sensors HAL for redroid.
 *
 * Purpose: give the framework a live ISensors so SensorService publishes a
 * 3-sensor list (accel / gyro / proximity, fixed plausible constants) and
 * DevCheck's "no sensors" deduction disappears. No events are generated
 * (initialize() accepts the FMQ handshake and ignores it; we never write
 * into the queue — the framework tolerates an idle queue).
 *
 * Links against the device's own generated library
 * (android.hardware.sensors-V2-ndk.so) for BnSensors/SharedRefBase and
 * libbinder_ndk for the C core + ServiceManager registration. Built on the
 * host; see build_host.sh for the stub-link + assertion discipline.
 */
#include <signal.h>
#include <unistd.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>

#include "wa_sensors_aidl.h"

namespace {

constexpr char kServiceName[] =
    "android.hardware.sensors.ISensors/default";

/* AIDL SensorInfo.flags uses a DIFFERENT bit encoding from legacy Sensors.h!
 * (hardware/interfaces/sensors/aidl/.../SensorInfo.aidl android14):
 *   bit 0 (0x01) Wake-up sensor → framework marks proximity+wakeUp as DYNAMIC
 *   bit 1 (0x02) Reporting mode: on-change
 *   bit 4 (0x10) Supports ASHMEM direct channel
 *   bit 5 (0x20) Supports GRALLOC direct channel
 *   bit 8 (0x100) Dynamic sensor (framework-managed)
 *   bit 10 (0x400) Supports data injection
 *
 * Critical: setting bit 0 on a PROXIMITY sensor triggers Android 13+ framework
 * "runtime proximity" logic → sensor marked dynamic → hidden from app
 * getSensorList() → DevCheck reports "proximity absent". Do NOT set wakeUp
 * for proximity. Keep it non-wakeUp.
 *
 * DevCheck (2.9.2) checks proximity via SensorManager.getSensorList → presence.
 * Accelerometer/Gyroscope (non-wakeUp, continuous) pass. Proximity (on-change,
 * non-wakeUp) must also pass — just do NOT set bit 0. */
constexpr int32_t kFlagsContinuous = 0x10 | 0x400;           // 0x410 (accel/gyro: continuous, ashmem, data-inj)
constexpr int32_t kFlagsProximity  = 0x01 | 0x02 | 0x10 | 0x400; // 0x413 (wakeUp + on-change + ashmem + data-inj)
// IMPORTANT: DevCheck calls SensorManager.getDefaultSensor(8) which defaults to
// wakeUp=true → looks for a proximity sensor with FLAG_WAKE_UP (AIDL bit 0).
// Without bit 0, getDefaultSensor(8) returns null → "proximity absent" (-8 pts).
// config_useRuntimeProximityDetection defaults to false (AOSP) → wakeUp proximity
// is NOT marked dynamic → stays visible to apps. Safe to set bit 0 here.

using aidl::android::hardware::sensors::SensorInfo;
using aidl::android::hardware::sensors::WaString;
using aidl::android::hardware::sensors::mkstr;

// Fill three fixed sensors into caller-provided storage. The out-param of
// getSensorsList is a DEVICE libc++ vector; host libstdc++ container ops on
// it corrupt memory (measured: Scudo misaligned free in libc++ clear() after
// onTransact, 2026-11-03). So we hand back malloc'ed storage laid out in
// libc++ vector long-form and let the device glue destroy elements and free.
void fillSensorTable(SensorInfo* arr) {
  arr[0] = SensorInfo{
          /*sensorHandle=*/1,
          /*name=*/mkstr("BMI260 Accelerometer"),
          /*vendor=*/mkstr("Bosch"),
          /*version=*/1,
          /*type=*/1 /* ASENSOR_TYPE_ACCELEROMETER */,
          /*typeAsString=*/mkstr("android.hardware.sensor.accelerometer"),
          /*maxRange=*/19.62f,
          /*resolution=*/0.0012f,
          /*power=*/0.15f,
          /*minDelayUs=*/1000,
          /*fifoReservedEventCount=*/0,
          /*fifoMaxEventCount=*/0,
          /*requiredPermission=*/mkstr(""),
          /*maxDelayUs=*/0,
          /*flags=*/kFlagsContinuous,
      };
  arr[1] = SensorInfo{
          /*sensorHandle=*/2,
          /*name=*/mkstr("BMI260 Gyroscope"),
          /*vendor=*/mkstr("Bosch"),
          /*version=*/1,
          /*type=*/4 /* ASENSOR_TYPE_GYROSCOPE */,
          /*typeAsString=*/mkstr("android.hardware.sensor.gyroscope"),
          /*maxRange=*/34.9f,
          /*resolution=*/0.0009f,
          /*power=*/6.1f,
          /*minDelayUs=*/1000,
          /*fifoReservedEventCount=*/0,
          /*fifoMaxEventCount=*/0,
          /*requiredPermission=*/mkstr(""),
          /*maxDelayUs=*/0,
          /*flags=*/kFlagsContinuous,
      };
  arr[2] = SensorInfo{
          /*sensorHandle=*/3,
          /*name=*/mkstr("VCNL36827 Proximity"),
          /*vendor=*/mkstr("Vishay"),
          /*version=*/1,
          /*type=*/8 /* ASENSOR_TYPE_PROXIMITY */,
          /*typeAsString=*/mkstr("android.hardware.sensor.proximity"),
          /*maxRange=*/5.0f,
          /*resolution=*/1.0f,
          /*power=*/0.15f,
          /*minDelayUs=*/10000,
          /*fifoReservedEventCount=*/0,
          /*fifoMaxEventCount=*/0,
          /*requiredPermission=*/mkstr(""),
          /*maxDelayUs=*/2147483647,  // on-change: no max period
          /*flags=*/kFlagsProximity,
      };
}

extern "C" int __android_log_print(int prio, const char* tag, const char* fmt, ...);

/* stderr + logd (stderr of a vendor service reaches neither logcat nor a
 * readable kmsg on redroid; logd is the observable channel). */
void Log(const char* msg) {
  unsigned len = 0;
  while (msg[len]) len++;
  ::write(2, msg, len);
  __android_log_print(6 /*ANDROID_LOG_INFO*/, "wa-sensors", "%.*s",
                      (int)(len ? len - 1 : 0), msg);
}

class WaSensors final
    : public aidl::android::hardware::sensors::BnSensors {
 public:
  WaSensors() = default;
  ~WaSensors() override = default;

  ::ndk::ScopedAStatus activate(int32_t sensorHandle, bool enabled) override {
    Log("wa-sensors: activate\n");
    (void)sensorHandle;
    (void)enabled;
    return ::ndk::ScopedAStatus::ok();
  }

  ::ndk::ScopedAStatus batch(int32_t sensorHandle, int64_t samplingPeriodNs,
                             int64_t maxReportLatencyNs) override {
    Log("wa-sensors: batch\n");
    (void)sensorHandle;
    (void)samplingPeriodNs;
    (void)maxReportLatencyNs;
    return ::ndk::ScopedAStatus::ok();
  }

  ::ndk::ScopedAStatus configDirectReport(int32_t sensorHandle,
                                          int32_t channelHandle,
                                          ISensors::RateLevel rate,
                                          int32_t* _aidl_return) override {
    (void)rate;
    *_aidl_return =
        (sensorHandle > 0 && channelHandle > 0) ? channelHandle : -1;  // EINVAL-ish
    return ::ndk::ScopedAStatus::ok();
  }

  ::ndk::ScopedAStatus flush(int32_t sensorHandle) override {
    Log("wa-sensors: flush\n");
    (void)sensorHandle;
    // No FMQ writes: flush-completion events are omitted; the framework
    // tolerates this (DevCheck never issues flush).
    return ::ndk::ScopedAStatus::ok();
  }

  ::ndk::ScopedAStatus getSensorsList(std::vector<SensorInfo>* out) override {
    Log("wa-sensors: getSensorsList\n");
    // Treat the out-param as raw libc++ vector storage {begin, end, endcap}
    // (non-hardened, non-tagged long form; long == endcap-begin > 0).
    struct RawVec { uintptr_t begin, end, endcap; };
    RawVec* v = reinterpret_cast<RawVec*>(out);
    static_assert(sizeof(SensorInfo) % 8 == 0, "SensorInfo must be 8-aligned");
    SensorInfo* arr = static_cast<SensorInfo*>(malloc(3 * sizeof(SensorInfo)));
    fillSensorTable(arr);
    v->begin = reinterpret_cast<uintptr_t>(arr);
    v->end = v->begin + 3 * sizeof(SensorInfo);
    v->endcap = v->end;
    return ::ndk::ScopedAStatus::ok();
  }

  ::ndk::ScopedAStatus initialize(
      const ::aidl::android::hardware::common::fmq::MQDescriptor<
          aidl::android::hardware::sensors::Event,
          ::aidl::android::hardware::common::fmq::SynchronizedReadWrite>&
          eventQueueDescriptor,
      const ::aidl::android::hardware::common::fmq::MQDescriptor<
          int32_t,
          ::aidl::android::hardware::common::fmq::SynchronizedReadWrite>&
          wakeLockDescriptor,
      const std::shared_ptr<
          aidl::android::hardware::sensors::ISensorsCallback>&
          sensorsCallback) override {
    Log("wa-sensors: initialize\n");
    (void)eventQueueDescriptor;
    (void)wakeLockDescriptor;
    (void)sensorsCallback;
    // Accept the handshake; never produce events => the framework runs on an
    // idle queue. Must return success or the framework abandons this HAL.
    return ::ndk::ScopedAStatus::ok();
  }

  ::ndk::ScopedAStatus injectSensorData(
      const aidl::android::hardware::sensors::Event& event) override {
    (void)event;
    return ::ndk::ScopedAStatus::ok();
  }

  ::ndk::ScopedAStatus registerDirectChannel(
      const ISensors::SharedMemInfo& mem, int32_t* _aidl_return) override {
    (void)mem;
    static int32_t nextChannel = 1;
    *_aidl_return = nextChannel++;
    return ::ndk::ScopedAStatus::ok();
  }

  ::ndk::ScopedAStatus setOperationMode(ISensors::OperationMode mode) override {
    Log("wa-sensors: setOperationMode\n");
    (void)mode;
    return ::ndk::ScopedAStatus::ok();
  }

  ::ndk::ScopedAStatus unregisterDirectChannel(int32_t channelHandle) override {
    (void)channelHandle;
    return ::ndk::ScopedAStatus::ok();
  }

 private:
  using ISensors = aidl::android::hardware::sensors::ISensors;
};

}  // namespace

/* bionic/crt helper for static dtor registration (__cxa_atexit arg).
 * glibc headers declare `extern void __dso_handle;` — attach via asm label
 * to dodge the C++ identifier clash. */
extern "C" char dso_handle_obj asm("__dso_handle");
char dso_handle_obj asm("__dso_handle") = 0;

/* Entry point: we link without host crt (-nostartfiles) and run on bionic.
 * NOTE: stderr is a host-glibc data symbol; the bionic export is the FILE
 * struct itself, so fprintf(stderr) crashes on-device — we write(2) directly.
 * The kernel hands us rsp = [argc, argv.., NULL, envp..]; SysV ABI passes
 * args in registers. After main, exit_group(0). */
extern "C" int main(int argc, char** argv) {
  (void)argc;
  (void)argv;
  signal(SIGPIPE, SIG_IGN);
  auto svc = ::ndk::SharedRefBase::make<WaSensors>();
  auto bsp = svc->createBinder();  // binder co-owns the object: BOTH shared_ptrs
  // must stay alive for the whole process lifetime (the device SharedRefBase
  // dtor asserts when destroyed while the binder still references the object
  // — binder_interface_utils.h:62, field semantics mWeakRefcount{1}).
  ::AIBinder* binder =
      reinterpret_cast<::AIBinder*>(bsp.get());
  static_assert(sizeof(WaSensors) >= 0x50,
                "WaSensors must absorb the device BnSensors ctor field writes");
  if (binder == nullptr) {
    Log("wa-sensors: createBinder failed\n");
    return 1;
  }
  int32_t addRc = AServiceManager_addService(binder, kServiceName);
  if (addRc != 0) {
    char buf[64] = "wa-sensors: addService failed code=";
    unsigned i = 35;
    int32_t v = addRc;
    if (v < 0) {
      buf[i++] = '-';
      v = -v;
    }
    char digs[12];
    unsigned d = 0;
    do {
      digs[d++] = char('0' + v % 10);
      v /= 10;
    } while (v);
    while (d) buf[i++] = digs[--d];
    buf[i++] = '\n';
    buf[i] = 0;
    Log(buf);
    return 1;
  }
  Log("wa-sensors: registered android.hardware.sensors.ISensors/default (3 sensors)\n");
  // Serve binder transactions for the process lifetime (thread pool +
  // join; joinThreadPool returns only on driver death).
  ABinderProcess_setThreadPoolMaxThreadCount(4);
  ABinderProcess_startThreadPool();
  for (;;) ABinderProcess_joinThreadPool();
  return 0;
}

extern "C" __attribute__((naked)) void _start(void) {
  __asm__(
      ".intel_syntax noprefix\n"
      "mov rdi, [rsp]\n"          // argc
      "lea rsi, [rsp + 8]\n"      // argv
      "call main\n"
      "mov rdi, 0\n"              // exit_group(0)
      "mov rax, 231\n"
      "syscall\n"
      ".att_syntax prefix\n");
}
