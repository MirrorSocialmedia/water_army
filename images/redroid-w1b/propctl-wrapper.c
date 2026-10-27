/*
 * water_army W1b — oem-propctl wrapper (baked at /vendor/bin/oem-propctl)
 *
 * Why this wrapper exists (ADR-028):
 *  - ro.product.model of a REAL device contains spaces ("Pixel 8 Pro");
 *    the kernel-cmdline carrier forbids spaces, so the platform injects
 *    spaces as the token %20 (validated: real models never contain '%').
 *  - At early-init there is no usable shell in the stock image
 *    (/system/bin/sh is dynamically linked against the APEX linker which is
 *    not mounted yet), so the decode cannot happen in a .rc script — it
 *    happens HERE, in front of the real property writer.
 *  - The real writer is resetprop-rs (provenance: propctl.provenance.md),
 *    baked as /vendor/bin/oem-propctl-real. We do NOT name it `resetprop`
 *    (Magisk/KSU applet shadowing) and the wrapper keeps the rc contract a
 *    single absolute-path exec.
 *
 * Behaviour:
 *  - rewrites the literal token %20 -> ' ' in every argument;
 *  - fail-closed: any '%' occurrence that is NOT part of "%20" is rejected
 *    (the platform validator guarantees this never happens; if it does, the
 *    mapping is corrupted and we must NOT write a guessed value);
 *  - execs /vendor/bin/oem-propctl-real with the rewritten argv.
 *
 * Build: gcc -O2 -static (host-static x86_64; runs on the redroid container's
 * kernel regardless of bionic — static binaries need no libc on device).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define REAL_BIN_DEFAULT "/vendor/bin/oem-propctl-real"

/* Decode %20 -> space in-place. Returns 0 on success, -1 on stray '%'. */
static int decode20(char *s) {
  char *r = s, *w = s;
  while (*r) {
    if (*r == '%') {
      if (r[1] == '2' && r[2] == '0') {
        *w++ = ' ';
        r += 3;
      } else {
        return -1; /* stray % — fail closed (validator invariant) */
      }
    } else {
      *w++ = *r++;
    }
  }
  *w = '\0';
  return 0;
}

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    if (decode20(argv[i]) != 0) {
      fprintf(stderr, "oem-propctl: stray percent token in argument %d: %.40s\n", i, argv[i]);
      return 2;
    }
  }
  argv[0] = (char *)"oem-propctl-real";
  /* Test hook only: init never sets this env; production path is unchanged. */
  const char *real = getenv("OEM_PROPCTL_REAL");
  execv(real && *real ? real : REAL_BIN_DEFAULT, argv);
  fprintf(stderr, "oem-propctl: execv %s\n", real && *real ? real : REAL_BIN_DEFAULT);
  perror("oem-propctl");
  return 127;
}
