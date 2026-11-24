/*
 * Trace streams: machine-readable debug output that can be switched on and off at run time over the
 * USB shell (`sm trace <name> <level>`), for tools/smtool to record and tune against.
 *
 * A stream is declared once with SM_TRACE_DEFINE and written with SM_TRACE. Level 0 is off; what 1, 2
 * and 3 add is up to the stream (say so in its help text). Each line is one JSON object:
 *
 *   {"k":"tr","s":"<stream>","t":<local time us>, <fields>}
 *
 * Streams cost one load and compare when off. When on, they go through the log buffer, so a stream
 * printing faster than USB drains it will lose lines (counted by the log system as dropped).
 *
 * Human logging uses Zephyr's own run-time filters: `log enable dbg sm_audio`, `log status`.
 */
#ifndef SONICMESH_TRACE_H
#define SONICMESH_TRACE_H

#include <stdint.h>
#include <zephyr/sys/iterable_sections.h>
#include <zephyr/sys/printk.h>

struct sm_trace {
	const char *name;
	const char *help;
	uint8_t *level;
};

#define SM_TRACE_DEFINE(_name, _help)                                                              \
	uint8_t _name##_sm_trace_level;                                                            \
	const STRUCT_SECTION_ITERABLE(sm_trace, _name##_sm_trace) = {                              \
		.name = #_name,                                                                    \
		.help = _help,                                                                     \
		.level = &_name##_sm_trace_level,                                                  \
	}

#define SM_TRACE_DECLARE(_name) extern uint8_t _name##_sm_trace_level

/* True when stream _name is at _lvl or above. Use it to skip work that only feeds a trace. */
#define SM_TRACE_ON(_name, _lvl) (_name##_sm_trace_level >= (_lvl))

/*
 * Prints one trace line at level _lvl for an event at local time _t_us. _fmt is the JSON fields
 * after "t", starting with a comma, e.g. SM_TRACE(comb, 1, t, ",\"f0\":%.1f", (double)f0).
 */
#define SM_TRACE(_name, _lvl, _t_us, _fmt, ...)                                                    \
	do {                                                                                       \
		if (SM_TRACE_ON(_name, _lvl)) {                                                    \
			printk("{\"k\":\"tr\",\"s\":\"" #_name "\",\"t\":%lld" _fmt "}\n",         \
			       (long long)(_t_us), ##__VA_ARGS__);                                 \
		}                                                                                  \
	} while (0)

const struct sm_trace *sm_trace_find(const char *name);

#endif
