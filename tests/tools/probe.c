/*
 * probe.c — R2 (Phase 2) data-plane probe.
 *
 * Statically linked, zero-dependency TCP client with controlled geometry.
 * Built on the host (gcc -static), pushed to the redroid device and run via
 * adb; the host harness verifies both directions (request bytes via the
 * echo endpoint log, response bytes via the captured out-file).
 *
 * Geometry:  connect() -> [settle_ms sleep] -> send(payload-file)
 *            -> [mode action] -> read until EOF/read-timeout
 *
 * modes:
 *   full      send everything, then read until peer EOF
 *   halfclose send everything, shutdown(SHUT_WR), read until peer EOF
 *   sendclose send everything, close immediately (no read; nc-like)
 *
 * usage:
 *   probe <ip> <port> <payload-file|none> <out-file> <mode> [read-timeout-sec] [settle-ms]
 *
 * status line (stdout, single line, parseable):
 *   RC=<ok|read-timeout|read-error|send-fail|conn-fail> SENT=<n> RECV=<n>
 *       T_CONN_MS=<ms> T_TOTAL_MS=<ms> SETTLE_MS=<ms> [DETAIL=<str>]
 *
 * exit: 0 = cycle completed (status line says the outcome), 1 = hard fail,
 *       2 = usage/env error.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <time.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/socket.h>

static volatile sig_atomic_t alarmed = 0;
static void on_alarm(int sig) { (void)sig; alarmed = 1; }
/* Install WITHOUT SA_RESTART (glibc signal() sets it): an alarm must abort a
 * blocking recv() and stay aborted — otherwise a restarted recv swallows the
 * timeout and the probe lives past its read-timeout (observed 2026-10-20:
 * 30s timeout actually fired at ~60s when the peer's late response arrived). */
static void arm_alarm(unsigned secs) {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_alarm;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = 0; /* NO SA_RESTART */
  sigaction(SIGALRM, &sa, NULL);
  alarmed = 0;
  alarm(secs);
}
/* close without waiting for unacked data: linger 0 = RST, no hang. */
static void force_close(int fd) {
  struct linger lg = { .l_onoff = 1, .l_linger = 0 };
  setsockopt(fd, SOL_SOCKET, SO_LINGER, &lg, sizeof lg);
  close(fd);
}

static long long ms_since(const struct timespec *t0) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (long long)(t.tv_sec - t0->tv_sec) * 1000LL + (t.tv_nsec - t0->tv_nsec) / 1000000LL;
}

int main(int argc, char **argv) {
  if (argc < 6) {
    fprintf(stderr, "usage: probe <ip> <port> <payload-file|none> <out-file> <mode> [read-timeout-sec] [settle-ms]\n");
    return 2;
  }
  const char *ip = argv[1];
  int port = atoi(argv[2]);
  const char *payfile = argv[3];
  const char *outfile = argv[4];
  const char *mode = argv[5];
  int read_timeout = argc > 6 ? atoi(argv[6]) : 30;
  int settle_ms = argc > 7 ? atoi(argv[7]) : 0;

  signal(SIGALRM, on_alarm);
  struct timespec t0;
  clock_gettime(CLOCK_MONOTONIC, &t0);

  /* ---- payload (file or none) ---- */
  size_t paylen = 0;
  unsigned char *pay = NULL;
  if (strcmp(payfile, "none") != 0) {
    FILE *f = fopen(payfile, "rb");
    if (!f) { fprintf(stderr, "probe: open %s: %s\n", payfile, strerror(errno)); return 2; }
    if (fseek(f, 0, SEEK_END) != 0) { return 2; }
    long sz = ftell(f);
    if (sz < 0) { return 2; }
    fseek(f, 0, SEEK_SET);
    paylen = (size_t)sz;
    pay = malloc(paylen ? paylen : 1);
    if (paylen && fread(pay, 1, paylen, f) != paylen) { fprintf(stderr, "probe: short payload read\n"); return 2; }
    fclose(f);
  }

  /* ---- connect (10s alarm timeout) ---- */
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) { printf("RC=conn-fail DETAIL=socket:%s SENT=0 RECV=0 T_CONN_MS=-1 T_TOTAL_MS=%lld SETTLE_MS=%d\n", strerror(errno), ms_since(&t0), settle_ms); return 1; }
  struct sockaddr_in sa;
  memset(&sa, 0, sizeof sa);
  sa.sin_family = AF_INET;
  sa.sin_port = htons((unsigned short)port);
  if (inet_pton(AF_INET, ip, &sa.sin_addr) != 1) { printf("RC=conn-fail DETAIL=bad-ip SENT=0 RECV=0 T_CONN_MS=-1 T_TOTAL_MS=%lld SETTLE_MS=%d\n", ms_since(&t0), settle_ms); return 2; }
  alarmed = 0;
  arm_alarm(10);
  if (connect(fd, (struct sockaddr *)&sa, sizeof sa) < 0) {
    long long tc = ms_since(&t0);
    printf("RC=conn-fail DETAIL=%s SENT=0 RECV=0 T_CONN_MS=%lld T_TOTAL_MS=%lld SETTLE_MS=%d\n",
           alarmed ? "timeout" : strerror(errno), tc, tc, settle_ms);
    force_close(fd);
    return 1;
  }
  alarm(0);
  long long t_conn = ms_since(&t0);
  long long t_end;

  /* ---- settle: let the handshake fully stabilize before first payload byte
   *      (0 = send immediately after connect() returns, like nc/httpget) ---- */
  if (settle_ms > 0) {
    struct timespec sl = { settle_ms / 1000, (long)(settle_ms % 1000) * 1000000L };
    nanosleep(&sl, NULL);
  }

  /* ---- send payload (blocking, with a hard send-timeout alarm: on a broken
   *      tunnel the peer window may never open and send() can block forever) ---- */
  size_t sent = 0;
  int send_ok = 1;
  alarmed = 0;
  arm_alarm(15);
  for (size_t off = 0; off < paylen; ) {
    ssize_t n = send(fd, pay + off, paylen - off, 0);
    if (n < 0) {
      if (errno == EINTR) { if (alarmed) break; continue; }
      send_ok = 0;
      break;
    }
    off += (size_t)n;
    sent = off;
  }
  alarm(0);
  if (alarmed || (!send_ok && sent < paylen)) {
    t_end = ms_since(&t0);
    force_close(fd);
    printf("RC=send-timeout DETAIL=%s SENT=%zu RECV=0 T_CONN_MS=%lld T_TOTAL_MS=%lld SETTLE_MS=%d\n",
           alarmed ? "send-window-never-opened" : strerror(errno), sent, t_conn, t_end, settle_ms);
    return 1;
  }

  t_end = ms_since(&t0);
  if (strcmp(mode, "sendclose") == 0) {
    force_close(fd);
    printf("RC=send-close SENT=%zu RECV=0 T_CONN_MS=%lld T_TOTAL_MS=%lld SETTLE_MS=%d\n", sent, t_conn, t_end, settle_ms);
    return send_ok ? 0 : 1;
  }

  if (strcmp(mode, "halfclose") == 0) {
    shutdown(fd, SHUT_WR); /* selective close: I'm done writing, keep reading */
  }

  /* ---- read until EOF (alarm = read timeout), capture raw bytes ---- */
  FILE *out = fopen(outfile, "wb");
  if (!out) { printf("RC=hard-fail DETAIL=open-out:%s SENT=%zu RECV=0 T_CONN_MS=%lld T_TOTAL_MS=%lld SETTLE_MS=%d\n", strerror(errno), sent, t_conn, ms_since(&t0), settle_ms); return 1; }
  size_t recv_total = 0;
  char buf[16384];
  int read_errno = 0;
  arm_alarm(read_timeout > 0 ? (unsigned)read_timeout : 1u);
  for (;;) {
    ssize_t n = recv(fd, buf, sizeof buf, 0);
    if (n > 0) {
      if (fwrite(buf, 1, (size_t)n, out) != (size_t)n) { read_errno = ENOSPC; break; }
      recv_total += (size_t)n;
    } else if (n == 0) {
      break; /* peer FIN: clean close */
    } else {
      if (errno == EINTR) { if (alarmed) break; continue; }
      read_errno = errno;
      break;
    }
  }
  alarm(0);
  fclose(out);
  force_close(fd);
  t_end = ms_since(&t0);

  if (alarmed) {
    printf("RC=read-timeout SENT=%zu RECV=%zu T_CONN_MS=%lld T_TOTAL_MS=%lld SETTLE_MS=%d\n", sent, recv_total, t_conn, t_end, settle_ms);
    return 1;
  }
  if (read_errno) {
    printf("RC=read-error DETAIL=%s SENT=%zu RECV=%zu T_CONN_MS=%lld T_TOTAL_MS=%lld SETTLE_MS=%d\n", strerror(read_errno), sent, recv_total, t_conn, t_end, settle_ms);
    return 1;
  }
  if (!send_ok) {
    printf("RC=send-fail SENT=%zu RECV=%zu T_CONN_MS=%lld T_TOTAL_MS=%lld SETTLE_MS=%d\n", sent, recv_total, t_conn, t_end, settle_ms);
    return 1;
  }
  printf("RC=ok SENT=%zu RECV=%zu T_CONN_MS=%lld T_TOTAL_MS=%lld SETTLE_MS=%d\n", sent, recv_total, t_conn, t_end, settle_ms);
  return 0;
}
