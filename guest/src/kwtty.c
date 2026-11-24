// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * kwtty: terminal sessions over AF_VSOCK (static aarch64 musl),
 * `kwbox tty` in the base's kw layer (kwbox.c), started by inittab as
 * "::respawn:/usr/bin/kwbox tty serve". The host side is
 * js/core/tty.ts.
 *
 *   kwtty serve [PORT]   serve the host (CID 2) on PORT (default 1022, so
 *                        only root can bind it); without a vsock device
 *                        (no kwvsock) it sleeps forever, so respawn does
 *                        not loop
 *   kwtty login          the console's login shell (init runs it on the
 *                        console, its controlling terminal): the user
 *                        kw.user=NAME on the kernel command line names, else
 *                        the default user; the terminal is given to that
 *                        user, as login(1) does
 *
 * The default user is the account "user" when /etc/passwd has it (the
 * distro images), else root (the base shell). A session or the console
 * runs as its user with that user's supplementary groups (/etc/group),
 * HOME, USER, LOGNAME, SHELL and a login shell's PATH, in its home.
 *
 * Each connection is one session: its own pty with its own size, and a
 * user's login shell on it, or the program OPEN names (no authentication:
 * only the host can connect). With the PIPES option there is no pty: the program's
 * stdin, stdout and stderr are pipes, and it runs in a session of its own.
 * With the CONNECT option there is no program: kwtty connects to a TCP
 * port on 127.0.0.1 and, after OPENED, relays raw bytes both ways.
 * Frames,
 * both directions: u8 type, u8 flags (bit 0 critical: a receiver that does
 * not know the type sends ERROR and closes; unknown other types are
 * skipped), u16 payload length, payload. Integers are little-endian.
 *
 *   host -> guest  1 OPEN    u16 max_version (1), rows, cols, xpixel,
 *                            ypixel, then options to the end: u8 tag (bit 7
 *                            critical), u16 length, value; tag 1 TERM
 *                            (default xterm-256color), 2 ENV (one KEY=VALUE,
 *                            repeatable, over the defaults), 3 ARG (one
 *                            argument, repeatable: the first is the program,
 *                            looked up in PATH; none: the user's login
 *                            shell), 4 CWD (default the user's home), 5
 *                            PIPES (empty: pipes instead of a pty; the size
 *                            is ignored, and TERM is set only when given), 6
 *                            CONNECT (u16 TCP port: connect to
 *                            127.0.0.1:port before OPENED; the other options
 *                            are ignored), 7 USER (the user to run as: a
 *                            name, or a uid in decimal; empty: the default
 *                            user; without USER the session is root's, as
 *                            before the option, so a host that does not
 *                            know it keeps its sessions), 8 DETACH (u32
 *                            timeout in ms, 0 for 60 s, then the session id:
 *                            1 to 64 of A-Z a-z 0-9 . _ -; a detachable
 *                            session, below; refused with PIPES, ignored
 *                            with CONNECT), 9 ATTACH (a session id: take
 *                            over that detachable session instead of
 *                            starting one; the size is the window's now,
 *                            and every other option but REPLAY is
 *                            ignored), 10 REPLAY (empty, with ATTACH: send
 *                            the session's recent output first)
 *                  2 DATA    bytes for the pty, or stdin (zero length: no-op)
 *                  3 RESIZE  u16 rows, cols, xpixel, ypixel (pty only)
 *                  6 SIGNAL  a signal name without "SIG" ("INT", "TERM"),
 *                            sent to the program; unknown names are ignored
 *                  7 EOF     with PIPES: close the program's stdin; ignored
 *                            on a pty
 *   guest -> host  1 OPENED  u16 version, u32 features (bit 0: PIPES, EOF
 *                            and STDERR; bit 1: CONNECT; bit 2: USER; bit 3:
 *                            DETACH, ATTACH and REPLAY), u32 program pid
 *                            (0 with CONNECT), u32 pts number (0xffffffff
 *                            with PIPES or CONNECT)
 *                  2 DATA    bytes from the pty, or stdout
 *                  4 EXIT    u8 how (0 exited, 1 signal), u8 exit status or
 *                            signal number, u8 core dumped
 *                  5 ERROR   a message; the guest closes after it
 *                  8 STDERR  with PIPES: bytes from stderr
 *
 * OPEN comes first, once, within 10 s. The guest closes the connection
 * right after EXIT, once the pty (or both pipes) has no more output. When
 * the host closes the connection, the session is hung up (SIGHUP; with
 * PIPES to the program's process group).
 *
 * CONNECT: a failed connect is an ERROR whose message starts with the errno
 * name (EOTHER for one without a name here) and ": " ("ECONNREFUSED:
 * connect to 127.0.0.1:80: Connection refused"). After OPENED there are no more frames either way: the
 * connection is a raw byte stream to the TCP socket. EOF on one side is a
 * shutdown(SHUT_WR) on the other, so half-closes pass through; the relay
 * ends once both directions are done, or at the first error or reset
 * (then both sockets are closed).
 *
 * Detachable sessions (DETACH, on a pty): when the connection is reset
 * under the session (the socket's error is ECONNRESET, which only kwvsock's
 * snapshot restore notifier sets on a connected socket: a restored kernel
 * resets every connection its new host does not know), the session is
 * detached instead of hung up: its program and pty stay, kwtty goes on
 * reading the pty, and a later connection with ATTACH and the same id
 * takes it over (OPENED again, the same pid and pts). A host's own close
 * (EOF, EPIPE) still hangs it up, as does a protocol error. A session left
 * detached for its timeout (DETACH's, default 60 s of the guest's monotonic
 * clock, which a restore continues) is hung up. ATTACH while another
 * connection has the session takes it over and closes that one. An unknown
 * id, or a session that ended, is an ERROR "ENOENT: ...". The program
 * exiting while detached keeps the session until an attach, which gets the
 * replay and then EXIT.
 *
 * A detachable session keeps the last 64 KiB of the pty's output. REPLAY
 * sends it after OPENED, for a fresh terminal: it starts where no escape
 * sequence or UTF-8 character is cut (at a line start when there is one in
 * its first 4 KiB), behind the DEC private modes in force there (cursor
 * keys, the alternate screen, mouse reporting, bracketed paste, ...), which
 * kwtty follows in the output it drops from the ring. Then, when the
 * output has the alternate screen on (a full-screen program), ATTACH's
 * size is set one row short and 150 ms later in full, so that the program
 * gets SIGWINCH twice and redraws its screen; otherwise the size is just
 * set (SIGWINCH if it changed). A RESIZE to another size meanwhile cancels
 * the second step.
 *
 * The handover: the process forked for the ATTACH connection connects to
 * the session's abstract unix socket "\0kwtty/<id>" (bound by the session
 * at OPEN, so a second session with the id is refused: "EEXIST: ..."), and
 * passes the vsock socket with SCM_RIGHTS and the size; the session takes
 * it only from a root peer (SO_PEERCRED) and answers one byte.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <poll.h>
#include <pty.h>
#include <pwd.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <stddef.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#include <linux/vm_sockets.h>

/* The default port; js/core/tty.ts has it as TTY_PORT. */
#define KWTTY_PORT	1022
#define KWTTY_VERSION	1

/* Frame types: host -> guest, then guest -> host (DATA is 2 both ways). */
#define T_OPEN		1
#define T_DATA		2
#define T_RESIZE	3
#define T_SIGNAL	6
#define T_EOF		7
#define T_OPENED	1
#define T_EXIT		4
#define T_ERROR		5
#define T_STDERR	8
#define F_CRITICAL	0x01
#define TAG_TERM	1
#define TAG_ENV		2
#define TAG_ARG		3
#define TAG_CWD		4
#define TAG_PIPES	5
#define TAG_CONNECT	6
#define TAG_USER	7
#define TAG_DETACH	8
#define TAG_ATTACH	9
#define TAG_REPLAY	10
#define TAG_CRITICAL	0x80
#define FEAT_PIPES	0x01		/* OPENED: PIPES, EOF and STDERR */
#define FEAT_CONNECT	0x02		/* OPENED: CONNECT */
#define FEAT_USER	0x04		/* OPENED: USER */
#define FEAT_DETACH	0x08		/* OPENED: DETACH, ATTACH and REPLAY */
#define FEATURES	(FEAT_PIPES | FEAT_CONNECT | FEAT_USER | FEAT_DETACH)
#define NO_PTS		0xffffffffU
/* The account sessions and the console run as unless asked otherwise. */
#define DEFAULT_USER	"user"
/* A login shell's PATH (kw-path.sh), for programs started directly: the
 * host's commands (kwcmd), ~/.local/bin, the system's, the kw shims. */
#define PATH_FMT	"PATH=/run/kw/bin:%s/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/kw/bin"

#define HDR		4
#define OUT_MAX		16384		/* pty output per DATA frame */
#define OPEN_MS		10000		/* time the host has for OPEN */
#define DRAIN_MS	50		/* output after the shell exited */
#define DRAIN_MAX	(1 << 20)	/* and at most this much of it */
#define HANGUP_MS	1000		/* wait for the shell after a hangup */
#define CONNECT_MS	10000		/* CONNECT: time for the TCP connect */
#define RELAY_BUF	65536		/* CONNECT: bytes in flight per direction */
#define PROBE_MS	1000		/* CONNECT: how often to check an idle host side */
#define ID_MAX		64		/* DETACH: a session id's length */
#define DETACH_MS	60000		/* DETACH: how long a session waits detached, by default */
#define RING		65536		/* DETACH: the output kept for REPLAY */
#define LINE_SKIP	4096		/* REPLAY: how far to look for a line start */
#define JIGGLE_MS	150		/* ATTACH: between the two sizes of a redraw */
#define HANDOVER_MS	5000		/* ATTACH: for the session to take the connection */

static unsigned int get16(const unsigned char *p)
{
	return p[0] | p[1] << 8;
}

static void put16(unsigned char *p, unsigned int v)
{
	p[0] = v;
	p[1] = v >> 8;
}

static uint32_t get32(const unsigned char *p)
{
	return get16(p) | (uint32_t)get16(p + 2) << 16;
}

static void put32(unsigned char *p, uint32_t v)
{
	put16(p, v);
	put16(p + 2, v >> 16);
}

static int64_t now_ms(void)
{
	struct timespec t;

	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec * 1000LL + t.tv_nsec / 1000000;
}

static void __attribute__((noreturn)) idle(void)
{
	for (;;)
		pause();
}

/* Before OPENED: blocking I/O on the non-blocking socket, with a deadline. */
static int send_all(int s, const unsigned char *p, size_t len, int64_t end)
{
	while (len) {
		struct pollfd pf = { .fd = s, .events = POLLOUT };
		ssize_t n = send(s, p, len, MSG_NOSIGNAL);
		int64_t left;

		if (n > 0) {
			p += n;
			len -= n;
			continue;
		}
		if (errno != EAGAIN && errno != EINTR)
			return -1;
		left = end - now_ms();
		if (left <= 0 || (poll(&pf, 1, left) < 0 && errno != EINTR))
			return -1;
	}
	return 0;
}

static int recv_all(int s, unsigned char *p, size_t len, int64_t end)
{
	while (len) {
		struct pollfd pf = { .fd = s, .events = POLLIN };
		ssize_t n = recv(s, p, len, 0);
		int64_t left;

		if (n > 0) {
			p += n;
			len -= n;
			continue;
		}
		if (n == 0 || (errno != EAGAIN && errno != EINTR))
			return -1;
		left = end - now_ms();
		if (left <= 0) {
			errno = ETIMEDOUT;
			return -1;
		}
		if (poll(&pf, 1, left) < 0 && errno != EINTR)
			return -1;
	}
	return 0;
}

/* ERROR before OPENED, then close. */
static void __attribute__((noreturn, format(printf, 2, 3)))
refuse(int s, const char *fmt, ...)
{
	unsigned char f[HDR + 256];
	va_list ap;
	int n;

	va_start(ap, fmt);
	n = vsnprintf((char *)f + HDR, sizeof(f) - HDR, fmt, ap);
	va_end(ap);
	if (n < 0)
		n = 0;
	if (n > (int)(sizeof(f) - HDR - 1))
		n = sizeof(f) - HDR - 1;
	f[0] = T_ERROR;
	f[1] = 0;
	put16(f + 2, n);
	send_all(s, f, HDR + n, now_ms() + 2000);
	close(s);
	_exit(0);
}

struct open_req {
	struct winsize ws;
	char term[65];
	char **env;			/* ENV options, in order */
	int nenv;
	char **argv;			/* ARG options, NULL-terminated; none: a login shell */
	int nargv;
	char *cwd;
	int pipes;			/* PIPES: no pty */
	int has_term;			/* TERM was given */
	int connect;			/* CONNECT: relay to a TCP port */
	unsigned int port;		/* its port */
	char *user;			/* USER: a name or uid ("": the default user); NULL: root */
	int detach;			/* DETACH: a detachable session */
	uint32_t detach_ms;		/* its timeout (0: DETACH_MS) */
	int attach;			/* ATTACH: take over the session `id` */
	int replay;			/* REPLAY: with ATTACH */
	char id[ID_MAX + 1];		/* DETACH's or ATTACH's session id */
};

/* A session id: 1 to ID_MAX of A-Z a-z 0-9 . _ - (it names a socket). */
static int copy_id(char *id, const unsigned char *v, size_t len)
{
	if (!len || len > ID_MAX)
		return -1;
	for (size_t i = 0; i < len; i++) {
		unsigned char c = v[i];

		if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
		      (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-'))
			return -1;
	}
	memcpy(id, v, len);
	id[len] = 0;
	return 0;
}

/* Parses OPEN's payload; NULL, or what is wrong with it. */
static const char *parse_open(const unsigned char *p, size_t len, struct open_req *o)
{
	size_t off;

	if (len < 10)
		return "OPEN is too short";
	if (get16(p) < 1)
		return "unsupported version (max_version 0)";
	o->ws.ws_row = get16(p + 2);
	o->ws.ws_col = get16(p + 4);
	o->ws.ws_xpixel = get16(p + 6);
	o->ws.ws_ypixel = get16(p + 8);
	strcpy(o->term, "xterm-256color");
	o->env = calloc(len / 3 + 1, sizeof(*o->env));
	o->argv = calloc(len / 3 + 1, sizeof(*o->argv));
	if (!o->env || !o->argv)
		return "out of memory";
	for (off = 10; off < len;) {
		const unsigned char *v, *eq;
		unsigned int tag;
		size_t vlen;

		if (len - off < 3)
			return "truncated OPEN option";
		tag = p[off];
		vlen = get16(p + off + 1);
		off += 3;
		if (vlen > len - off)
			return "truncated OPEN option";
		v = p + off;
		off += vlen;
		switch (tag & ~TAG_CRITICAL) {
		case TAG_TERM:
			if (vlen > 64)
				return "TERM is longer than 64 bytes";
			for (size_t i = 0; i < vlen; i++)
				if (v[i] < 0x20 || v[i] > 0x7e)
					return "TERM is not printable ASCII";
			memcpy(o->term, v, vlen);
			o->term[vlen] = 0;
			o->has_term = 1;
			break;
		case TAG_ENV:
			eq = memchr(v, '=', vlen);
			if (!eq || eq == v || memchr(v, 0, vlen))
				return "ENV is not KEY=VALUE";
			o->env[o->nenv] = strndup((const char *)v, vlen);
			if (!o->env[o->nenv++])
				return "out of memory";
			break;
		case TAG_ARG:
			if (memchr(v, 0, vlen) || (!o->nargv && !vlen))
				return "ARG has a NUL, or the program is empty";
			o->argv[o->nargv] = strndup((const char *)v, vlen);
			if (!o->argv[o->nargv++])
				return "out of memory";
			break;
		case TAG_CWD:
			if (!vlen || memchr(v, 0, vlen))
				return "CWD is empty or has a NUL";
			free(o->cwd);
			o->cwd = strndup((const char *)v, vlen);
			if (!o->cwd)
				return "out of memory";
			break;
		case TAG_PIPES:
			o->pipes = 1;
			break;
		case TAG_CONNECT:
			if (vlen != 2 || !get16(v))
				return "CONNECT is not a u16 port from 1";
			o->connect = 1;
			o->port = get16(v);
			break;
		case TAG_USER:
			if (vlen > 64 || memchr(v, 0, vlen))
				return "USER is longer than 64 bytes or has a NUL";
			free(o->user);
			o->user = strndup((const char *)v, vlen);
			if (!o->user)
				return "out of memory";
			break;
		case TAG_DETACH:
			if (vlen < 4 || copy_id(o->id, v + 4, vlen - 4))
				return "DETACH is not a u32 timeout and a session id of 1 to 64 of A-Z a-z 0-9 . _ -";
			o->detach = 1;
			o->detach_ms = get32(v);
			break;
		case TAG_ATTACH:
			if (copy_id(o->id, v, vlen))
				return "ATTACH is not a session id of 1 to 64 of A-Z a-z 0-9 . _ -";
			o->attach = 1;
			break;
		case TAG_REPLAY:
			o->replay = 1;
			break;
		default:
			if (tag & TAG_CRITICAL)
				return "unknown critical OPEN option";
		}
	}
	return NULL;
}

/* The account a session or the console runs as (its passwd entry, copied). */
struct account {
	char *name, *home, *shell;
	uid_t uid;
	gid_t gid;
};

static int copy_account(const struct passwd *pw, struct account *a)
{
	a->name = strdup(pw->pw_name && *pw->pw_name ? pw->pw_name : "root");
	a->home = strdup(pw->pw_dir && *pw->pw_dir ? pw->pw_dir : "/");
	a->shell = strdup(pw->pw_shell && *pw->pw_shell ? pw->pw_shell : "/bin/sh");
	a->uid = pw->pw_uid;
	a->gid = pw->pw_gid;
	return a->name && a->home && a->shell ? 0 : -1;
}

/*
 * spec: NULL root, "" the default user (DEFAULT_USER if it exists, else
 * root), a name, or a uid in decimal. -1 when there is no such account
 * (root without a passwd entry is still root, as before).
 */
static int find_account(const char *spec, struct account *a)
{
	struct passwd *pw = NULL, root = {
		.pw_name = "root", .pw_dir = "/", .pw_shell = "/bin/sh",
	};
	const char *s;

	if (spec && !*spec)
		pw = getpwnam(DEFAULT_USER);
	else if (spec) {
		for (s = spec; *s >= '0' && *s <= '9'; s++)
			;
		if (*s || s - spec > 9)
			pw = getpwnam(spec);
		else
			pw = getpwuid(atoi(spec));
		if (!pw && strcmp(spec, "root") && strcmp(spec, "0"))
			return -1;
	}
	if (!pw)
		pw = getpwuid(0);
	return copy_account(pw ? pw : &root, a);
}

/*
 * In the child, before exec: give the terminal on fd 0 (if it is one) to
 * the account, as login(1) does (owner, group tty, 0620), then take the
 * account's groups and ids. 0, or -errno.
 *
 * The session may also raise its threads' priority as far as nice -20
 * (RLIMIT_NICE 40, soft and hard), as pam_limits lets a desktop's audio
 * users; these sessions do not go through PAM. SDL asks for nice -20 for
 * its audio thread, which at nice 0 shares the emulated CPU with the
 * program's other busy threads and misses its periods (ALSA underruns,
 * gaps in the sound). Best effort: a failure leaves the inherited limit.
 */
static int become(const struct account *a)
{
	static const struct rlimit renice = { 40, 40 };
	struct group *tty;

	if (isatty(0)) {
		tty = getgrnam("tty");
		if (fchown(0, a->uid, tty ? tty->gr_gid : a->gid) || fchmod(0, 0620))
			return -errno;
	}
	setrlimit(RLIMIT_NICE, &renice);
	if (initgroups(a->name, a->gid) || setgid(a->gid) || setuid(a->uid))
		return -errno;
	return 0;
}

/* The environment for the account: HOME, USER, LOGNAME, SHELL, PATH. */
static int account_env(const struct account *a, char *d[5])
{
	if (asprintf(&d[0], "HOME=%s", a->home) < 0 ||
	    asprintf(&d[1], "USER=%s", a->name) < 0 ||
	    asprintf(&d[2], "LOGNAME=%s", a->name) < 0 ||
	    asprintf(&d[3], "SHELL=%s", a->shell) < 0 ||
	    asprintf(&d[4], PATH_FMT, strcmp(a->home, "/") ? a->home : "") < 0)
		return -1;
	return 0;
}

/* Adds KEY=VALUE to env, replacing an earlier KEY. */
static void env_set(char **env, int *n, char *kv)
{
	size_t k = strchr(kv, '=') - kv + 1;

	for (int i = 0; i < *n; i++) {
		if (!strncmp(env[i], kv, k)) {
			env[i] = kv;
			return;
		}
	}
	env[(*n)++] = kv;
}

/* Every signal at its default and none blocked, whatever init passed on. */
static void default_signals(void)
{
	struct sigaction sa = { .sa_handler = SIG_DFL };
	sigset_t none;

	for (int i = 1; i < _NSIG; i++)
		sigaction(i, &sa, NULL);
	sigemptyset(&none);
	sigprocmask(SIG_SETMASK, &none, NULL);
}

/* The program, in the child: the pty or the pipes are its stdio already. */
static void __attribute__((noreturn))
shell_child(int ep, const struct account *a, const char *file, char **argv, char **env)
{
	struct termios t;
	int e;

	/* A negative number on the error pipe: becoming the account failed. */
	e = become(a);
	if (e) {
		write(ep, &e, sizeof(e));
		_exit(127);
	}

	default_signals();
	if (!tcgetattr(0, &t)) {
		t.c_iflag |= IUTF8;
		tcsetattr(0, TCSANOW, &t);
	}
	/* Only 0-2 stay, and the error pipe (close-on-exec) as 3. */
	if (ep != 3 && dup3(ep, 3, O_CLOEXEC) == 3)
		ep = 3;
	if (ep == 3)
		syscall(SYS_close_range, 4, ~0U, 0);
	/* execvp looks file up in the PATH of the environment it gets. */
	environ = env;
	execvp(file, argv);
	e = errno;
	write(ep, &e, sizeof(e));
	_exit(127);
}

/*
 * What REPLAY needs to know of a terminal's output: where escape sequences
 * and strings end (so a replay starts in the ground state), and the DEC
 * private modes (CSI ? Pm h / l), ESC = / ESC > and ESC c (a reset) set.
 * Enough of ECMA-48 / the VT500 parser for that, nothing more.
 */
enum { TS_GROUND, TS_ESC, TS_ESC_INT, TS_CSI, TS_STR, TS_STR_ESC };

/* The modes followed (bit i: dec_modes[i]); 7 (autowrap) and 25 (cursor shown) start on. */
static const unsigned short dec_modes[] = {
	1, 7, 25, 47, 1047, 1049, 9, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004,
};
#define MODES_DEFAULT	(1u << 1 | 1u << 2)
#define MODES_ALT	(1u << 3 | 1u << 4 | 1u << 5)
#define NPARAM		16

struct term {
	unsigned char st;
	unsigned char priv, bad;	/* CSI: "?" first; another private marker or an intermediate */
	unsigned char keypad;		/* ESC = (application keypad) */
	int np;
	unsigned int par[NPARAM];
	uint32_t modes;
};

static void term_init(struct term *t)
{
	memset(t, 0, sizeof(*t));
	t->modes = MODES_DEFAULT;
}

static void term_mode(struct term *t, unsigned int mode, int on)
{
	for (size_t i = 0; i < sizeof(dec_modes) / sizeof(dec_modes[0]); i++) {
		if (dec_modes[i] == mode) {
			if (on)
				t->modes |= 1u << i;
			else
				t->modes &= ~(1u << i);
		}
	}
}

static void term_esc(struct term *t, unsigned char b)
{
	t->st = TS_GROUND;
	switch (b) {
	case '[':
		t->st = TS_CSI;
		t->np = 0;
		t->par[0] = 0;
		t->priv = t->bad = 0;
		break;
	case ']': case 'P': case '_': case '^': case 'X':
		t->st = TS_STR;
		break;
	case '=':
		t->keypad = 1;
		break;
	case '>':
		t->keypad = 0;
		break;
	case 'c':
		term_init(t);
		break;
	case 0x1b:
		t->st = TS_ESC;
		break;
	default:
		if (b >= 0x20 && b <= 0x2f)
			t->st = TS_ESC_INT;
	}
}

static void term_feed1(struct term *t, unsigned char b)
{
	if (b == 0x18 || b == 0x1a) {	/* CAN, SUB: abort a sequence */
		t->st = TS_GROUND;
		return;
	}
	switch (t->st) {
	case TS_GROUND:
		if (b == 0x1b)
			t->st = TS_ESC;
		break;
	case TS_ESC:
		term_esc(t, b);
		break;
	case TS_ESC_INT:
		if (b == 0x1b)
			t->st = TS_ESC;
		else if (b >= 0x30 && b <= 0x7e)
			t->st = TS_GROUND;
		break;
	case TS_CSI:
		if (b >= '0' && b <= '9') {
			if (t->par[t->np] < 100000)
				t->par[t->np] = t->par[t->np] * 10 + (b - '0');
		} else if (b == ';' || b == ':') {
			if (t->np < NPARAM - 1)
				t->par[++t->np] = 0;
			else
				t->bad = 1;
		} else if (b >= 0x3c && b <= 0x3f) {
			if (b == '?' && !t->np && !t->par[0] && !t->priv)
				t->priv = 1;
			else
				t->bad = 1;
		} else if (b >= 0x20 && b <= 0x2f) {
			t->bad = 1;
		} else if (b >= 0x40 && b <= 0x7e) {
			if (t->priv && !t->bad && (b == 'h' || b == 'l'))
				for (int i = 0; i <= t->np; i++)
					term_mode(t, t->par[i], b == 'h');
			t->st = TS_GROUND;
		} else if (b == 0x1b) {
			t->st = TS_ESC;
		}
		break;
	case TS_STR:
		if (b == 0x07)
			t->st = TS_GROUND;
		else if (b == 0x1b)
			t->st = TS_STR_ESC;
		break;
	case TS_STR_ESC:
		/* ESC \ ends the string; ESC and anything else starts a new sequence. */
		if (b == '\\')
			t->st = TS_GROUND;
		else
			term_esc(t, b);
		break;
	}
}

/* The sequences that set a fresh terminal's modes as t has them; their length. */
static size_t term_modes(const struct term *t, char *out, size_t size)
{
	size_t n = 0;
	int alt = 0;

	for (size_t i = 0; i < sizeof(dec_modes) / sizeof(dec_modes[0]); i++) {
		uint32_t bit = 1u << i;
		int r;

		if ((t->modes & bit) == (MODES_DEFAULT & bit))
			continue;
		if (bit & MODES_ALT) {
			if (alt++)
				continue;
			r = snprintf(out + n, size - n, "\x1b[?1049h");
		} else {
			r = snprintf(out + n, size - n, "\x1b[?%u%c", dec_modes[i], t->modes & bit ? 'h' : 'l');
		}
		if (r < 0 || (size_t)r >= size - n)
			return n;
		n += r;
	}
	if (t->keypad && size - n > 2) {
		memcpy(out + n, "\x1b=", 2);
		n += 2;
	}
	return n;
}

struct session {
	int s, m, pfd;			/* socket (-1 while detached), pty master (-1 with PIPES), pidfd of the program */
	int ifd;			/* the program's input: the master or the stdin pipe; -1 once closed */
	int ofd[2];			/* its output: the master or the stdout pipe, and the stderr pipe (-1 on a pty) */
	int oend[2];			/* that output has ended (EIO on the master, EOF on a pipe) */
	int in_dead;			/* writes to `in` fail (nobody has the pty open, or EPIPE): discard input */
	int pipes, next;		/* PIPES; which output to read first */
	pid_t pid;
	int status, reaped, final;
	int64_t quiet_at;		/* since when output is drained */
	size_t drained;			/* output bytes since the shell exited */
	char err[200];			/* a protocol error, sent as ERROR */
	unsigned char out[HDR + OUT_MAX];	/* the frame being sent */
	size_t olen, ooff;
	unsigned char in[16384];	/* socket bytes not yet parsed */
	size_t ilen, ioff;
	enum { ST_HDR, ST_DATA, ST_ARG, ST_SKIP } st;
	unsigned char hdr[HDR], arg[16];	/* RESIZE's or SIGNAL's payload */
	size_t have, want, rem;		/* bytes in hdr or arg, of arg wanted, payload left */
	/* DETACH */
	int detachable;
	int lfd;			/* the session's unix socket for ATTACH, or -1 */
	char id[ID_MAX + 1];
	int64_t detach_ms;		/* how long it may stay detached */
	int64_t until;			/* while detached: when it is hung up */
	int out_done;			/* detached, and the program's output has ended: EXIT waits for an attach */
	uint32_t pts;
	unsigned char ring[RING];	/* the last RING bytes of output */
	uint64_t rtotal;		/* bytes ever put in the ring */
	struct term gone;		/* the terminal at the ring's oldest byte (fed what the ring drops) */
	struct term now;		/* and after its newest */
	unsigned char *rp;		/* the replay being sent, from rpoff to rplen */
	size_t rplen, rpoff;
	int64_t jiggle_at;		/* the second size of a redraw: when, and what */
	struct winsize jiggle_ws;
};

static struct session x;

/*
 * Close the program's side: closing the master hangs up the pty's session
 * (SIGHUP); pipes do not, so their process group gets SIGHUP instead.
 */
static void hangup(void)
{
	if (x.m >= 0)
		close(x.m);
	if (x.pipes) {
		if (x.ifd >= 0)
			close(x.ifd);
		for (int i = 0; i < 2; i++)
			if (x.ofd[i] >= 0)
				close(x.ofd[i]);
		if (!x.reaped)
			kill(-x.pid, SIGHUP);
	}
	x.m = x.ifd = x.ofd[0] = x.ofd[1] = -1;
}

/*
 * Hangup or end: drop what is not sent, hang up the program, close the
 * socket, give the program a moment, and exit; init reaps what is left.
 */
static void __attribute__((noreturn)) end_session(void)
{
	hangup();
	if (x.s >= 0)
		close(x.s);
	if (x.lfd >= 0)
		close(x.lfd);
	if (!x.reaped) {
		struct pollfd pf = { .fd = x.pfd, .events = POLLIN };

		if (poll(&pf, 1, HANGUP_MS) > 0)
			waitpid(x.pid, NULL, WNOHANG);
	}
	_exit(0);
}

/* DETACH: keep output for REPLAY; what falls out of the ring goes through `gone`. */
static void ring_put(const unsigned char *p, size_t n)
{
	for (size_t i = 0; i < n; i++)
		term_feed1(&x.now, p[i]);
	while (n) {
		size_t pos = x.rtotal % RING, k = RING - pos < n ? RING - pos : n;

		if (x.rtotal >= RING)
			for (size_t i = 0; i < k; i++)
				term_feed1(&x.gone, x.ring[pos + i]);
		memcpy(x.ring + pos, p, k);
		x.rtotal += k;
		p += k;
		n -= k;
	}
}

static void set_size(const struct winsize *ws)
{
	ioctl(x.m, TIOCSWINSZ, ws);
}

/* A redraw's second size, now (it was due, or the session detaches). */
static void jiggle_done(void)
{
	if (x.jiggle_at) {
		x.jiggle_at = 0;
		set_size(&x.jiggle_ws);
	}
}

static void free_replay(void)
{
	free(x.rp);
	x.rp = NULL;
	x.rplen = x.rpoff = 0;
}

/*
 * The connection was reset under a detachable session (a snapshot restore,
 * see the top): let it go and keep the program; an attach takes it again.
 * The frame in flight is dropped (its output is in the ring).
 */
static void detach(void)
{
	close(x.s);
	x.s = -1;
	x.olen = x.ooff = 0;
	x.ilen = x.ioff = 0;
	x.st = ST_HDR;
	x.have = x.rem = 0;
	free_replay();
	jiggle_done();
	x.until = now_ms() + x.detach_ms;
}

/*
 * The connection failed (e: the errno of the failed call, 0 for POLLERR):
 * detach if it was reset under a detachable session, else hang up. Only
 * kwvsock's restore notifier resets a connected vsock socket (ECONNRESET
 * as its error; recv and send then fail with ENOTCONN); the host's own
 * close is EOF or EPIPE.
 */
static void conn_lost(int e)
{
	int err = 0;
	socklen_t len = sizeof(err);

	if (!x.detachable || x.m < 0 || x.final || x.err[0])
		end_session();
	if (e != ECONNRESET && e != ENOTCONN &&
	    (getsockopt(x.s, SOL_SOCKET, SO_ERROR, &err, &len) || err != ECONNRESET))
		end_session();
	detach();
}

static void flush_out(void)
{
	if (x.s < 0) {
		x.olen = x.ooff = 0;	/* detached */
		return;
	}
	while (x.ooff < x.olen) {
		ssize_t n = send(x.s, x.out + x.ooff, x.olen - x.ooff, MSG_NOSIGNAL);

		if (n < 0) {
			if (errno == EAGAIN || errno == EINTR)
				return;
			conn_lost(errno);	/* EPIPE: the host hung up; ENOTCONN: reset */
			return;
		}
		x.ooff += n;
	}
	x.olen = x.ooff = 0;
	x.quiet_at = now_ms();
}

/* A frame for the host (dropped while detached). */
static void queue(unsigned int type, const void *p, size_t len)
{
	if (x.s < 0)
		return;
	x.out[0] = type;
	x.out[1] = 0;
	put16(x.out + 2, len);
	memmove(x.out + HDR, p, len);	/* p may be x.out + HDR */
	x.olen = HDR + len;
	x.ooff = 0;
	flush_out();
}

/* A protocol error: hang up the program now, send ERROR after the frame in flight. */
static void __attribute__((format(printf, 1, 2))) protocol_error(const char *fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vsnprintf(x.err, sizeof(x.err), fmt, ap);
	va_end(ap);
	hangup();
	x.ilen = x.ioff = 0;
}

static const struct { const char *name; int sig; } signals[] = {
	{ "HUP", SIGHUP }, { "INT", SIGINT }, { "QUIT", SIGQUIT }, { "ILL", SIGILL },
	{ "TRAP", SIGTRAP }, { "ABRT", SIGABRT }, { "BUS", SIGBUS }, { "FPE", SIGFPE },
	{ "KILL", SIGKILL }, { "USR1", SIGUSR1 }, { "SEGV", SIGSEGV }, { "USR2", SIGUSR2 },
	{ "PIPE", SIGPIPE }, { "ALRM", SIGALRM }, { "TERM", SIGTERM }, { "CHLD", SIGCHLD },
	{ "CONT", SIGCONT }, { "STOP", SIGSTOP }, { "TSTP", SIGTSTP }, { "TTIN", SIGTTIN },
	{ "TTOU", SIGTTOU }, { "URG", SIGURG }, { "XCPU", SIGXCPU }, { "XFSZ", SIGXFSZ },
	{ "VTALRM", SIGVTALRM }, { "PROF", SIGPROF }, { "WINCH", SIGWINCH }, { "IO", SIGIO },
	{ "PWR", SIGPWR }, { "SYS", SIGSYS },
};

/* SIGNAL: by name, to the program (until it is reaped); unknown names are ignored. */
static void do_signal(const unsigned char *name, size_t len)
{
	for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); i++) {
		if (strlen(signals[i].name) == len && !memcmp(signals[i].name, name, len)) {
			if (!x.reaped)
				kill(x.pid, signals[i].sig);
			return;
		}
	}
}

/* Feeds socket bytes through the frame parser; stops where the master is full. */
static void parse_input(void)
{
	while (x.ioff < x.ilen && !x.err[0]) {
		const unsigned char *p = x.in + x.ioff;
		size_t avail = x.ilen - x.ioff, n;
		ssize_t w;

		switch (x.st) {
		case ST_HDR:
			n = HDR - x.have < avail ? HDR - x.have : avail;
			memcpy(x.hdr + x.have, p, n);
			x.have += n;
			x.ioff += n;
			if (x.have < HDR)
				break;
			x.have = 0;
			x.rem = get16(x.hdr + 2);
			if (x.hdr[0] == T_DATA) {
				x.st = ST_DATA;
			} else if (x.hdr[0] == T_RESIZE) {
				if (x.rem < 8) {
					protocol_error("RESIZE is too short");
					return;
				}
				x.want = 8;
				x.st = ST_ARG;
			} else if (x.hdr[0] == T_SIGNAL) {
				x.want = x.rem < sizeof(x.arg) ? x.rem : sizeof(x.arg);
				x.st = ST_ARG;
			} else if (x.hdr[0] == T_EOF) {
				/* In order behind the DATA before it, which is written by now. */
				if (x.pipes && x.ifd >= 0) {
					close(x.ifd);
					x.ifd = -1;
				}
				x.st = ST_SKIP;
			} else if (x.hdr[0] == T_OPEN) {
				protocol_error("OPEN after OPEN");
				return;
			} else if (x.hdr[1] & F_CRITICAL) {
				protocol_error("unknown critical frame type %u", x.hdr[0]);
				return;
			} else {
				x.st = ST_SKIP;
			}
			break;
		case ST_DATA:
			n = x.rem < avail ? x.rem : avail;
			w = n;
			if (x.ifd >= 0 && !x.in_dead) {
				w = write(x.ifd, p, n);
				if (w < 0 && (errno == EAGAIN || errno == EINTR))
					return;
				if (w < 0) {
					/* EIO: nobody has the pty open; EPIPE: nobody reads stdin */
					if (errno == EPIPE)
						x.in_dead = 1;
					w = n;
				}
			}
			x.ioff += w;
			x.rem -= w;
			if ((size_t)w < n)
				return;
			break;
		case ST_ARG:
			n = x.want - x.have < avail ? x.want - x.have : avail;
			memcpy(x.arg + x.have, p, n);
			x.have += n;
			x.ioff += n;
			x.rem -= n;
			if (x.have < x.want)
				break;
			x.have = 0;
			if (x.hdr[0] == T_SIGNAL)
				do_signal(x.arg, x.want);
			else if (x.m >= 0) {
				struct winsize ws = {
					.ws_row = get16(x.arg), .ws_col = get16(x.arg + 2),
					.ws_xpixel = get16(x.arg + 4), .ws_ypixel = get16(x.arg + 6),
				};

				if (x.jiggle_at && ws.ws_row == x.jiggle_ws.ws_row && ws.ws_col == x.jiggle_ws.ws_col) {
					x.jiggle_ws = ws;	/* the redraw's second step sets it */
				} else {
					x.jiggle_at = 0;	/* another size wins over a redraw's */
					set_size(&ws);
				}
			}
			x.st = ST_SKIP;
			break;
		case ST_SKIP:
			n = x.rem < avail ? x.rem : avail;
			x.ioff += n;
			x.rem -= n;
			break;
		}
		if ((x.st == ST_DATA || x.st == ST_SKIP) && !x.rem)
			x.st = ST_HDR;
	}
	if (x.ioff == x.ilen)
		x.ilen = x.ioff = 0;
}

/* Shorten *t (ms; -1: none) to ms, which may be past (0). */
static void min_timeout(int *t, int64_t ms)
{
	if (ms < 0)
		ms = 0;
	if (ms > INT_MAX)
		ms = INT_MAX;
	if (*t < 0 || ms < *t)
		*t = ms;
}

/* Wait up to ms for fd to be readable (1), or not (0). */
static int poll_in(int fd, int ms)
{
	int64_t end = now_ms() + ms;

	for (;;) {
		struct pollfd pf = { .fd = fd, .events = POLLIN };
		int64_t left = end - now_ms();
		int r;

		if (left <= 0)
			return 0;
		r = poll(&pf, 1, left);
		if (r > 0)
			return 1;
		if (!r || errno != EINTR)
			return 0;
	}
}

static unsigned char ring_at(uint64_t off)
{
	return x.ring[off % RING];
}

/*
 * REPLAY: the ring as a fresh terminal needs it (see the top): the modes in
 * force where it starts, then its bytes from a point where nothing is cut.
 */
static void build_replay(void)
{
	uint64_t have = x.rtotal < RING ? x.rtotal : RING, start = x.rtotal - have;
	struct term t = x.gone;
	char modes[256];
	size_t i = 0, nm;

	free_replay();
	if (x.rtotal > RING) {
		/* The ring dropped bytes: its oldest may be inside a sequence or a character. */
		while (i < have && t.st != TS_GROUND)
			term_feed1(&t, ring_at(start + i++));
		while (i < have && (ring_at(start + i) & 0xc0) == 0x80)
			term_feed1(&t, ring_at(start + i++));
		/* And a line start, if one is near. */
		struct term u = t;

		for (size_t j = i; j < have && j - i < LINE_SKIP;) {
			unsigned char b = ring_at(start + j++);

			term_feed1(&u, b);
			if (b == '\n' && u.st == TS_GROUND) {
				i = j;
				t = u;
				break;
			}
		}
	}
	nm = term_modes(&t, modes, sizeof(modes));
	x.rp = malloc(nm + have - i);
	if (!x.rp)
		return;
	memcpy(x.rp, modes, nm);
	for (size_t j = i; j < have; j++)
		x.rp[nm + j - i] = ring_at(start + j);
	x.rplen = nm + have - i;
	x.rpoff = 0;
}

/*
 * ATTACH's size: set it (SIGWINCH if it changed); if it did not change and a
 * full-screen program has the terminal (the alternate screen), one row
 * short first and in full JIGGLE_MS later, so that it redraws.
 */
static void attach_size(struct winsize ws)
{
	struct winsize cur;

	x.jiggle_at = 0;
	if (ioctl(x.m, TIOCGWINSZ, &cur))
		memset(&cur, 0, sizeof(cur));
	if (!ws.ws_row || !ws.ws_col) {
		ws.ws_row = cur.ws_row;
		ws.ws_col = cur.ws_col;
	}
	if ((cur.ws_row == ws.ws_row && cur.ws_col == ws.ws_col) && x.now.modes & MODES_ALT && ws.ws_row > 1) {
		struct winsize t = ws;

		t.ws_row--;
		set_size(&t);
		x.jiggle_ws = ws;
		x.jiggle_at = now_ms() + JIGGLE_MS;
		return;
	}
	set_size(&ws);
}

/* Take over the session on vsock socket fd (ATTACH; msg: rows, cols, xpixel, ypixel, replay). */
static void attach(int fd, const unsigned char *msg)
{
	struct winsize ws = {
		.ws_row = get16(msg), .ws_col = get16(msg + 2),
		.ws_xpixel = get16(msg + 4), .ws_ypixel = get16(msg + 6),
	};
	unsigned char opened[14];

	if (x.s >= 0)
		close(x.s);	/* another connection had it: it ends, its host sees the session lost */
	x.s = fd;
	fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
	x.olen = x.ooff = 0;
	x.ilen = x.ioff = 0;
	x.st = ST_HDR;
	x.have = x.rem = 0;
	x.until = 0;
	free_replay();
	if (msg[8])
		build_replay();
	attach_size(ws);
	put16(opened, KWTTY_VERSION);
	put32(opened + 2, FEATURES);
	put32(opened + 6, x.pid);
	put32(opened + 10, x.pts);
	queue(T_OPENED, opened, sizeof(opened));
}

/*
 * A connection on the session's unix socket: an ATTACH handed over by the
 * process kwtty forked for it (see the top). Taken only from root, and only
 * while the session can go on; else that process sends the ERROR.
 */
static void take_attach(void)
{
	unsigned char msg[16];
	union {
		struct cmsghdr h;
		char buf[CMSG_SPACE(sizeof(int))];
	} cm;
	struct iovec iov = { .iov_base = msg, .iov_len = sizeof(msg) };
	struct msghdr mh = {
		.msg_iov = &iov, .msg_iovlen = 1,
		.msg_control = cm.buf, .msg_controllen = sizeof(cm.buf),
	};
	struct ucred cr;
	socklen_t crlen = sizeof(cr);
	struct cmsghdr *ch;
	int c, fd = -1;
	ssize_t n;

	c = accept4(x.lfd, NULL, NULL, SOCK_CLOEXEC);
	if (c < 0)
		return;
	if (getsockopt(c, SOL_SOCKET, SO_PEERCRED, &cr, &crlen) || cr.uid != 0 || !poll_in(c, HANDOVER_MS))
		goto out;
	n = recvmsg(c, &mh, MSG_CMSG_CLOEXEC);
	if (n > 0)
		for (ch = CMSG_FIRSTHDR(&mh); ch; ch = CMSG_NXTHDR(&mh, ch))
			if (ch->cmsg_level == SOL_SOCKET && ch->cmsg_type == SCM_RIGHTS && ch->cmsg_len >= CMSG_LEN(sizeof(int)))
				memcpy(&fd, CMSG_DATA(ch), sizeof(int));
	if (n < 9 || fd < 0 || x.m < 0 || x.final || x.err[0])
		goto out;
	if (send(c, "\1", 1, MSG_NOSIGNAL) != 1)
		goto out;
	close(c);
	attach(fd, msg);
	return;
out:
	if (fd >= 0)
		close(fd);
	close(c);
}

static void __attribute__((noreturn)) session_loop(void)
{
	for (;;) {
		/* socket, the two outputs, the input, the pidfd, the session's unix socket */
		struct pollfd p[6] = {
			{ .fd = x.s }, { .fd = -1 }, { .fd = -1 }, { .fd = -1 }, { .fd = -1 },
			{ .fd = x.lfd, .events = POLLIN },
		};
		int attached = x.s >= 0;
		int replaying = attached && x.rpoff < x.rplen;
		int open[2], rd[2];
		int mwrite = attached && x.ifd >= 0 && !x.in_dead && x.ioff < x.ilen;
		int sread = attached && !x.err[0] && x.ioff == x.ilen;
		int timeout = -1;
		int64_t now = now_ms();

		for (int i = 0; i < 2; i++) {
			open[i] = x.ofd[i] >= 0 && !x.oend[i];
			rd[i] = open[i] && !x.olen && !x.final && !replaying && !x.out_done;
		}

		if (x.final && !x.olen)
			end_session();
		if (x.err[0] && !x.olen) {
			queue(T_ERROR, x.err, strlen(x.err));
			x.final = 1;
			continue;
		}
		/* Detached: hung up once nobody attached within the timeout. */
		if (!attached) {
			if (now >= x.until)
				end_session();
			min_timeout(&timeout, x.until - now);
		}
		if (x.jiggle_at) {
			if (now >= x.jiggle_at)
				jiggle_done();
			else
				min_timeout(&timeout, x.jiggle_at - now);
		}
		/* REPLAY goes first, before new output. */
		if (replaying && !x.olen) {
			size_t n = x.rplen - x.rpoff < OUT_MAX ? x.rplen - x.rpoff : OUT_MAX;
			const unsigned char *rp = x.rp + x.rpoff;

			x.rpoff += n;
			queue(T_DATA, rp, n);	/* copies it before a failed send could free it */
			if (x.rp && x.rpoff >= x.rplen)
				free_replay();
			continue;
		}
		/*
		 * The program has exited: the output ends with EIO once
		 * nothing has the pty open (EOF on both pipes), or, while
		 * background jobs keep it open, after DRAIN_MS without output
		 * (EAGAIN right after the exit is not the end: the flip buffer
		 * may still be in flight), or after DRAIN_MAX bytes: what the
		 * program's own children left behind is far less, and a
		 * background job that keeps printing (yes & exit) must not
		 * keep the session open. Detached, EXIT waits for an attach.
		 */
		if (x.reaped && !x.final && !x.olen && !replaying && (attached || !x.out_done)) {
			int64_t left = x.quiet_at + DRAIN_MS - now;

			if (x.out_done || !(open[0] || open[1]) || left <= 0 || x.drained > DRAIN_MAX) {
				unsigned char e[3] = { 0, WEXITSTATUS(x.status), 0 };

				if (!attached) {
					x.out_done = 1;
					continue;
				}
				if (WIFSIGNALED(x.status)) {
					e[0] = 1;
					e[1] = WTERMSIG(x.status);
					e[2] = !!WCOREDUMP(x.status);
				}
				queue(T_EXIT, e, sizeof(e));
				x.final = 1;
				continue;
			}
			min_timeout(&timeout, left);
		}
		/*
		 * The host's close is a SHUTDOWN, which vsock_poll() reports as
		 * POLLRDHUP (with POLLIN), not POLLHUP: ask for it always, so a
		 * hangup is seen while socket reads are paused.
		 */
		if (attached)
			p[0].events = POLLRDHUP | (sread ? POLLIN : 0) | (x.olen ? POLLOUT : 0);
		/*
		 * A master or pipe with nothing asked would spin on POLLHUP:
		 * leave it out then. On a pty the master is in twice, once per
		 * direction.
		 */
		for (int i = 0; i < 2; i++) {
			if (rd[i]) {
				p[1 + i].fd = x.ofd[i];
				p[1 + i].events = POLLIN;
			}
		}
		if (mwrite) {
			p[3].fd = x.ifd;
			p[3].events = POLLOUT;
		}
		if (!x.reaped) {
			p[4].fd = x.pfd;
			p[4].events = POLLIN;
		}
		if (poll(p, 6, timeout) < 0) {
			if (errno == EINTR)
				continue;
			end_session();
		}
		if (attached) {
			/* An error is a reset (detach, if detachable); POLLHUP or EOF the host's close. */
			if (p[0].revents & POLLERR) {
				conn_lost(0);
				continue;
			}
			if (p[0].revents & POLLHUP || (p[0].revents & POLLRDHUP && !sread))
				end_session();
		}
		if (p[4].revents) {
			pid_t r = waitpid(x.pid, &x.status, WNOHANG);

			if (r == x.pid || (r < 0 && errno == ECHILD)) {
				x.reaped = 1;
				x.quiet_at = now_ms();
				close(x.pfd);
			}
		}
		/* One output per frame; take turns, so neither starves the other. */
		for (int k = 0; k < 2; k++) {
			int i = (x.next + k) & 1;
			ssize_t n;

			if (!rd[i] || x.olen || !(p[1 + i].revents & (POLLIN | POLLHUP | POLLERR)))
				continue;
			n = read(x.ofd[i], x.out + HDR, OUT_MAX);
			if (n > 0) {
				if (x.detachable)
					ring_put(x.out + HDR, n);
				if (x.reaped)
					x.drained += n;
				x.next = i ^ 1;
				queue(i ? T_STDERR : T_DATA, x.out + HDR, n);	/* dropped while detached */
			} else if (n == 0 || (errno != EAGAIN && errno != EINTR)) {
				/* EIO: the pty's slave side is closed; 0: EOF on the pipe */
				x.oend[i] = 1;
				if (!x.pipes)
					x.in_dead = 1;
			}
		}
		if (x.s >= 0 && p[3].revents & (POLLOUT | POLLHUP | POLLERR) && mwrite)
			parse_input();
		if (x.s >= 0 && p[0].revents & POLLOUT)
			flush_out();
		if (x.s >= 0 && p[0].revents & (POLLIN | POLLRDHUP) && sread) {
			ssize_t n = recv(x.s, x.in, sizeof(x.in), 0);

			if (n == 0)
				end_session();	/* EOF: the host hung up */
			if (n < 0 && errno != EAGAIN && errno != EINTR) {
				conn_lost(errno);	/* ENOTCONN: reset */
				continue;
			}
			if (n > 0) {
				x.ilen = n;
				x.ioff = 0;
				parse_input();
			}
		}
		/* Last: an attach replaces the socket whose events were handled above. */
		if (p[5].revents & POLLIN)
			take_attach();
	}
}

static const char *errname(int e)
{
	switch (e) {
	case ECONNREFUSED: return "ECONNREFUSED";
	case ETIMEDOUT: return "ETIMEDOUT";
	case ECONNRESET: return "ECONNRESET";
	case ENETUNREACH: return "ENETUNREACH";
	case EHOSTUNREACH: return "EHOSTUNREACH";
	case EADDRNOTAVAIL: return "EADDRNOTAVAIL";
	case EAFNOSUPPORT: return "EAFNOSUPPORT";
	case EACCES: return "EACCES";
	case EPERM: return "EPERM";
	case EMFILE: return "EMFILE";
	case ENFILE: return "ENFILE";
	case ENOBUFS: return "ENOBUFS";
	case ENOMEM: return "ENOMEM";
	default: return "EOTHER";
	}
}

/* CONNECT: a non-blocking TCP socket connected to 127.0.0.1:port, or ERROR. */
static int tcp_connect(int s, unsigned int port)
{
	struct sockaddr_in a = {
		.sin_family = AF_INET, .sin_port = htons(port),
		.sin_addr.s_addr = htonl(INADDR_LOOPBACK),
	};
	int64_t end = now_ms() + CONNECT_MS;
	int t, one = 1, e = 0;
	socklen_t elen = sizeof(e);

	t = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
	if (t < 0)
		refuse(s, "%s: socket: %s", errname(errno), strerror(errno));
	setsockopt(t, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
	if (connect(t, (struct sockaddr *)&a, sizeof(a))) {
		if (errno != EINPROGRESS && errno != EINTR) {
			e = errno;
		} else {
			for (;;) {
				struct pollfd pf = { .fd = t, .events = POLLOUT };
				int64_t left = end - now_ms();
				int r;

				if (left <= 0) {
					e = ETIMEDOUT;
					break;
				}
				r = poll(&pf, 1, left);
				if (r < 0 && errno != EINTR) {
					e = errno;
					break;
				}
				if (r > 0) {
					if (getsockopt(t, SOL_SOCKET, SO_ERROR, &e, &elen))
						e = errno;
					break;
				}
			}
		}
	}
	if (e)
		refuse(s, "%s: connect to 127.0.0.1:%u: %s", errname(e), port, strerror(e));
	return t;
}

/* One direction of the relay: bytes read from one socket, not yet written to the other. */
struct pipe_dir {
	int from, to;
	int eof;			/* `from` reached EOF */
	int shut;			/* and `to` was shut down for writing after the last byte */
	size_t len, off;
	unsigned char buf[RELAY_BUF];
};

static struct pipe_dir dirs[2];

/*
 * CONNECT after OPENED: splice the vsock socket and the TCP socket, both
 * non-blocking, until both directions have ended (EOF read and passed on
 * as shutdown(SHUT_WR) once the bytes before it are written). An error or
 * a reset on either side ends both.
 */
static void __attribute__((noreturn)) relay(int s, int t)
{
	int hup[2] = { 0, 0 };

	dirs[0].from = dirs[1].to = s;
	dirs[0].to = dirs[1].from = t;
	for (;;) {
		struct pollfd p[2] = { { .fd = s }, { .fd = t } };
		int probe, r;

		for (int i = 0; i < 2; i++) {
			struct pipe_dir *d = &dirs[i];

			if (d->eof && !d->len && !d->shut) {
				shutdown(d->to, SHUT_WR);	/* ENOTCONN: gone already, as good */
				d->shut = 1;
			}
		}
		if (dirs[0].shut && dirs[1].shut)
			break;
		/*
		 * Each socket is polled while it is not finished (EOF read
		 * from it and shut down for writing), with no events when
		 * nothing is asked of it, so that POLLERR (a TCP reset) is
		 * seen. POLLHUP only says both directions are shut, with data
		 * possibly still to read: once seen, a socket with nothing
		 * asked is left out, or poll() would spin.
		 */
		for (int i = 0; i < 2; i++) {
			struct pipe_dir *in = &dirs[i], *out = &dirs[i ^ 1];

			if (in->eof && out->shut) {
				p[i].fd = -1;
				continue;
			}
			if (!in->eof && !in->len)
				p[i].events |= POLLIN;
			if (out->len)
				p[i].events |= POLLOUT;
			if (!p[i].events && hup[i])
				p[i].fd = -1;
		}
		/*
		 * A vsock socket shows no event when the host closes both
		 * ways or resets after it shut down its sending side (no
		 * POLLHUP while ours is open): while nothing else is asked of
		 * it, probe every PROBE_MS with an empty send, which fails
		 * with EPIPE once the host no longer reads.
		 */
		probe = p[0].fd >= 0 && !p[0].events && !dirs[1].shut;
		r = poll(p, 2, probe ? PROBE_MS : -1);
		if (r < 0) {
			if (errno == EINTR)
				continue;
			break;
		}
		if (!r) {
			if (send(s, "", 0, MSG_NOSIGNAL) < 0 && errno != EAGAIN && errno != EINTR)
				break;
			continue;
		}
		if ((p[0].revents | p[1].revents) & POLLERR)
			break;
		for (int i = 0; i < 2; i++)
			if (p[i].revents & POLLHUP)
				hup[i] = 1;
		/* dirs[i] reads p[i] and writes p[i ^ 1]. */
		for (int i = 0; i < 2; i++) {
			struct pipe_dir *d = &dirs[i];
			ssize_t n;

			if (d->len && p[i ^ 1].revents & (POLLOUT | POLLHUP)) {
				n = send(d->to, d->buf + d->off, d->len - d->off, MSG_NOSIGNAL);
				if (n < 0 && errno != EAGAIN && errno != EINTR)
					goto out;	/* EPIPE, ECONNRESET: that side no longer reads */
				if (n > 0) {
					d->off += n;
					if (d->off == d->len)
						d->len = d->off = 0;
				}
			}
			if (!d->eof && !d->len && p[i].revents & (POLLIN | POLLHUP)) {
				n = recv(d->from, d->buf, sizeof(d->buf), 0);
				if (n > 0)
					d->len = n;
				else if (n == 0)
					d->eof = 1;
				else if (errno != EAGAIN && errno != EINTR)
					goto out;
			}
		}
	}
out:
	close(t);
	close(s);
	_exit(0);
}

/* The abstract unix socket address of session `id` (see the top). */
static socklen_t session_addr(struct sockaddr_un *a, const char *id)
{
	int n;

	memset(a, 0, sizeof(*a));
	a->sun_family = AF_UNIX;
	n = snprintf(a->sun_path + 1, sizeof(a->sun_path) - 1, "kwtty/%s", id);
	return offsetof(struct sockaddr_un, sun_path) + 1 + n;
}

/* DETACH: the session's unix socket for ATTACH, or -1 (EADDRINUSE: the id is taken). */
static int session_listen(const char *id)
{
	struct sockaddr_un a;
	socklen_t len = session_addr(&a, id);
	int l = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0), e;

	if (l < 0)
		return -1;
	if (bind(l, (struct sockaddr *)&a, len) || listen(l, 4)) {
		e = errno;
		close(l);
		errno = e;
		return -1;
	}
	return l;
}

/*
 * ATTACH: hand the connection to the session's process with the window
 * size and REPLAY (see the top), which answers on it from then on; or
 * refuse with ENOENT.
 */
static void __attribute__((noreturn)) attach_client(int s, const struct open_req *o)
{
	unsigned char msg[9], ack = 0;
	union {
		struct cmsghdr h;
		char buf[CMSG_SPACE(sizeof(int))];
	} cm;
	struct iovec iov = { .iov_base = msg, .iov_len = sizeof(msg) };
	struct msghdr mh = {
		.msg_iov = &iov, .msg_iovlen = 1,
		.msg_control = cm.buf, .msg_controllen = sizeof(cm.buf),
	};
	struct sockaddr_un a;
	socklen_t len = session_addr(&a, o->id);
	struct cmsghdr *ch;
	int u;

	put16(msg, o->ws.ws_row);
	put16(msg + 2, o->ws.ws_col);
	put16(msg + 4, o->ws.ws_xpixel);
	put16(msg + 6, o->ws.ws_ypixel);
	msg[8] = !!o->replay;
	memset(&cm, 0, sizeof(cm));
	ch = CMSG_FIRSTHDR(&mh);
	ch->cmsg_level = SOL_SOCKET;
	ch->cmsg_type = SCM_RIGHTS;
	ch->cmsg_len = CMSG_LEN(sizeof(int));
	memcpy(CMSG_DATA(ch), &s, sizeof(int));
	u = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
	if (u < 0)
		refuse(s, "socket: %s", strerror(errno));
	if (connect(u, (struct sockaddr *)&a, len) || sendmsg(u, &mh, MSG_NOSIGNAL) < 0)
		refuse(s, "ENOENT: no detachable session %s", o->id);
	if (poll_in(u, HANDOVER_MS) && recv(u, &ack, 1, 0) == 1 && ack == 1)
		_exit(0);	/* the session has the connection now */
	refuse(s, "ENOENT: session %s has ended", o->id);
}

static void __attribute__((noreturn)) session(int s)
{
	const char *base, *file;
	unsigned char h[HDR], *p, opened[14];
	struct open_req o = { 0 };
	struct account a;
	char **env, *argv[2], **args = argv;
	const char *bad;
	int ep[2], e, n, nenv = 0;
	int64_t end = now_ms() + OPEN_MS;
	unsigned int pts = 0;
	ssize_t r;

	signal(SIGCHLD, SIG_DFL);	/* the server's SA_NOCLDWAIT */
	fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK);
	if (recv_all(s, h, HDR, end)) {
		if (errno == ETIMEDOUT)
			refuse(s, "no OPEN within %d s", OPEN_MS / 1000);
		_exit(0);
	}
	if (h[0] != T_OPEN)
		refuse(s, "expected OPEN, got frame type %u", h[0]);
	n = get16(h + 2);
	p = malloc(n + 1);
	if (!p)
		refuse(s, "out of memory");
	if (recv_all(s, p, n, end)) {
		if (errno == ETIMEDOUT)
			refuse(s, "no OPEN within %d s", OPEN_MS / 1000);
		_exit(0);
	}
	bad = parse_open(p, n, &o);
	if (bad)
		refuse(s, "%s", bad);
	if (o.attach)
		attach_client(s, &o);
	if (o.connect) {
		int t = tcp_connect(s, o.port);

		put16(opened, KWTTY_VERSION);
		put32(opened + 2, FEATURES);
		put32(opened + 6, 0);
		put32(opened + 10, NO_PTS);
		h[0] = T_OPENED;
		h[1] = 0;
		put16(h + 2, sizeof(opened));
		if (send_all(s, h, HDR, now_ms() + 2000) || send_all(s, opened, sizeof(opened), now_ms() + 2000))
			_exit(0);
		relay(s, t);
	}

	if (o.detach && o.pipes)
		refuse(s, "DETACH needs a pty (not PIPES)");
	if (find_account(o.user, &a))
		refuse(s, "no user %s", o.user);
	env = calloc(6 + o.nenv + 1, sizeof(*env));
	base = strrchr(a.shell, '/');
	if (!env || asprintf(&argv[0], "-%s", base ? base + 1 : a.shell) < 0)
		refuse(s, "out of memory");
	argv[1] = NULL;
	{
		char *d[5], *term;

		/* PATH: a login shell's (/etc/profile, then kw-path.sh), so that
		 * programs started directly find the host's commands in
		 * /run/kw/bin (kwcmd), /usr/local/bin, ~/.local/bin and the shims
		 * in /usr/lib/kw/bin. */
		if (account_env(&a, d) || asprintf(&term, "TERM=%s", o.term) < 0)
			refuse(s, "out of memory");
		for (int i = 0; i < 5; i++)
			env_set(env, &nenv, d[i]);
		/* Programs on pipes get TERM only when the host gives it. */
		if (!o.pipes || o.has_term)
			env_set(env, &nenv, term);
	}
	for (int i = 0; i < o.nenv; i++)
		env_set(env, &nenv, o.env[i]);
	file = a.shell;
	if (o.nargv) {
		file = o.argv[0];
		args = o.argv;
	}
	/* The session's own directory, which the program inherits (chosen
	 * as root: a directory the account may not search is still its cwd). */
	if (o.cwd ? chdir(o.cwd) : chdir(a.home) && chdir("/"))
		refuse(s, "chdir %s: %s", o.cwd ? o.cwd : a.home, strerror(errno));

	x.s = x.lfd = -1;
	term_init(&x.gone);
	term_init(&x.now);
	if (o.detach) {
		/* Before the program starts: a taken id refuses the session. */
		x.lfd = session_listen(o.id);
		if (x.lfd < 0 && errno == EADDRINUSE)
			refuse(s, "EEXIST: a session %s exists", o.id);
		if (x.lfd < 0)
			refuse(s, "session socket: %s", strerror(errno));
		x.detachable = 1;
		x.detach_ms = o.detach_ms ? o.detach_ms : DETACH_MS;
		strcpy(x.id, o.id);
	}
	if (pipe2(ep, O_CLOEXEC))
		refuse(s, "pipe: %s", strerror(errno));
	if (o.pipes) {
		/* fds 0-2 are taken (main), so none of these lands there. */
		int pin[2], pout[2], perr[2];

		if (pipe2(pin, O_CLOEXEC) || pipe2(pout, O_CLOEXEC) || pipe2(perr, O_CLOEXEC))
			refuse(s, "pipe: %s", strerror(errno));
		x.pid = fork();
		if (x.pid < 0)
			refuse(s, "fork: %s", strerror(errno));
		if (!x.pid) {
			/* Its own session, so that a hangup reaches its children. */
			setsid();
			if (dup2(pin[0], 0) < 0 || dup2(pout[1], 1) < 0 || dup2(perr[1], 2) < 0)
				_exit(127);
			shell_child(ep[1], &a, file, args, env);
		}
		close(pin[0]);
		close(pout[1]);
		close(perr[1]);
		x.m = -1;
		x.ifd = pin[1];
		x.ofd[0] = pout[0];
		x.ofd[1] = perr[0];
		x.pipes = 1;
		pts = NO_PTS;
	} else {
		x.pid = forkpty(&x.m, NULL, NULL, &o.ws);
		if (x.pid < 0)
			refuse(s, "forkpty: %s", strerror(errno));
		if (!x.pid)
			shell_child(ep[1], &a, file, args, env);
		x.ifd = x.ofd[0] = x.m;
		x.ofd[1] = -1;
	}
	close(ep[1]);
	do
		r = read(ep[0], &e, sizeof(e));
	while (r < 0 && errno == EINTR);
	close(ep[0]);
	if (r == sizeof(e)) {
		waitpid(x.pid, NULL, 0);
		if (e < 0)
			refuse(s, "cannot become %s: %s", a.name, strerror(-e));
		refuse(s, "exec %s: %s", file, strerror(e));
	}
	x.s = s;
	x.pfd = syscall(SYS_pidfd_open, x.pid, 0);
	if (x.pfd < 0) {
		e = errno;
		kill(x.pid, SIGKILL);
		waitpid(x.pid, NULL, 0);
		refuse(s, "pidfd_open: %s", strerror(e));
	}
	if (x.m >= 0)
		ioctl(x.m, TIOCGPTN, &pts);
	x.pts = pts;
	/* On a pty these are all the master. */
	fcntl(x.ifd, F_SETFL, fcntl(x.ifd, F_GETFL) | O_NONBLOCK);
	for (int i = 0; i < 2; i++)
		if (x.ofd[i] >= 0)
			fcntl(x.ofd[i], F_SETFL, fcntl(x.ofd[i], F_GETFL) | O_NONBLOCK);
	put16(opened, KWTTY_VERSION);
	put32(opened + 2, FEATURES);
	put32(opened + 6, x.pid);
	put32(opened + 10, pts);
	queue(T_OPENED, opened, sizeof(opened));
	session_loop();
}

static int usage(void)
{
	fprintf(stderr, "usage: kwbox tty serve [PORT] | kwbox tty login\n");
	return 2;
}

/*
 * kwtty login: on the console (fds 0-2, the controlling terminal), the
 * login shell of kw.user=NAME (kernel command line), else of the default
 * user. An unknown kw.user is reported and the default user taken. The
 * environment is the account's (HOME, USER, LOGNAME, SHELL, PATH) and
 * TERM, as login(1) leaves it; the shell starts in the home. On failure it
 * waits a second before exiting, so init does not respawn it in a loop.
 */
static int login(void)
{
	char cmdline[4096], *spec = "", *t, *d[5], *env[7], *argv[2];
	const char *base, *term = getenv("TERM");
	struct account a;
	ssize_t n = -1;
	int fd, e, ne = 0;

	fd = open("/proc/cmdline", O_RDONLY | O_CLOEXEC);
	if (fd >= 0) {
		n = read(fd, cmdline, sizeof(cmdline) - 1);
		close(fd);
	}
	cmdline[n > 0 ? n : 0] = 0;
	for (t = strtok(cmdline, " \n"); t; t = strtok(NULL, " \n"))
		if (!strncmp(t, "kw.user=", 8))
			spec = t + 8;
	if (find_account(spec, &a)) {
		fprintf(stderr, "kwtty login: no user %s (kw.user), so the default user\n", spec);
		if (find_account("", &a))
			goto fail;
	}
	e = become(&a);
	if (e) {
		fprintf(stderr, "kwtty login: cannot become %s: %s\n", a.name, strerror(-e));
		goto fail;
	}
	if (account_env(&a, d))
		goto fail;
	for (int i = 0; i < 5; i++)
		env[ne++] = d[i];
	if (term && *term && asprintf(&env[ne], "TERM=%s", term) >= 0)
		ne++;
	env[ne] = NULL;
	if (chdir(a.home) && chdir("/"))
		goto fail;
	base = strrchr(a.shell, '/');
	if (asprintf(&argv[0], "-%s", base ? base + 1 : a.shell) < 0)
		goto fail;
	argv[1] = NULL;
	environ = env;
	default_signals();
	execv(a.shell, argv);
	fprintf(stderr, "kwtty login: exec %s: %s\n", a.shell, strerror(errno));
fail:
	sleep(1);
	return 1;
}

int main(int argc, char **argv)
{
	struct sockaddr_vm a = {
		.svm_family = AF_VSOCK, .svm_cid = VMADDR_CID_ANY, .svm_port = KWTTY_PORT,
	};
	struct sigaction sa = { .sa_handler = SIG_IGN, .sa_flags = SA_NOCLDWAIT };
	unsigned int cid = VMADDR_CID_ANY;
	int fd, l;

	if (argc == 2 && !strcmp(argv[1], "login"))
		return login();
	if (argc < 2 || argc > 3 || strcmp(argv[1], "serve"))
		return usage();
	if (argc == 3) {
		char *e;
		unsigned long port = strtoul(argv[2], &e, 0);

		if (!*argv[2] || *e || port >= VMADDR_PORT_ANY)
			return usage();
		a.svm_port = port;
	}
	/* Keep 0-2 taken, so that no socket or pty lands there. */
	do
		fd = open("/dev/null", O_RDWR);
	while (fd >= 0 && fd < 3);
	if (fd >= 0)
		close(fd);

	/*
	 * socket(AF_VSOCK) works without a transport; the local CID tells
	 * whether there is one (VMADDR_CID_ANY: none). Without one there is
	 * nothing to serve, and exiting would make init respawn us forever.
	 */
	fd = open("/dev/vsock", O_RDONLY | O_CLOEXEC);
	if (fd >= 0) {
		if (ioctl(fd, IOCTL_VM_SOCKETS_GET_LOCAL_CID, &cid))
			cid = VMADDR_CID_ANY;
		close(fd);
	}
	if (cid == VMADDR_CID_ANY)
		idle();

	sigaction(SIGCHLD, &sa, NULL);	/* sessions reap themselves */
	signal(SIGPIPE, SIG_IGN);
	l = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (l < 0 || bind(l, (struct sockaddr *)&a, sizeof(a)) || listen(l, 32)) {
		fprintf(stderr, "kwtty: vsock port %u: %s\n", a.svm_port, strerror(errno));
		idle();
	}
	for (;;) {
		struct sockaddr_vm peer = { 0 };
		socklen_t plen = sizeof(peer);
		int c = accept4(l, (struct sockaddr *)&peer, &plen, SOCK_CLOEXEC);

		if (c < 0) {
			if (errno != EINTR && errno != ECONNABORTED)
				usleep(100000);	/* EMFILE, ENOMEM: do not spin */
			continue;
		}
		/* Only the host: a session may be root's, without authentication. */
		if (peer.svm_cid != VMADDR_CID_HOST) {
			close(c);
			continue;
		}
		if (!fork()) {
			close(l);
			session(c);
		}
		close(c);
	}
}
