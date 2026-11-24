/*
 * Run-time parameters. Any module declares a setting with SM_PARAM_DEFINE (or SM_PARAM_FIELD for a
 * struct field); it can then be read and changed over the USB shell (`sm param ...`), saved to flash
 * so it survives power-off and reflashing, and swept by tools/smtool without rebuilding.
 *
 * Names are "<group>.<name>". A parameter whose group is a detector's name (e.g. "gunshot.ratio_db")
 * re-runs that detector's init() in its own thread after a change, so detectors need no change hook:
 * read the values in init().
 *
 * Values are 32-bit (int32_t, float or bool), written whole, so a reader never sees a torn value. A
 * reader that needs several values to agree should copy them in its init(), as detectors do.
 */
#ifndef SONICMESH_PARAM_H
#define SONICMESH_PARAM_H

#include <stdbool.h>
#include <stdint.h>
#include <zephyr/sys/iterable_sections.h>

enum sm_param_type {
	SM_PARAM_TYPE_int,
	SM_PARAM_TYPE_float,
	SM_PARAM_TYPE_bool,
	/* <stdbool.h> makes bool a macro for _Bool, which a macro argument expands to. */
	SM_PARAM_TYPE__Bool = SM_PARAM_TYPE_bool,
};

struct sm_param {
	const char *name;
	const char *help;
	void *value; /* int32_t *, float * or bool *, by type */
	float def, min, max;
	uint8_t type;
	/* Optional, called in the shell's thread after the value changes. */
	void (*changed)(const struct sm_param *p);
};

/*
 * Declares parameter <group>.<name> stored in *_ptr, of type _type (int, float or bool; int means
 * int32_t). The registry writes the default at boot, before saved values are loaded, so the variable
 * needs no initialiser.
 */
#define SM_PARAM_FIELD(_group, _name, _type, _ptr, _def, _min, _max, _changed, _help)             \
	static const STRUCT_SECTION_ITERABLE(sm_param, _CONCAT(_CONCAT(_group, __), _name)) = {    \
		.name = STRINGIFY(_group) "." STRINGIFY(_name),                                   \
		.help = _help,                                                                    \
		.value = (_ptr),                                                                  \
		.def = (float)(_def),                                                             \
		.min = (float)(_min),                                                             \
		.max = (float)(_max),                                                             \
		.type = SM_PARAM_TYPE_##_type,                                                    \
		.changed = (_changed),                                                            \
	}

/* Declares a static variable sm_<group>_<name> together with its parameter. */
#define SM_PARAM_DEFINE(_group, _name, _type, _def, _min, _max, _changed, _help)                  \
	static _CONCAT(SM_PARAM_CTYPE_, _type) _CONCAT(_CONCAT(_CONCAT(sm_, _group), _), _name);   \
	SM_PARAM_FIELD(_group, _name, _type, &_CONCAT(_CONCAT(_CONCAT(sm_, _group), _), _name),    \
		       _def, _min, _max, _changed, _help)

#define SM_PARAM_CTYPE_int int32_t
#define SM_PARAM_CTYPE_float float
#define SM_PARAM_CTYPE_bool bool
#define SM_PARAM_CTYPE__Bool bool

/* Writes defaults, then loads saved values. Call once at boot, before anything reads a parameter. */
int sm_params_init(void);

/* False until sm_params_init has loaded the saved values (about 1.8 s after boot). Until then a
 * value read is the default and a save would fail, so the shell refuses param commands. */
bool sm_params_ready(void);

const struct sm_param *sm_param_find(const char *name);

/* Parses and range-checks a value without setting it. Returns 0, -EINVAL or -ERANGE. */
int sm_param_parse(const struct sm_param *p, const char *text, float *v);

/* Parses and sets a value (range-checked). Returns 0, -EINVAL (bad text) or -ERANGE. */
int sm_param_set_str(const struct sm_param *p, const char *text);

/* Sets from a number (range-checked, rounded for int and bool). */
int sm_param_set(const struct sm_param *p, float v);
float sm_param_get(const struct sm_param *p);

/* Saves every parameter that differs from its default; forgets the rest. */
int sm_params_save(void);

/* Back to defaults in RAM (call sm_params_save to make it stick). NULL for all. */
void sm_params_reset(const struct sm_param *p);

/* Called after any change with the parameter's name. detector.c uses it to re-run init(); weak
 * no-op where there are no detectors. */
void sm_detector_param_changed(const char *name);

#endif
