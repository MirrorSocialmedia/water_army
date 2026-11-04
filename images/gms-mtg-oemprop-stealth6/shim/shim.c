/* WA-STEALTH6 gen10 E-route shim: hide writable+executable ("rwx") mappings
 * from /proc/self/maps readers (DevCheck wx check) via LD_PRELOAD.
 * nostdlib x86_64, raw syscalls for internals; real libc entry points are
 * resolved via dlsym(RTLD_NEXT) so all other callers pass through untouched.
 * Injected per-app (wrap prop) so the translator's own maps reads are safe. */

typedef unsigned long u64;
typedef long          i64;
typedef unsigned int  u32;

#define AT_FDCWD    (-100)
#define O_RDONLY    0
#define O_WRONLY    1
#define O_CREAT     0100
#define O_APPEND    01000
#define MFD_CLOEXEC 1U

#define SYS_read         0
#define SYS_write        1
#define SYS_openat       257
#define SYS_close        3
#define SYS_lseek        8
#define SYS_memfd_create 319
#define SYS_getpid       39

extern void *fmemopen(void *buf, u64 len, const char *mode);
extern void *dlsym(long handle, const char *name);
#define RTLD_NEXT ((void*)-1)

static int   (*real_open)(const char *, int, ...);
static int   (*real_openat)(int, const char *, int, ...);
static void *(*real_fopen)(const char *, const char *);
static int   (*real_fopen64)(const char *, const char *);

static void lazy_init(void) {
    if (real_open) return;
    real_open     = dlsym((long)RTLD_NEXT, "open");
    real_openat   = dlsym((long)RTLD_NEXT, "openat");
    real_fopen    = dlsym((long)RTLD_NEXT, "fopen");
    real_fopen64  = dlsym((long)RTLD_NEXT, "fopen64");
}

static i64 sc1(i64 n, i64 a) {
    register i64 _a asm("rdi") = a; (void)_a;
    asm volatile("syscall" : "+a"(n) : "D"(_a) : "rcx", "r11", "memory");
    return n;
}
static i64 sc2(i64 n, i64 a, i64 b) {
    register i64 _a asm("rdi") = a; (void)_a;
    register i64 _b asm("rsi") = b; (void)_b;
    asm volatile("syscall" : "+a"(n) : "D"(_a), "S"(_b) : "rcx", "r11", "memory");
    return n;
}
static i64 sc4(i64 n, i64 a, i64 b, i64 c, i64 d) {
    register i64 _a asm("rdi") = a;
    register i64 _b asm("rsi") = b;
    register i64 _c asm("rdx") = c;
    register i64 _d asm("r10") = d;
    register i64 _n asm("rax") = n;
    asm volatile("syscall" : "+r"(_n) : "0"(_n), "r"(_a), "r"(_b), "r"(_c), "r"(_d)
                 : "rcx", "r11", "memory");
    return _n;
}
static i64 sc3(i64 n, i64 a, i64 b, i64 c) {
    register i64 _a asm("rdi") = a; (void)_a;
    register i64 _b asm("rsi") = b; (void)_b;
    register i64 _c asm("rdx") = c; (void)_c;
    asm volatile("syscall" : "+a"(n) : "D"(_a), "S"(_b), "d"(_c)
                 : "rcx", "r11", "r8", "r9", "r10", "memory");
    return n;
}

static int streq(const char *a, const char *b) {
    while (*a && *b) { if (*a != *b) return 0; a++; b++; }
    return *a == 0 && *b == 0;
}

/* Is `p` a maps file of the current process?
 * Matches /proc/self/maps, /proc/thread-self/maps, /proc/<mypid>/maps */
static int is_self_maps(const char *p) {
    const char *m;
    u64 pid, v;
    if (p == 0) return 0;
    if (streq(p, "/proc/self/maps")) return 1;
    if (streq(p, "/proc/thread-self/maps")) return 1;
    m = p;
    if (m[0]=='/'&&m[1]=='p'&&m[2]=='r'&&m[3]=='o'&&m[4]=='c'&&m[5]=='/') m += 6;
    else return 0;
    if (*m < '0' || *m > '9') return 0;
    pid = (u64)sc1(SYS_getpid, 0);
    v = 0;
    while (*m >= '0' && *m <= '9') { v = v*10 + (u64)(*m - '0'); m++; }
    if (v != pid) return 0;
    return streq(m, "/maps");
}

static char bufbig[4*1024*1024]; /* raw read buffer */
static char bufout[4*1024*1024]; /* filtered content */
#define RINGN 4
static char ring[RINGN][1024*1024];
static u32  ringi;


/* Process gate: only DevCheck should see filtered maps; every other process
 * (incl. the ARC translator itself, for GuestMapShadow) passes through.
 * Detected lazily via /proc/self/cmdline (setArgV0'd to the package name). */
static int g_checked, g_target;
static u64 g_gated_pid = (u64)-1;
static int is_target(void) {
    char cb[128]; int n;
    u64 mypid = (u64)sc1(SYS_getpid, 0);
    if (g_checked && mypid == g_gated_pid) return g_target;  /* re-eval after fork */
    g_checked = 0; g_gated_pid = mypid;
    g_checked = 1;
    { i64 fd = sc3(SYS_openat, AT_FDCWD, (i64)(long)"/proc/self/cmdline", O_RDONLY);
      if (fd < 0) return 0;
      n = (int)sc3(SYS_read, fd, (i64)(long)cb, 127);
      sc1(SYS_close, fd); }
    if (n <= 0) return 0;
    { int i, j; const char *pat = "deviceinsight";
      for (i = 0; i + 13 <= n; i++) {
        for (j = 0; j < 13; j++) if (cb[i+j] != pat[j]) break;
        if (j == 13) { g_target = 1; return 1; } } }
    return 0;
}
static int hexu(char *o, u64 v) {
    char t[24]; int n=0, i;
    if (v==0) { *o++='0'; return 1; }
    while (v) { t[n++] = (char)('0' + v%10); v/=10; }
    for (i=n-1; i>=0; i--) *o++ = t[i];
    return n;
}
static void shimlog(const char *tag) {
    char m[64]; int n=0; i64 fd; const char *s;
    for (s=tag; *s; s++) m[n++]=*s;
    m[n++]=' '; m[n++]='p'; n += hexu(m+n, (u64)sc1(SYS_getpid,0));
    m[n++]='\n';
    fd = sc3(SYS_openat, AT_FDCWD, (i64)(long)"/data/local/tmp/shim.log",
             O_WRONLY|O_CREAT|O_APPEND);
    if (fd >= 0) { sc3(SYS_write, fd, (i64)(long)m, n); sc1(SYS_close, fd); }
}

/* Does this maps line's permission token contain both 'w' and 'x'? */
static int perm_wx(const char *line) {
    const char *p = line;
    char tok[8]; int n=0, i, hasw=0, hasx=0;
    while (*p && *p != ' ') p++;
    while (*p == ' ') p++;
    while (*p && *p != ' ' && n < 7) tok[n++] = *p++;
    tok[n] = 0;
    if (n < 4) return 0;
    for (i=0; i<n; i++) { if (tok[i]=='w') hasw=1; if (tok[i]=='x') hasx=1; }
    return hasw && hasx;
}

/* Read maps from real fd, filter rwx lines into `out`; return out length. */
static i64 filter_maps(i64 rfd, char *out) {
    i64 total = 0, w = 0, i;
    while (total < (i64)sizeof(bufbig)) {
        i64 r = sc3(SYS_read, rfd, (i64)(long)(bufbig+total), 65536);
        if (r <= 0) break;
        total += r;
    }
    i = 0;
    while (i < total) {
        i64 s = i;
        while (i < total && bufbig[i] != '\n') i++;
        { i64 e = (i < total) ? i+1 : i;
          if (!perm_wx(bufbig + s)) { i64 k; for (k=s;k<e;k++) out[w++]=bufbig[k]; }
          i = e; }
    }
    return w;
}

int open(const char *path, int flags, ...) {
    int mode = 0;
    __builtin_va_list ap; __builtin_va_start(ap, flags);
    mode = __builtin_va_arg(ap, int); __builtin_va_end(ap);
    if (is_self_maps(path) && is_target()) {
        i64 rfd = sc3(SYS_openat, AT_FDCWD, (i64)(long)path, O_RDONLY);
        if (rfd < 0) return (int)rfd;
        { i64 w = filter_maps(rfd, bufout), off = 0, mfd;
          sc1(SYS_close, rfd);
          mfd = sc2(SYS_memfd_create, (i64)(long)"shim-maps", MFD_CLOEXEC);
          if (mfd < 0) return -1;
          while (off < w) { i64 r = sc3(SYS_write, mfd, (i64)(long)(bufout+off), w-off);
                            if (r <= 0) break; off += r; }
          sc2(SYS_lseek, mfd, 0);
          shimlog("maps-open");
          return (int)mfd; }
    }
    lazy_init();
    if (real_open) return real_open(path, flags, mode);
    return (int)sc4(SYS_openat, AT_FDCWD, (i64)(long)path, flags, mode);
}

int openat(int dirfd, const char *path, int flags, ...) {
    int mode = 0;
    __builtin_va_list ap; __builtin_va_start(ap, flags);
    mode = __builtin_va_arg(ap, int); __builtin_va_end(ap);
    if (dirfd == AT_FDCWD && is_self_maps(path) && is_target())
        return open(path, flags, mode);
    lazy_init();
    if (real_openat) return real_openat(dirfd, path, flags, mode);
    return (int)sc4(SYS_openat, dirfd, (i64)(long)path, flags, mode);
}

void *fopen(const char *path, const char *mode) {
    if (is_self_maps(path) && is_target()) {
        i64 rfd = sc3(SYS_openat, AT_FDCWD, (i64)(long)path, O_RDONLY);
        if (rfd < 0) return 0;
        { i64 w = filter_maps(rfd, bufout), k; char *rb;
          if (w > (i64)sizeof(ring[0])) w = (i64)sizeof(ring[0]);
          rb = ring[ringi & (RINGN-1)]; ringi++;
          for (k=0;k<w;k++) rb[k]=bufout[k];
          sc1(SYS_close, rfd);
          shimlog("maps-fopen");
          return fmemopen(rb, (u64)w, "r"); }
    }
    lazy_init();
    if (real_fopen) return real_fopen(path, mode);
    return 0;
}

void *fopen64(const char *path, const char *mode) {
    if (is_self_maps(path) && is_target()) return fopen(path, mode);
    lazy_init();
    if (real_fopen64) return (void*)(long)(*real_fopen64)(path, mode);
    return fopen(path, mode);
}

__attribute__((constructor)) static void shim_ctor(void) {
    /* v4: stay silent here. Writing the log file from ctor hung adbd's
     * CNXN in its sandboxed /data view (fuse daemon churn). Logging only
     * happens on actual /proc/self/maps hits, in the target app only. */
    (void)shimlog;
}
