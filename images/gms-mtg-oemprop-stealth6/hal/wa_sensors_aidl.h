/*
 * WA-STEALTH6 T2 — minimal AIDL sensors HAL: generated-code declarations.
 *
 * Hand-written subset of the AOSP-generated NDK C++ surface for
 * android.hardware.sensors (AIDL package version 2, android14-release),
 * ABI-verified against the device's own
 * /system/lib64/android.hardware.sensors-V2-ndk.so (exported symbols +
 * BnSensors onTransact vtable slots disassembled on rdev-fx2, 2026-11-03):
 *
 *   - ndk::BnCInterface<ISensors>::asBinder + BnSensors::{ctor,dtor,
 *     createBinder} live in the device library (linked, not re-implemented).
 *   - ISensors virtual slot order == AIDL source order == the alphabetical
 *     order below (vtable call offsets 0x30..0x78 observed in the
 *     onTransact disassembly; base slots 0x00..0x28 belong to
 *     ndk::ICInterface/RefBase and are owned by the device base classes).
 *   - SensorInfo field order/types mirror the android14-release
 *     aidl/.../SensorInfo.aidl parcelable (the ONE struct this binary
 *     constructs and the device writer serializes = the only layout that
 *     must match byte-for-byte; other types cross as const& only).
 *
 * Provenance of the source files: AOSP android14-release
 * hardware/interfaces/sensors/aidl (ISensors.aidl / SensorInfo.aidl fetched
 * from android.googlesource.com 2026-11-03); see build-record.md.
 */
#ifndef WA_SENSORS_AIDL_H
#define WA_SENSORS_AIDL_H

#include <cstdint>
#include <cstdlib>
#include <atomic>
#include <memory>
#include <string>
#include <vector>

/* libbinder_ndk C core (exported, LIBBINDER_NDK versioned) */
extern "C" {
struct AStatus;
struct AIBinder;
struct AParcel;
void AStatus_delete(AStatus* status);
bool AStatus_isOk(const AStatus* status);
AStatus* AStatus_fromExceptionCode(int32_t exceptionCode);
/* Returns binder_exception_t (int; 0 = EX_NONE) in this libbinder_ndk
 * generation (android14-release service_manager.cpp) — NOT a bool. */
int32_t AServiceManager_addService(AIBinder* binder, const char* instance);
/* libbinder_ndk process plumbing (also exported by the system copy the
 * vendor namespace resolves): without a thread pool the kernel binder
 * driver never delivers transactions to our onTransact (measured on fx2:
 * addService succeeds, then SensorService blocks forever in connect). */
void ABinderProcess_setThreadPoolMaxThreadCount(uint32_t numThreads);
void ABinderProcess_startThreadPool();
int32_t ABinderProcess_joinThreadPool();
}

namespace ndk {

/* Layout must match the device's ndk::ScopedAStatus { AStatus* }. */
class ScopedAStatus {
 public:
  ScopedAStatus() : mStatus(nullptr) {}
  explicit ScopedAStatus(AStatus* status) : mStatus(status) {}
  ScopedAStatus(const ScopedAStatus&) = delete;
  ScopedAStatus(ScopedAStatus&& other) noexcept : mStatus(other.mStatus) {
    other.mStatus = nullptr;
  }
  ScopedAStatus& operator=(ScopedAStatus&& other) noexcept {
    if (mStatus) AStatus_delete(mStatus);
    mStatus = other.mStatus;
    other.mStatus = nullptr;
    return *this;
  }
  ~ScopedAStatus() {
    if (mStatus) AStatus_delete(mStatus);
  }
  bool isOk() const { return mStatus == nullptr || AStatus_isOk(mStatus); }
  /* AStatus is a HEAP object (`new Status`, status.cpp) — the generated
   * onTransact dereferences it in AParcel_writeStatusHeader, so the old
   * nullptr-as-ok convention segfaulted on-device (measured fx2 2026-11-03:
   * Status::writeToParcel this=0). ok() must allocate. */
  static ScopedAStatus ok() {
    return ScopedAStatus(AStatus_fromExceptionCode(0 /*EX_NONE*/));
  }
  static ScopedAStatus fromStatus(AStatus* status) {
    return ScopedAStatus(status);
  }
  static ScopedAStatus fromExceptionCode(int32_t code) {
    return ScopedAStatus(AStatus_fromExceptionCode(code));
  }

 private:
  AStatus* mStatus;
};

/* Smart pointer over AIBinder (only the accessors we use are inline). */
class SpAIBinder {
 public:
  SpAIBinder() : mBinder(nullptr) {}
  explicit SpAIBinder(AIBinder* binder) : mBinder(binder) {}
  SpAIBinder(const SpAIBinder& other);
  SpAIBinder(SpAIBinder&& other) noexcept : mBinder(other.mBinder) {
    other.mBinder = nullptr;
  }
  ~SpAIBinder();
  SpAIBinder& operator=(const SpAIBinder& other);
  AIBinder* get() const { return mBinder; }

 private:
  AIBinder* mBinder;
};

/* Defined header-only on device (ndk::SharedRefBase is inline refcounting;
 * make<> = plain shared_ptr(new T)). We keep our own trivial version. */
class SharedRefBase {
 public:
  /* Layout mirrors the device build (binder_interface_utils.h, android-14):
   * vptr@0, mStrongRefcount@8, mWeakRefcount@12, mWeakStorage@16 — the
   * device BnSensors ctor writes exactly (1,1) at 0x8 + nulls at 0x10..0x48
   * (disassembly 2026-11-03), and the device SharedRefBase dtor asserts
   * weak==0 on those fields. Our ctor pre-initialises them so the assert
   * and weak bookkeeping work on REAL fields, not filler garbage. */
  SharedRefBase() : mStrongRefcount(1), mWeakRefcount(1), mWeakStorage(nullptr) {}
  virtual ~SharedRefBase() {}
  template <typename T, typename... Args>
  static std::shared_ptr<T> make(Args&&... args) {
    return std::shared_ptr<T>(new T(std::forward<Args>(args)...));
  }

 private:
  std::atomic<int32_t> mStrongRefcount;
  std::atomic<int32_t> mWeakRefcount;
  void* mWeakStorage;
};

/*
 * ndk::ICInterface. Slot layout EMPIRICALLY pinned on-device (live vtable
 * dumps of BpSensors / BnSensors / BnSensorsCallback in system_server
 * 2026-11-03): the 10 ISensors interface methods sit at vptr+0x40..0x88
 * (BpSensors: activate..flush at 0x40..0x88, then its getInterfaceVersion/
 * Hash appended; BnSensorsCallback: its 2 methods at 0x40,0x48) => exactly
 * SIX base virtual slots precede them (dtor pair + getInterfaceVersion +
 * getInterfaceHash + two opaque base virtuals). We mirror the COUNT with
 * safe inline implementations; their semantics (asBinder/RefBase glue) are
 * never reached via vtable from the binder dispatch path (AIBinder_Class
 * glue calls onTransact with the raw object pointer; our overrides at
 * 0x40..0x88 are what onTransact dispatches to).
 *
 * mDevFields_ absorbs the device BnSensors constructor's field writes
 * (it zeroes/stores refcount + weak + binder-storage words up to object
 * offset 0x48 = sizeof(BnSensors)==0x50 on the device build); we never
 * read them. sizeof guard enforced in the service .cpp.
 */
class ICInterface {
 public:
  ICInterface() {}
  virtual ~ICInterface() {}
  virtual ScopedAStatus getInterfaceVersion(int32_t* _aidl_return) {
    *_aidl_return = 2;  // android.hardware.sensors package version 2
    return ScopedAStatus::ok();
  }
  virtual ScopedAStatus getInterfaceHash(std::string* _aidl_return) {
    *_aidl_return = "0123456789abcdef0123456789abcdef";  // 32-char stub
    return ScopedAStatus::ok();
  }

 protected:
  virtual void _wa_base_slot_4() {}
  virtual void _wa_base_slot_5() {}
  void* mDevFields_[6];  // device-constructor scratch region (opaque)
};

template <typename T>
class CInterface {};

template <typename T>
class BnCInterface : public virtual T, public CInterface<T> {
 public:
  BnCInterface() {}
  virtual ~BnCInterface() {}
  std::shared_ptr<T> asBinder();  // instantiated (weak) in the device lib
};

}  // namespace ndk

namespace aidl {
namespace android {
namespace hardware {
namespace common {
namespace fmq {

struct SynchronizedReadWrite {};

/*
 * MQDescriptor<T, E> — crosses only as `const&` into our initialize()
 * (BnSensors decodes it with the device's own layout), so we only need an
 * opaque complete type for the signature.
 */
template <typename T, typename E>
struct MQDescriptor {
  int32_t opaque_[16];
};

}  // namespace fmq

/* NativeHandle crosses as const& only (decoded by the device). */
struct NativeHandle {
  int32_t opaque_[16];
};

}  // namespace common
}  // namespace hardware
}  // namespace android
}  // namespace aidl

namespace aidl {
namespace android {
namespace hardware {
namespace sensors {

/* Event crosses as const& only (decoded by the device for injectSensorData). */
class Event {
 public:
  int32_t opaque_[64];
};

namespace fmqns = ::aidl::android::hardware::common::fmq;

class ISensorsCallback {
 public:
  int32_t opaque_[16];
};

/* Nested types of ISensors (AIDL places them in the interface class scope).
 * SharedMemInfo crosses as const& only (registerDirectChannel) => opaque. */

/*
 * SensorInfo — THE struct we construct; the device-generated writer reads
 * fields at these offsets. Order/types == android14-release
 * sensors/aidl/.../SensorInfo.aidl (15 fields; verified against the
 * readFromParcel disassembly: I,S,S,I,I,S,F,F,F,I,I,I,S,I,I).
 */
struct SensorInfo;

/* libc++ std::string POD mirror — the DEVICE build reads SensorInfo string
 * fields as libc++ strings (24 bytes). Our host compiler's std::string is
 * libstdc++ (32 bytes, different layout): measured on fx2 (Scudo misaligned
 * free in getSensorsList unparcel, 2026-11-03) — the generated writer read
 * our fields at libc++ offsets and mis-freed. Layout (little endian):
 *   short (len<=22): bytes[0..21]=data, byte[23] = len<<1 (LSB 0 = !is_long)
 *   long:            {data* @0, size @8, (capacity*2|1) @16}
 * mkstr() allocates long buffers with malloc (same heap as the device's
 * free(); the device's ~string frees them — one allocation per call, and
 * the service hands out a FRESH copy per getSensorsList so the static
 * table is never destroyed by the binder glue). */
struct WaString {
  alignas(8) char raw[24];
};
static_assert(sizeof(WaString) == 24, "libc++ std::string mirror");

inline WaString mkstr(const char* s) {
  WaString w{};
  unsigned n = 0;
  while (s[n]) n++;
  if (n <= 22) {
    // libc++ short form: byte0 = (len<<1) (LSB 0 = !is_long), data at 1..n.
    w.raw[0] = static_cast<char>(n << 1);
    for (unsigned i = 0; i < n; i++) w.raw[1 + i] = s[i];
    w.raw[1 + n] = '\0';
  } else {
    char* d = static_cast<char*>(malloc(n + 1));
    for (unsigned i = 0; i <= n; i++) d[i] = s[i];
    *reinterpret_cast<void**>(w.raw) = d;
    *reinterpret_cast<size_t*>(w.raw + 8) = n;
    *reinterpret_cast<size_t*>(w.raw + 16) = static_cast<size_t>(n + 1) * 2 + 1;
  }
  return w;
}

struct SensorInfo {
  int32_t sensorHandle;
  WaString name;
  WaString vendor;
  int32_t version;
  int32_t type;  // SensorType @Backing(int)
  WaString typeAsString;
  float maxRange;
  float resolution;
  float power;
  int32_t minDelayUs;
  int32_t fifoReservedEventCount;
  int32_t fifoMaxEventCount;
  WaString requiredPermission;
  int32_t maxDelayUs;
  int32_t flags;
};

/*
 * ISensors — abstract interface. Method order == AIDL source order ==
 * alphabetical (verified: onTransact dispatch calls virtual slots
 * 0x30,0x38,0x40,0x48,0x50,0x58,0x60,0x68,0x70,0x78 in the
 * activate,batch,configDirectReport,unregisterDirectChannel,getSensorsList,
 * initialize,injectSensorData,registerDirectChannel,setOperationMode,flush
 * slot layout = AIDL declaration order in android14-release ISensors.aidl).
 */
class ISensors : public ::ndk::ICInterface {
 public:
  enum class RateLevel : int32_t {
    STOP = 0,
    NORMAL = 1,
    FAST = 2,
    VERY_FAST = 3
  };
  enum class OperationMode : int32_t { NORMAL = 0, DATA_INJECTION = 1 };
  enum class SharedMemType : int32_t { ASHMEM = 1, GRALLOC = 2 };
  enum class SharedMemFormat : int32_t { SENSORS_EVENT = 1 };
  struct SharedMemInfo {
    int32_t opaque_[16];
  };

  ISensors();
  virtual ~ISensors();

  virtual ::ndk::ScopedAStatus activate(int32_t in_sensorHandle, bool in_enabled);
  virtual ::ndk::ScopedAStatus batch(int32_t in_sensorHandle,
                                     int64_t in_samplingPeriodNs,
                                     int64_t in_maxReportLatencyNs);
  virtual ::ndk::ScopedAStatus configDirectReport(
      int32_t in_sensorHandle, int32_t in_channelHandle,
      ISensors::RateLevel in_rate, int32_t* _aidl_return);
  virtual ::ndk::ScopedAStatus flush(int32_t in_sensorHandle);
  virtual ::ndk::ScopedAStatus getSensorsList(std::vector<SensorInfo>* _aidl_return);
  virtual ::ndk::ScopedAStatus initialize(
      const ::aidl::android::hardware::common::fmq::MQDescriptor<
          Event, ::aidl::android::hardware::common::fmq::SynchronizedReadWrite>&
          in_eventQueueDescriptor,
      const ::aidl::android::hardware::common::fmq::MQDescriptor<
          int32_t,
          ::aidl::android::hardware::common::fmq::SynchronizedReadWrite>&
          in_wakeLockDescriptor,
      const std::shared_ptr<ISensorsCallback>& in_sensorsCallback);
  virtual ::ndk::ScopedAStatus injectSensorData(const Event& in_event);
  virtual ::ndk::ScopedAStatus registerDirectChannel(
      const ISensors::SharedMemInfo& in_mem, int32_t* _aidl_return);
  virtual ::ndk::ScopedAStatus setOperationMode(ISensors::OperationMode in_mode);
  virtual ::ndk::ScopedAStatus unregisterDirectChannel(int32_t in_channelHandle);
};

/*
 * BnSensors — the device-generated server base (ctor/dtor exported by
 * android.hardware.sensors-V2-ndk.so; it wires the binder class + onTransact
 * and calls the ISensors virtuals above). We declare ctor/dtor only.
 */
class BnSensors : public ISensors, public ::ndk::BnCInterface<ISensors> {
 public:
  BnSensors();
  virtual ~BnSensors();
  /* Device-instantiated (exported T): AIBinder_new(BnSensors class, this)
   * + markVintfStability; returns shared_ptr whose get() is the AIBinder*
   * handle (ownership of the object transfers to the binder's refcounts =
   * our SharedRefBase fields). We call THIS directly (non-virtual PLT) and
   * bypass the asBinder() weak machinery: asBinder reads a std::mutex at
   * this+0x20 and dispatches createBinder through vtable slot 0x90
   * (disassembly 2026-11-03), both outside the layout we mirror. */
  std::shared_ptr<ICInterface> createBinder();
};

}  // namespace sensors
}  // namespace hardware
}  // namespace android
}  // namespace aidl

#endif  // WA_SENSORS_AIDL_H
