/*
 * tproxy-mini.c — R2 (Phase 2) Option-B (iptables REDIRECT) spike forwarder.
 *
 * Minimal single-target TCP forwarder for the REDIRECT pilot:
 *   app -> (kernel NAT REDIRECT) -> 0.0.0.0:<listen-port> --(this)--> <target-ip>:<target-port>
 *
 * poll()-based, pumps both directions with per-connection byte stats on
 * stderr:
 *   [conn] id=<n> tx_app=<bytes forwarded to target> tx_resp=<bytes returned to app> dur_ms=<ms>
 *
 * This is DIAGNOSTIC SPIKE TOOLING ONLY (tests/tools), not product code.
 * It exists to answer one question with payload evidence: can kernel-NAT
 * REDIRECT + a plain userspace forwarder carry device traffic end-to-end
 * in the redroid container (i.e. without tun2socks/gVisor in the path)?
 *
 * Notes / limits (deliberate for a spike):
 *   - single target (all connections go to the same ip:port)
 *   - idle connections dropped after 60s (poll timeout)
 *   - single process, not load-optimized
 *
 * usage: tproxy-mini <listen-port> <target-ip> <target-port>
 */
#define _DEFAULT_SOURCE 1
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <time.h>
#include <poll.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/socket.h>

#define BUF_SZ 8192

static long long now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (long long)t.tv_sec * 1000LL + t.tv_nsec / 1000000LL;
}

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "usage: tproxy-mini <listen-port> <target-ip> <target-port>\n");
    return 2;
  }
  int lport = atoi(argv[1]);
  const char *tip = argv[2];
  int tport = atoi(argv[3]);

  int lfd = socket(AF_INET, SOCK_STREAM, 0);
  if (lfd < 0) { perror("tproxy-mini: socket"); return 1; }
  int one = 1;
  setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in la;
  memset(&la, 0, sizeof la);
  la.sin_family = AF_INET;
  la.sin_addr.s_addr = INADDR_ANY;
  la.sin_port = htons((unsigned short)lport);
  if (bind(lfd, (struct sockaddr *)&la, sizeof la) < 0 || listen(lfd, 16) < 0) {
    perror("tproxy-mini: bind/listen");
    return 1;
  }
  fprintf(stderr, "tproxy-mini listening on :%d -> %s:%d\n", lport, tip, tport);

  int conn_id = 0;
  for (;;) {
    int c = accept(lfd, NULL, NULL);
    if (c < 0) { if (errno == EINTR) continue; break; }
    int id = ++conn_id;

    int u = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in ta;
    memset(&ta, 0, sizeof ta);
    ta.sin_family = AF_INET;
    ta.sin_port = htons((unsigned short)tport);
    long long t0 = now_ms();
    if (u < 0 || inet_pton(AF_INET, tip, &ta.sin_addr) != 1 ||
        connect(u, (struct sockaddr *)&ta, sizeof ta) < 0) {
      fprintf(stderr, "[conn] id=%d target-connect-fail DETAIL=%s dur_ms=%lld\n", id, strerror(errno), now_ms() - t0);
      if (c >= 0) close(c);
      if (u >= 0) close(u);
      continue;
    }

    /* pump: c = app side (post-REDIRECT), u = target side */
    int alive_c = 1, alive_u = 1; /* reading from c / from u still possible */
    long long b_c2u = 0, b_u2c = 0;
    char bc[BUF_SZ], bu[BUF_SZ];

    while (alive_c || alive_u) {
      struct pollfd pf[2];
      int np = 0;
      if (alive_c) { pf[np].fd = c; pf[np].events = POLLIN; np++; }
      if (alive_u) { pf[np].fd = u; pf[np].events = POLLIN; np++; }
      int pr = poll(pf, np, 60000);
      if (pr < 0) { if (errno == EINTR) continue; break; }
      if (pr == 0) { fprintf(stderr, "[conn] id=%d idle-drop dur_ms=%lld\n", id, now_ms() - t0); break; }
      for (int i = 0; i < np; i++) {
        if (!(pf[i].revents & (POLLIN | POLLHUP | POLLERR))) continue;
        int is_c2u = (pf[i].fd == c);
        char *buf = is_c2u ? bc : bu;
        ssize_t n = recv(pf[i].fd, buf, BUF_SZ, 0);
        if (n > 0) {
          int out = is_c2u ? u : c;
          size_t off = 0;
          while (off < (size_t)n) {
            ssize_t w = send(out, buf + off, (size_t)n - off, 0);
            if (w < 0) {
              if (errno == EINTR) continue;
              break; /* target/app gone — outer loop will catch the poll */
            }
            off += (size_t)w;
          }
          if (is_c2u) b_c2u += n; else b_u2c += n;
        } else {
          /* EOF or error on one side: half-close the other direction */
          if (is_c2u) { shutdown(u, SHUT_WR); alive_c = 0; }
          else { shutdown(c, SHUT_WR); alive_u = 0; }
        }
      }
    }
    fprintf(stderr, "[conn] id=%d tx_app=%lld tx_resp=%lld dur_ms=%lld\n", id, b_c2u, b_u2c, now_ms() - t0);
    close(c);
    close(u);
  }
  return 0;
}
