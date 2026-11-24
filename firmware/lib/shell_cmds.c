/*
 * The `sm` shell command: parameters, trace streams and status over USB serial, for people and for
 * tools/smtool. Every command answers with JSON lines and ends with exactly one
 *   {"k":"ok","c":"<command>"}   or   {"k":"err","c":"<command>","e":<errno>,"m":"<message>"}
 * so a tool can send a command and read until that line.
 */
#include <errno.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <zephyr/sys/reboot.h>

#if defined(CONFIG_SOC_FAMILY_NORDIC_NRF)
#include <hal/nrf_power.h>
#endif

#include <sonicmesh/msg.h>
#include <sonicmesh/wire.h>
#include <sonicmesh/param.h>
#include <sonicmesh/trace.h>

#define DFU_MAGIC_UF2_RESET 0x57

#if defined(CONFIG_SM_ROLE_NODE)
#define ROLE "node"
#else
#define ROLE "gateway"
#endif

/* Node status as JSON fields (no braces). Weak: the gateway has none beyond uptime. */
__weak void sm_status_fields(const struct shell *sh)
{
	ARG_UNUSED(sh);
}

static int ok(const struct shell *sh, const char *cmd)
{
	shell_print(sh, "{\"k\":\"ok\",\"c\":\"%s\"}", cmd);
	return 0;
}

static int fail(const struct shell *sh, const char *cmd, int err, const char *msg)
{
	shell_print(sh, "{\"k\":\"err\",\"c\":\"%s\",\"e\":%d,\"m\":\"%s\"}", cmd, err, msg);
	return err;
}

static const char *type_name(uint8_t t)
{
	return t == SM_PARAM_TYPE_int ? "int" : t == SM_PARAM_TYPE_bool ? "bool" : "float";
}

static void print_param(const struct shell *sh, const struct sm_param *p, bool help)
{
	if (help) {
		shell_print(sh,
			    "{\"k\":\"param\",\"n\":\"%s\",\"type\":\"%s\",\"v\":%.7g,\"def\":%.7g,"
			    "\"min\":%.7g,\"max\":%.7g,\"help\":\"%s\"}",
			    p->name, type_name(p->type), (double)sm_param_get(p), (double)p->def,
			    (double)p->min, (double)p->max, p->help);
	} else {
		shell_print(sh, "{\"k\":\"param\",\"n\":\"%s\",\"v\":%.7g}", p->name,
			    (double)sm_param_get(p));
	}
}

extern const char sm_build_time[]; /* generated each build: lib/build_time.cmake */

static int cmd_info(const struct shell *sh, size_t argc, char **argv)
{
	int np = 0, nt = 0;

	STRUCT_SECTION_COUNT(sm_param, &np);
	STRUCT_SECTION_COUNT(sm_trace, &nt);
	shell_print(sh,
		    "{\"k\":\"info\",\"role\":\"" ROLE "\",\"node\":\"%04x\",\"up_ms\":%lld,"
		    "\"built\":\"%s\",\"params\":%d,\"traces\":%d}",
		    sm_node_id(), k_uptime_get(), sm_build_time, np, nt);
	return ok(sh, "info");
}

static int cmd_status(const struct shell *sh, size_t argc, char **argv)
{
	shell_fprintf(sh, SHELL_NORMAL, "{\"k\":\"status\",\"up_ms\":%lld", k_uptime_get());
	sm_status_fields(sh);
	shell_fprintf(sh, SHELL_NORMAL, "}\n");
	return ok(sh, "status");
}

/* Param commands answer -EAGAIN until the saved values are loaded: before that a read gives the
 * default and a save fails, which a tool that connects right after a reset would take as real. */
#define PARAMS_READY(sh, cmd)                                                                      \
	do {                                                                                       \
		if (!sm_params_ready()) {                                                          \
			return fail(sh, cmd, -EAGAIN, "starting, parameters not loaded yet");      \
		}                                                                                  \
	} while (0)

/* sm param list [prefix] */
static int cmd_param_list(const struct shell *sh, size_t argc, char **argv)
{
	const char *prefix = argc > 1 ? argv[1] : "";

	PARAMS_READY(sh, "param list");
	STRUCT_SECTION_FOREACH(sm_param, p) {
		if (strncmp(p->name, prefix, strlen(prefix)) == 0) {
			print_param(sh, p, true);
		}
	}
	return ok(sh, "param list");
}

/* sm param get <name>... */
static int cmd_param_get(const struct shell *sh, size_t argc, char **argv)
{
	PARAMS_READY(sh, "param get");

	for (size_t i = 1; i < argc; i++) {
		const struct sm_param *p = sm_param_find(argv[i]);

		if (!p) {
			return fail(sh, "param get", -ENOENT, argv[i]);
		}
		print_param(sh, p, false);
	}
	return ok(sh, "param get");
}

/* sm param set <name> <value> [<name> <value>...]. Sets none unless every pair is valid. */
static int cmd_param_set(const struct shell *sh, size_t argc, char **argv)
{
	PARAMS_READY(sh, "param set");

	if (argc < 3 || (argc - 1) % 2) {
		return fail(sh, "param set", -EINVAL, "usage: sm param set <name> <value> ...");
	}
	float v[CONFIG_SHELL_ARGC_MAX / 2];

	/* All or nothing: every name and value is checked before any is set. */
	for (size_t i = 1; i < argc; i += 2) {
		const struct sm_param *p = sm_param_find(argv[i]);

		if (!p) {
			return fail(sh, "param set", -ENOENT, argv[i]);
		}
		int err = sm_param_parse(p, argv[i + 1], &v[i / 2]);

		if (err) {
			return fail(sh, "param set", err, err == -ERANGE ? "out of range" : "bad value");
		}
	}
	for (size_t i = 1; i < argc; i += 2) {
		const struct sm_param *p = sm_param_find(argv[i]);

		sm_param_set(p, v[i / 2]);
		print_param(sh, p, false);
	}
	return ok(sh, "param set");
}

static int cmd_param_save(const struct shell *sh, size_t argc, char **argv)
{
	PARAMS_READY(sh, "param save");

	int err = sm_params_save();

	return err ? fail(sh, "param save", err, "flash write failed") : ok(sh, "param save");
}

/* sm param reset [name]: defaults in RAM; `sm param save` makes it stick. */
static int cmd_param_reset(const struct shell *sh, size_t argc, char **argv)
{
	PARAMS_READY(sh, "param reset");

	const struct sm_param *p = NULL;

	if (argc > 1) {
		p = sm_param_find(argv[1]);
		if (!p) {
			return fail(sh, "param reset", -ENOENT, argv[1]);
		}
	}
	sm_params_reset(p);
	return ok(sh, "param reset");
}

const struct sm_trace *sm_trace_find(const char *name)
{
	STRUCT_SECTION_FOREACH(sm_trace, t) {
		if (strcmp(t->name, name) == 0) {
			return t;
		}
	}
	return NULL;
}

/* sm trace                     list streams and levels
 * sm trace off                 all off
 * sm trace <name> <level> ...  set levels */
static int cmd_trace(const struct shell *sh, size_t argc, char **argv)
{
	if (argc == 2 && strcmp(argv[1], "off") == 0) {
		STRUCT_SECTION_FOREACH(sm_trace, t) {
			*t->level = 0;
		}
		return ok(sh, "trace");
	}
	if (argc > 1) {
		if ((argc - 1) % 2) {
			return fail(sh, "trace", -EINVAL, "usage: sm trace <name> <level> ...");
		}
		for (size_t i = 1; i < argc; i += 2) {
			const struct sm_trace *t = sm_trace_find(argv[i]);
			char *end;
			long lvl = strtol(argv[i + 1], &end, 10);

			if (!t) {
				return fail(sh, "trace", -ENOENT, argv[i]);
			}
			if (*end || lvl < 0 || lvl > 3) {
				return fail(sh, "trace", -EINVAL, "level is 0-3");
			}
			*t->level = (uint8_t)lvl;
		}
	}
	STRUCT_SECTION_FOREACH(sm_trace, t) {
		shell_print(sh, "{\"k\":\"trace\",\"n\":\"%s\",\"lvl\":%u,\"help\":\"%s\"}", t->name, *t->level,
			    t->help);
	}
	return ok(sh, "trace");
}

static int hexval(char c)
{
	return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10
		: c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}

/* sm send <type> [hex payload]: queue a raw record, to test the radio path without sound. */
static int cmd_send(const struct shell *sh, size_t argc, char **argv)
{
	uint8_t buf[SM_RECORD_MAX_PAYLOAD];
	size_t n = 0;
	char *end;
	unsigned long type = strtoul(argv[1], &end, 0);

	if (*end || type > 0xFF) {
		return fail(sh, "send", -EINVAL, "type is 0-255");
	}
	if (argc > 2) {
		const char *h = argv[2];
		size_t len = strlen(h);

		if (len % 2 || len / 2 > sizeof(buf)) {
			return fail(sh, "send", -EINVAL, "payload: even number of hex digits, short enough");
		}
		for (; n < len / 2; n++) {
			int hi = hexval(h[2 * n]), lo = hexval(h[2 * n + 1]);

			if (hi < 0 || lo < 0) {
				return fail(sh, "send", -EINVAL, "payload is not hex");
			}
			buf[n] = (uint8_t)(hi << 4 | lo);
		}
	}
	int err = sm_msg_send((uint8_t)type, buf, (uint8_t)n);

	return err ? fail(sh, "send", err, "record pool full") : ok(sh, "send");
}

static int cmd_reboot(const struct shell *sh, size_t argc, char **argv)
{
	ok(sh, "reboot");
	k_msleep(100);
	sys_reboot(SYS_REBOOT_COLD);
	return 0;
}

#if defined(CONFIG_SOC_FAMILY_NORDIC_NRF)
/* Restart into the UF2 bootloader, like the 1200 baud touch. */
static int cmd_bootloader(const struct shell *sh, size_t argc, char **argv)
{
	ok(sh, "bootloader");
	k_msleep(100);
	NRF_POWER->GPREGRET = DFU_MAGIC_UF2_RESET;
	sys_reboot(SYS_REBOOT_WARM);
	return 0;
}
#endif

SHELL_STATIC_SUBCMD_SET_CREATE(sm_param_cmds,
	SHELL_CMD_ARG(list, NULL, "List parameters as JSON: sm param list [prefix]", cmd_param_list, 1, 1),
	SHELL_CMD_ARG(get, NULL, "sm param get <name>...", cmd_param_get, 2, 16),
	SHELL_CMD_ARG(set, NULL, "sm param set <name> <value> [<name> <value>...] (RAM; then save)",
		      cmd_param_set, 3, 30),
	SHELL_CMD(save, NULL, "Save every changed parameter to flash", cmd_param_save),
	SHELL_CMD_ARG(reset, NULL, "Defaults in RAM: sm param reset [name]", cmd_param_reset, 1, 1),
	SHELL_SUBCMD_SET_END);

/* `sm` takes subcommands from any file: SHELL_SUBCMD_ADD((sm), <name>, ...) (lib/capture.c does). */
SHELL_SUBCMD_SET_CREATE(sm_cmds, (sm));
SHELL_SUBCMD_ADD((sm), info, NULL, "Role, node id, build", cmd_info, 0, 0);
SHELL_SUBCMD_ADD((sm), status, NULL, "Status as JSON", cmd_status, 0, 0);
SHELL_SUBCMD_ADD((sm), param, &sm_param_cmds, "Run-time parameters", NULL, 0, 0);
SHELL_SUBCMD_ADD((sm), trace, NULL, "sm trace [off | <name> <level 0-3>...]", cmd_trace, 1, 30);
SHELL_SUBCMD_ADD((sm), send, NULL, "Queue a raw record: sm send <type> [hex]", cmd_send, 2, 1);
SHELL_SUBCMD_ADD((sm), reboot, NULL, "Restart", cmd_reboot, 0, 0);
#if defined(CONFIG_SOC_FAMILY_NORDIC_NRF)
SHELL_SUBCMD_ADD((sm), bootloader, NULL, "Restart into the UF2 bootloader", cmd_bootloader, 0, 0);
#endif

SHELL_CMD_REGISTER(sm, &sm_cmds, "SonicMesh: parameters, traces, status", NULL);
