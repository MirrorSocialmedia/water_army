/* =============================================================================
 * redroid-binder-init — Stage A bootstrap entrypoint (container-local, static)
 *
 * WHY a C binary (not a shell script)
 * -----------------------------------
 * The stock redroid image defers its runtime APEX (bionic/linker) to a mount
 * performed by Android `init` at boot. Before that mount, every dynamically
 * linked /system/bin binary is un-executable:
 *   /system/bin/linker64 -> /apex/com.android.runtime/bin/linker64  (broken
 *   until init mounts the APEX), so `exec /system/bin/sh` from an entrypoint
 *   dies with "no such file or directory" (verified 2026-10-19, image
 *   redroid/redroid:14.0.0-240527). Only statically linked binaries — or
 *   binaries using /system/bin/bootstrap/linker64 (the pre-APEX linker that
 *   `init` itself uses) — can run at entrypoint time.
 *
 * WHAT IT DOES (all container-local; the host is never touched)
 * -------------------------------------------------------------
 *  1. Mounts a PRIVATE binderfs instance at /mnt/redroid-binder (container
 *     mount namespace only).
 *  2. Allocates the binder / hwbinder / vndbinder nodes via the
 *     binder-control ioctl BINDER_CTL_ADD (kernel 6.8 uapi,
 *     include/uapi/linux/android/binderfs.h — a plain write(2) to the control
 *     file does NOT work).
 *  3. Replaces the /dev/{binder,hwbinder,vndbinder} entries (a copied dir +
 *     stray control node from the host /dev snapshot — on this host that dir
 *     is a binderfs MOUNT, which is why the stock image aborts with
 *     "Opening '/dev/binder' failed: Is a directory") with real char devices
 *     via bind mounts over touch'd targets.
 *  4. execs the stock entrypoint verbatim:
 *       /init qemu=1 androidboot.hardware=redroid [all docker-run args...]
 *     (the image's original ENTRYPOINT is ["/init","qemu=1",
 *     "androidboot.hardware=redroid"]; docker-run args are androidboot.*
 *     properties forwarded as kernel-cmdline-style init arguments).
 *
 * Build (x86-64 static):
 *   gcc -O2 -static -o redroid-binder-init redroid-binder-init.c
 * ============================================================================= */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

#define BINDERFS_ROOT "/mnt/redroid-binder"

/* From include/uapi/linux/android/binderfs.h (kernel 6.8) — inlined so the
 * build needs no kernel headers. */
#define BINDERFS_MAX_NAME 255
struct binderfs_device {
    char name[BINDERFS_MAX_NAME + 1];
    unsigned int major;
    unsigned int minor;
};
#define BINDER_CTL_ADD _IOWR('b', 1, struct binderfs_device)

static void add_binder_node(const char *ctl_path, const char *name) {
    struct binderfs_device dev;
    memset(&dev, 0, sizeof(dev));
    if (strlen(name) >= BINDERFS_MAX_NAME) {
        fprintf(stderr, "redroid-binder-init: device name too long: %s\n", name);
        exit(126);
    }
    strcpy(dev.name, name);

    int fd = open(ctl_path, O_RDWR | O_CLOEXEC);
    if (fd < 0) {
        fprintf(stderr, "redroid-binder-init: open %s: %s\n", ctl_path, strerror(errno));
        exit(126);
    }
    if (ioctl(fd, BINDER_CTL_ADD, &dev) < 0) {
        /* EEXIST is fine on re-entry; anything else is fatal — Android init
         * cannot run without a usable /dev/binder. */
        if (errno != EEXIST) {
            fprintf(stderr, "redroid-binder-init: BINDER_CTL_ADD '%s' on %s: %s\n",
                    name, ctl_path, strerror(errno));
            close(fd);
            exit(126);
        }
    }
    close(fd);
}

/* Recursive remove of a path under /dev (file, symlink, or directory — the
 * host /dev snapshot copied /dev/binder as a DIRECTORY with stray nodes on
 * this host). Defensively umounts first if the path is a mount point. */
static void rmrf_dev(const char *path) {
    struct stat st;
    if (lstat(path, &st) < 0) {
        if (errno == ENOENT) return;
        fprintf(stderr, "redroid-binder-init: lstat %s: %s\n", path, strerror(errno));
        return;
    }
    if (S_ISDIR(st.st_mode)) {
        /* If it is a mount point, drop the mount first (container-local). */
        if (umount(path) < 0 && errno != EINVAL && errno != ENOENT && errno != EPERM) {
            /* not a mount (or already unmounted) — continue */
        }
        DIR *d = opendir(path);
        if (d) {
            struct dirent *e;
            while ((e = readdir(d)) != NULL) {
                if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
                char child[512];
                snprintf(child, sizeof(child), "%s/%s", path, e->d_name);
                rmrf_dev(child);
            }
            closedir(d);
        }
        if (rmdir(path) < 0) {
            fprintf(stderr, "redroid-binder-init: rmdir %s: %s (continuing)\n", path, strerror(errno));
        }
        return;
    }
    if (unlink(path) < 0 && errno != ENOENT) {
        fprintf(stderr, "redroid-binder-init: unlink %s: %s (continuing)\n", path, strerror(errno));
    }
}

static void bind_dev_node(const char *src, const char *dst) {
    rmrf_dev(dst);
    int fd = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        fprintf(stderr, "redroid-binder-init: touch %s: %s\n", dst, strerror(errno));
        exit(126);
    }
    close(fd);
    if (mount(src, dst, NULL, MS_BIND, NULL) < 0) {
        fprintf(stderr, "redroid-binder-init: bind-mount %s -> %s: %s\n", src, dst, strerror(errno));
        exit(126);
    }
}

int main(int argc, char **argv) {
    /* 1. private binderfs instance (fresh per start; MS_NOSUGGEST is not
     * available on all kernels — plain mount). */
    if (mkdir(BINDERFS_ROOT, 0755) < 0 && errno != EEXIST) {
        fprintf(stderr, "redroid-binder-init: mkdir %s: %s\n", BINDERFS_ROOT, strerror(errno));
        return 126;
    }
    if (mount("binder", BINDERFS_ROOT, "binder", MS_NOATIME | MS_NOSUID, NULL) < 0) {
        fprintf(stderr, "redroid-binder-init: mount binderfs at %s: %s\n", BINDERFS_ROOT, strerror(errno));
        return 126;
    }

    /* 2. allocate the three nodes */
    char ctl[256];
    snprintf(ctl, sizeof(ctl), "%s/binder-control", BINDERFS_ROOT);
    add_binder_node(ctl, "binder");
    add_binder_node(ctl, "hwbinder");
    add_binder_node(ctl, "vndbinder");

    /* 2b. control-created nodes come up 0600 root:root on kernel 6.8
     * (observed 2026-10-19 via stat; AOSP devices expose binderfs nodes at
     * 0666). Android vendor services run as uid 1000 (radio/system) and
     * uid 1002, so 0600 aborts every binder client: 'Permission denied'.
     * Match the on-device semantics: world-rw. */
    if (chmod(BINDERFS_ROOT "/binder", 0666) < 0 ||
        chmod(BINDERFS_ROOT "/hwbinder", 0666) < 0 ||
        chmod(BINDERFS_ROOT "/vndbinder", 0666) < 0) {
        fprintf(stderr, "redroid-binder-init: chmod 0666: %s\n", strerror(errno));
        exit(126);
    }

    /* 3. publish them at the paths Android's libbinder opens */
    char src[320];
    snprintf(src, sizeof(src), "%s/binder", BINDERFS_ROOT);
    bind_dev_node(src, "/dev/binder");
    snprintf(src, sizeof(src), "%s/hwbinder", BINDERFS_ROOT);
    bind_dev_node(src, "/dev/hwbinder");
    snprintf(src, sizeof(src), "%s/vndbinder", BINDERFS_ROOT);
    bind_dev_node(src, "/dev/vndbinder");

    /* 4. hand over to the stock entrypoint, args forwarded unchanged */
    const char *fixed[] = {"/init", "qemu=1", "androidboot.hardware=redroid"};
    char **new_argv = calloc((size_t)argc + 4, sizeof(char *));
    if (!new_argv) return 126;
    int n = 0;
    new_argv[n++] = (char *)fixed[0];
    new_argv[n++] = (char *)fixed[1];
    new_argv[n++] = (char *)fixed[2];
    for (int i = 1; i < argc; i++) new_argv[n++] = argv[i];
    new_argv[n] = NULL;
    execv(fixed[0], new_argv);
    fprintf(stderr, "redroid-binder-init: execv /init: %s\n", strerror(errno));
    return 127;
}
