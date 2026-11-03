// One-shot probe (WA-STEALTH6 T2 debugging): answers, from a vendor-ns
// binary like wa-sensors: is my VINTF fragment visible to the client-side
// isDeclared gate, and does the SM client path work at all?
#include <unistd.h>

extern "C" {
int AServiceManager_isDeclared(const char* instance);
void AServiceManager_forEachDeclaredInstance(const char* package_name,
                                             void* context,
                                             void (*callback)(const char*, void*));
struct AIBinder* AServiceManager_getService(const char* instance);
}

static void Say(const char* msg) {
  unsigned l = 0;
  while (msg[l]) l++;
  ::write(2, msg, l);
}

static void Decl(const char* inst, void* ctx) {
  (void)ctx;
  Say("  instance: ");
  Say(inst);
  Say("\n");
}

extern "C" int main() {
  static const char* names[] = {
      "android.hardware.sensors.ISensors/default",
      "android.hardware.health.IHealth/default",
  };
  for (auto n : names) {
    Say("isDeclared(");
    Say(n);
    Say(") = ");
    Say(AServiceManager_isDeclared(n) ? "true" : "false");
    Say("\n");
  }
  Say("forEachDeclaredInstance(android.hardware.sensors):\n");
  AServiceManager_forEachDeclaredInstance("android.hardware.sensors", nullptr,
                                          Decl);
  Say("getService(health) = ");
  Say(AServiceManager_getService(names[1]) ? "non-null" : "NULL");
  Say("\n");
  return 0;
}

extern "C" void _start() {
  asm volatile(
      "movq %%rsp, %%rdi\n call main\n"
      "movq $231, %%rdi\n movq $0, %%rsi\n call exit_group\n"
      :::
      "memory");
}
