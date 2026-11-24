// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk: the stream to the host (vsock, tcp or unix; KWVK_LINK), its
// framing, reply demultiplexing by "r", and the small JSON helpers.
// Any waiting thread may become the reader; others sleep on a condvar.
#include "kwvk.h"

#include <arpa/inet.h>
#include <errno.h>
#include <math.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <time.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef AF_VSOCK
#define AF_VSOCK 40
#endif
struct kw_sockaddr_vm {
	unsigned short svm_family, svm_reserved1;
	unsigned int svm_port, svm_cid;
	unsigned char svm_zero[4];
};

void kw_log(const char *fmt, ...)
{
	static int on = -1;
	if (on < 0)
		on = getenv("KWVK_DEBUG") != NULL;
	if (!on)
		return;
	va_list ap;
	va_start(ap, fmt);
	fprintf(stderr, "kwvk: ");
	vfprintf(stderr, fmt, ap);
	fprintf(stderr, "\n");
	va_end(ap);
}

/* Errors and warnings an app or its user must see: always on stderr, each
 * distinct line once per process (no per-frame repeats), the first 256. */
void kw_err(const char *fmt, ...)
{
	static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
	static uint32_t seen[256];
	static int nseen;
	char line[1024];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(line, sizeof line, fmt, ap);
	va_end(ap);
	uint32_t h = 2166136261u; /* FNV-1a of the text */
	for (const char *p = line; *p; p++)
		h = (h ^ (uint8_t)*p) * 16777619u;
	pthread_mutex_lock(&mu);
	int dup = 0;
	for (int i = 0; i < nseen && !dup; i++)
		dup = seen[i] == h;
	int over = !dup && nseen == 256;
	if (!dup && !over)
		seen[nseen++] = h;
	else if (over && nseen++ == 256)
		fprintf(stderr, "kwvk: further errors are not shown\n");
	if (!dup && !over)
		fprintf(stderr, "kwvk: %s\n", line);
	pthread_mutex_unlock(&mu);
}

/* ---- jb ---- */

static void jb_grow(struct jb *b, size_t add)
{
	if (b->n + add + 1 <= b->cap)
		return;
	size_t c = b->cap ? b->cap * 2 : 256;
	while (c < b->n + add + 1)
		c *= 2;
	b->p = realloc(b->p, c);
	if (!b->p)
		abort();
	b->cap = c;
}

void jb_put(struct jb *b, const void *s, size_t n)
{
	jb_grow(b, n);
	memcpy(b->p + b->n, s, n);
	b->n += n;
	b->p[b->n] = 0;
}

void jb_printf(struct jb *b, const char *fmt, ...)
{
	va_list ap;
	char tmp[256];
	va_start(ap, fmt);
	int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
	va_end(ap);
	if (n < (int)sizeof tmp) {
		jb_put(b, tmp, n);
		return;
	}
	jb_grow(b, n);
	va_start(ap, fmt);
	vsnprintf(b->p + b->n, n + 1, fmt, ap);
	va_end(ap);
	b->n += n;
}

void jb_u64(struct jb *b, uint64_t v)
{
	char tmp[20];
	int n = 0;
	do
		tmp[sizeof tmp - ++n] = (char)('0' + v % 10);
	while ((v /= 10));
	jb_put(b, tmp + sizeof tmp - n, n);
}

void jb_i64(struct jb *b, int64_t v)
{
	if (v < 0) {
		JS(b, "-");
		jb_u64(b, (uint64_t)0 - (uint64_t)v);
	} else
		jb_u64(b, (uint64_t)v);
}

/* [n bytes as decimal numbers], e.g. push constants (no printf per byte) */
void jb_bytes(struct jb *b, const uint8_t *p, size_t n)
{
	jb_grow(b, n * 4 + 2);
	char *o = b->p + b->n;
	*o++ = '[';
	for (size_t i = 0; i < n; i++) {
		unsigned v = p[i];
		if (i)
			*o++ = ',';
		if (v >= 100) {
			*o++ = (char)('0' + v / 100);
			*o++ = (char)('0' + v / 10 % 10);
		} else if (v >= 10)
			*o++ = (char)('0' + v / 10);
		*o++ = (char)('0' + v % 10);
	}
	*o++ = ']';
	b->n = (size_t)(o - b->p);
	b->p[b->n] = 0;
}

void jb_float(struct jb *b, double f)
{
	char tmp[64];
	if (!isfinite(f))
		f = isnan(f) ? 0 : (f > 0 ? 3.4e38 : -3.4e38);
	int n = snprintf(tmp, sizeof tmp, "%.9g", f);
	for (int i = 0; i < n; i++)
		if (tmp[i] == ',')
			tmp[i] = '.'; /* the app may have set a locale */
	jb_put(b, tmp, n);
}

void jb_str(struct jb *b, const char *s)
{
	jb_put(b, "\"", 1);
	for (; s && *s; s++) {
		unsigned char c = *s;
		if (c == '"' || c == '\\')
			jb_printf(b, "\\%c", c);
		else if (c < 0x20)
			jb_printf(b, "\\u%04x", c);
		else
			jb_put(b, s, 1);
	}
	jb_put(b, "\"", 1);
}

void jb_free(struct jb *b)
{
	free(b->p);
	b->p = NULL;
	b->n = b->cap = 0;
}

void jb_reset(struct jb *b)
{
	b->n = 0;
	if (b->p)
		b->p[0] = 0;
}

/* ---- JSON reading ---- */

static const char *js_ws(const char *p)
{
	while (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t')
		p++;
	return p;
}

const char *js_skip(const char *p)
{
	p = js_ws(p);
	if (*p == '"') {
		p++;
		while (*p && *p != '"') {
			if (*p == '\\' && p[1])
				p++;
			p++;
		}
		return *p ? p + 1 : p;
	}
	if (*p == '{' || *p == '[') {
		int d = 0;
		do {
			if (*p == '"') {
				p = js_skip(p);
				continue;
			}
			if (*p == '{' || *p == '[')
				d++;
			else if (*p == '}' || *p == ']')
				d--;
			p++;
		} while (d > 0 && *p);
		return p;
	}
	while (*p && *p != ',' && *p != '}' && *p != ']' && *p != ' ')
		p++;
	return p;
}

/* p: at '{' or at the position returned last time. NULL at the end. */
const char *js_member(const char *p, const char **k, size_t *kl, const char **v)
{
	p = js_ws(p);
	if (*p == '{' || *p == ',')
		p = js_ws(p + 1);
	if (*p != '"')
		return NULL;
	*k = p + 1;
	const char *e = js_skip(p);
	*kl = (size_t)(e - p) - 2;
	p = js_ws(e);
	if (*p != ':')
		return NULL;
	*v = js_ws(p + 1);
	return js_skip(*v);
}

const char *js_get(const char *obj, const char *key)
{
	const char *k, *v, *p = obj;
	size_t kl, n = strlen(key);
	if (!p)
		return NULL;
	while ((p = js_member(p, &k, &kl, &v)))
		if (kl == n && !memcmp(k, key, n))
			return v;
	return NULL;
}

double js_num(const char *v, double dflt)
{
	if (!v || *v == '"' || *v == '{' || *v == '[' || *v == 'n')
		return dflt;
	if (*v == 't')
		return 1;
	if (*v == 'f')
		return 0;
	return strtod(v, NULL);
}

void js_strcpy(const char *v, char *out, size_t cap)
{
	size_t n = 0;
	if (cap)
		out[0] = 0;
	if (!v || *v != '"' || !cap)
		return;
	for (v++; *v && *v != '"' && n + 1 < cap; v++) {
		if (*v == '\\' && v[1])
			v++;
		out[n++] = *v;
	}
	out[n] = 0;
}

/* ---- link ---- */

static int link_connect(void)
{
	const char *spec = getenv("KWVK_LINK");
	if (!spec || !*spec)
		spec = "vsock:2:1018";
	int fd = -1;
	if (!strncmp(spec, "vsock:", 6)) {
		struct kw_sockaddr_vm a = {0};
		a.svm_family = AF_VSOCK;
		a.svm_cid = strtoul(spec + 6, NULL, 10);
		const char *c = strchr(spec + 6, ':');
		a.svm_port = c ? strtoul(c + 1, NULL, 10) : 1018;
		fd = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);
		if (fd >= 0 && connect(fd, (struct sockaddr *)&a, sizeof a) < 0) {
			close(fd);
			fd = -1;
		}
	} else if (!strncmp(spec, "tcp:", 4)) {
		char host[256];
		snprintf(host, sizeof host, "%s", spec + 4);
		char *c = strrchr(host, ':');
		if (!c)
			return -1;
		*c = 0;
		struct addrinfo hints = {0}, *res = NULL;
		hints.ai_socktype = SOCK_STREAM;
		if (getaddrinfo(host, c + 1, &hints, &res) || !res)
			return -1;
		fd = socket(res->ai_family, SOCK_STREAM | SOCK_CLOEXEC, 0);
		if (fd >= 0 && connect(fd, res->ai_addr, res->ai_addrlen) < 0) {
			close(fd);
			fd = -1;
		}
		freeaddrinfo(res);
		if (fd >= 0) {
			int one = 1;
			setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
		}
	} else if (!strncmp(spec, "unix:", 5)) {
		struct sockaddr_un a = {0};
		a.sun_family = AF_UNIX;
		snprintf(a.sun_path, sizeof a.sun_path, "%s", spec + 5);
		fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
		if (fd >= 0 && connect(fd, (struct sockaddr *)&a, sizeof a) < 0) {
			close(fd);
			fd = -1;
		}
	}
	if (fd < 0)
		kw_log("cannot connect to %s: %s", spec, strerror(errno));
	return fd;
}

struct kw_link *link_open(void)
{
	int fd = link_connect();
	if (fd < 0)
		return NULL;
	struct kw_link *l = calloc(1, sizeof *l);
	l->fd = fd;
	l->next_r = 1;
	l->next_id = 1;
	pthread_mutex_init(&l->send_mu, NULL);
	pthread_mutex_init(&l->mu, NULL);
	pthread_cond_init(&l->cv, NULL);
	return l;
}

void link_close(struct kw_link *l)
{
	if (!l)
		return;
	close(l->fd);
	while (l->done) {
		struct kw_reply *n = l->done->next;
		reply_free(l->done);
		l->done = n;
	}
	free(l);
}

uint32_t link_id(struct kw_link *l)
{
	return __atomic_fetch_add(&l->next_id, 1, __ATOMIC_RELAXED);
}

static int write_all(int fd, struct iovec *iov, int n)
{
	while (n > 0) {
		struct msghdr mh = {.msg_iov = iov, .msg_iovlen = n};
		ssize_t w = sendmsg(fd, &mh, MSG_NOSIGNAL); /* no SIGPIPE when the host closed */
		if (w < 0) {
			if (errno == EINTR)
				continue;
			return -1;
		}
		while (n > 0 && (size_t)w >= iov->iov_len) {
			w -= iov->iov_len;
			iov++;
			n--;
		}
		if (n > 0) {
			iov->iov_base = (char *)iov->iov_base + w;
			iov->iov_len -= w;
		}
	}
	return 0;
}

uint32_t link_send(struct kw_link *l, struct jb *b, const void *bin, size_t binlen, int want_reply)
{
	uint32_t r = 0;
	pthread_mutex_lock(&l->send_mu);
	if (want_reply) {
		r = l->next_r++;
		/* replace the closing brace with ,"r":N} */
		while (b->n && b->p[b->n - 1] != '}')
			b->n--;
		if (b->n)
			b->n--;
		jb_printf(b, ",\"r\":%u}", r);
	}
	static FILE *trace;
	static int trace_init;
	if (!trace_init) { /* debugging: KWVK_TRACE=FILE logs every message's JSON */
		const char *t = getenv("KWVK_TRACE");
		trace = t && *t ? fopen(t, "w") : NULL;
		trace_init = 1;
	}
	if (trace) {
		fwrite(b->p, 1, b->n, trace);
		fputc('\n', trace);
		fflush(trace);
	}
	uint32_t jl = (uint32_t)b->n, pad = (4 - (jl & 3)) & 3;
	uint32_t hdr[2] = {jl + pad + (uint32_t)binlen, jl};
	static const char zeros[4];
	struct iovec iov[4] = {
		{hdr, 8}, {b->p, jl}, {(void *)zeros, pad}, {(void *)bin, binlen}};
	if (!l->dead && write_all(l->fd, iov, binlen ? 4 : 3) < 0) {
		kw_log("send failed: %s", strerror(errno));
		l->dead = 1;
	}
	pthread_mutex_unlock(&l->send_mu);
	return r;
}

static int read_all(int fd, void *p, size_t n)
{
	while (n) {
		ssize_t r = read(fd, p, n);
		if (r < 0 && errno == EINTR)
			continue;
		if (r <= 0)
			return -1;
		p = (char *)p + r;
		n -= r;
	}
	return 0;
}

static struct kw_reply *read_frame(struct kw_link *l)
{
	uint32_t hdr[2];
	if (read_all(l->fd, hdr, 8) < 0)
		return NULL;
	uint32_t jl = hdr[1], pad = (4 - (jl & 3)) & 3;
	if (jl + pad > hdr[0])
		return NULL;
	struct kw_reply *rep = calloc(1, sizeof *rep);
	rep->json = malloc(jl + pad + 1);
	if (read_all(l->fd, rep->json, jl + pad) < 0) {
		reply_free(rep);
		return NULL;
	}
	rep->json[jl] = 0;
	rep->binlen = hdr[0] - jl - pad;
	if (rep->binlen) {
		rep->bin = malloc(rep->binlen);
		if (read_all(l->fd, rep->bin, rep->binlen) < 0) {
			reply_free(rep);
			return NULL;
		}
	}
	rep->r = (uint32_t)js_num(js_get(rep->json, "r"), 0);
	const char *e = js_get(rep->json, "err");
	if (e)
		kw_log("host error (r=%u): %.200s", rep->r, e);
	/* the host ends the stream as a lost device and says why first */
	const char *lost = rep->r ? NULL : js_get(rep->json, "lost");
	if (lost) {
		char why[768];
		js_strcpy(lost, why, sizeof why);
		link_lose(l, why);
	}
	return rep;
}

void link_lose(struct kw_link *l, const char *why)
{
	pthread_mutex_lock(&l->mu);
	int first = !l->lost;
	l->lost = 1;
	l->dead = 1;
	pthread_cond_broadcast(&l->cv);
	pthread_mutex_unlock(&l->mu);
	if (first)
		kw_err("device lost: %s", why);
}

int kw_reply_lost(struct kw_link *l, struct kw_reply *rep, const char *what)
{
	if (!rep) {
		link_lose(l, "the host closed the link");
		return 1;
	}
	const char *e = js_get(rep->json, "err");
	if (!e)
		return 0;
	char why[768], msg[900];
	js_strcpy(e, why, sizeof why);
	snprintf(msg, sizeof msg, "%s failed on the host: %s", what, why);
	link_lose(l, msg);
	return 1;
}

void reply_free(struct kw_reply *rep)
{
	if (!rep)
		return;
	free(rep->json);
	free(rep->bin);
	free(rep);
}

static struct kw_reply *take(struct kw_link *l, uint32_t r, int remove)
{
	for (struct kw_reply **pp = &l->done; *pp; pp = &(*pp)->next)
		if ((*pp)->r == r) {
			struct kw_reply *x = *pp;
			if (remove)
				*pp = x->next;
			return x;
		}
	return NULL;
}

/* called with mu held, reading flag set by caller; drops mu around read */
static void read_one(struct kw_link *l)
{
	l->reading = 1;
	pthread_mutex_unlock(&l->mu);
	struct kw_reply *rep = read_frame(l);
	pthread_mutex_lock(&l->mu);
	l->reading = 0;
	if (!rep) {
		if (!l->lost) /* no reason given (a renderer that predates "lost", or a reset stream) */
			kw_err("device lost: the host closed the link");
		l->lost = 1;
		l->dead = 1;
	} else if (rep->r) {
		rep->next = l->done;
		l->done = rep;
	} else {
		reply_free(rep);
	}
	pthread_cond_broadcast(&l->cv);
}

static int64_t now_ns(void)
{
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (int64_t)t.tv_sec * 1000000000 + t.tv_nsec;
}

/* timeout_ns < 0: forever. NULL on timeout (*timed_out set) or a dead link */
struct kw_reply *link_wait_timeout(struct kw_link *l, uint32_t r, int64_t timeout_ns, int *timed_out)
{
	struct kw_reply *rep;
	int64_t end = timeout_ns >= 0 ? now_ns() + timeout_ns : 0;
	if (timed_out)
		*timed_out = 0;
	pthread_mutex_lock(&l->mu);
	while (!(rep = take(l, r, 1))) {
		if (l->dead)
			break;
		int64_t left = timeout_ns >= 0 ? end - now_ns() : -1;
		if (timeout_ns >= 0 && left <= 0) {
			if (timed_out)
				*timed_out = 1;
			break;
		}
		if (!l->reading) {
			if (timeout_ns >= 0) {
				/* wait for data without holding the reader role */
				l->reading = 1;
				pthread_mutex_unlock(&l->mu);
				struct pollfd pfd = {l->fd, POLLIN, 0};
				int ms = (int)((left + 999999) / 1000000);
				int pr = poll(&pfd, 1, ms > 0 ? ms : 1);
				pthread_mutex_lock(&l->mu);
				l->reading = 0;
				if (pr > 0)
					read_one(l);
				else
					pthread_cond_broadcast(&l->cv);
			} else {
				read_one(l);
			}
		} else if (timeout_ns >= 0) {
			struct timespec ts;
			clock_gettime(CLOCK_REALTIME, &ts);
			int64_t t = (int64_t)ts.tv_sec * 1000000000 + ts.tv_nsec + (left < 50000000 ? left : 50000000);
			ts.tv_sec = t / 1000000000;
			ts.tv_nsec = t % 1000000000;
			pthread_cond_timedwait(&l->cv, &l->mu, &ts);
		} else {
			pthread_cond_wait(&l->cv, &l->mu);
		}
	}
	pthread_mutex_unlock(&l->mu);
	return rep;
}

struct kw_reply *link_wait(struct kw_link *l, uint32_t r)
{
	return link_wait_timeout(l, r, -1, NULL);
}

int link_poll(struct kw_link *l, uint32_t r)
{
	int got;
	pthread_mutex_lock(&l->mu);
	for (;;) {
		got = take(l, r, 0) != NULL;
		if (got || l->dead || l->reading)
			break;
		struct pollfd pfd = {l->fd, POLLIN, 0};
		if (poll(&pfd, 1, 0) <= 0)
			break;
		read_one(l);
	}
	pthread_mutex_unlock(&l->mu);
	return got || l->dead;
}

struct kw_reply *link_call(struct kw_link *l, struct jb *b, const void *bin, size_t binlen)
{
	uint32_t r = link_send(l, b, bin, binlen, 1);
	return link_wait(l, r);
}
